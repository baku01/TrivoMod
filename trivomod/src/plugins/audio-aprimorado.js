// Áudio aprimorado para chamadas de voz do Trivo.
// Resolve os principais problemas identificados na cadeia de áudio do cliente:
//   1. Saída remota sem esmagamento (remove compressor 12:1 + ganho +9 dB + limiter 20:1);
//   2. AudioContext em 48 kHz nativos (evita reamostragem linear sem anti-aliasing no RNNoise);
//   3. Portão de voz com detector de voz mais tolerante e a mesma antecipação do Trivo (40 ms).
//      Medido com o worklet real: com 20 ms, só ~35% de consoantes surdas iniciais ("s", "f")
//      passavam; com 40 ms, ~50%, e as vogais continuam passando inteiras;
//   4. Controle automático de ganho (AGC) opcional para microfones baixos;
//   5. Desativa DTX na publicação de voz (reduz cortes no início de frases, útil em E2EE);
//   6. Opção de saída nativa (<audio>) sem webAudioMix para melhorar cancelamento de eco (AEC);
//   7. Proteção de CPU do RNNoise: se o supressor passar do orçamento da thread de áudio, ele
//      entra em passagem direta até o fim da captura, em vez de picotar a voz.
// Além disso, enquanto ativo, o processo principal desliga o backgroundThrottling da janela.
(() => {
  const TRIVO_MAKEUP_GAIN = Math.pow(10, 9 / 20); // 2.8183829312644537 (+9 dB)
  const INV_TRIVO_GAIN = 1 / TRIVO_MAKEUP_GAIN;

  let active = false;
  let pluginRef = null;
  let origAudioContext = null;
  let origAudioWorkletNode = null;
  let origSetWebAudioPlugins = null;
  let origPublishTrack = null;
  let origRoomConnect = null;
  let patchedRemoteProto = null;
  let patchedLocalProto = null;
  let patchedRoomProto = null;
  let captureRegistry = null;
  let origProcessor = null;
  let wrappedProcessor = null;
  let hooksInstalled = false;
  let modulesPending = false;

  const opt = (key, fallback) => {
    if (!pluginRef || !pluginRef.options) return fallback;
    const v = pluginRef.options.get(key);
    return v === undefined ? fallback : v;
  };

  // Detecta o trio [compressor(-24 dB, 12:1), gain(+9 dB), limiter(-6 dB, 20:1)] instalado por voz remota.
  function isTrivoVoiceChain(nodes) {
    if (!Array.isArray(nodes) || nodes.length !== 3) return false;
    const [c1, gain, c2] = nodes;
    if (!c1 || !gain || !c2) return false;
    if (!c1.threshold || !c1.ratio || !gain.gain || !c2.threshold || !c2.ratio) return false;
    const c1Match = Math.abs(c1.threshold.value - -24) < 0.5 && Math.abs(c1.ratio.value - 12) < 0.5;
    const c2Match = Math.abs(c2.threshold.value - -6) < 0.5 && Math.abs(c2.ratio.value - 20) < 0.5;
    return c1Match && c2Match;
  }

  // Detecta o par [gain, limiter] do áudio de tela compartilhada.
  function isTrivoScreenChain(nodes) {
    if (!Array.isArray(nodes) || nodes.length !== 2) return false;
    const [gain, lim] = nodes;
    return Boolean(gain && gain.gain && lim && lim.threshold && lim.ratio);
  }

  // Quando webAudioMix é desativado (AEC nativo), encaminha o ajuste de volume do Trivo ao <audio>.
  function bridgeNativeVolume(track, gainNode, divideByMakeup) {
    if (!gainNode || !gainNode.gain || typeof track.setVolume !== "function") return;
    const param = gainNode.gain;
    if (param.__tmVolumeBridged) return;
    param.__tmVolumeBridged = true;
    let current = Number(param.value) || 1;
    const forward = (raw) => {
      const vol = divideByMakeup ? raw / TRIVO_MAKEUP_GAIN : raw;
      const clamped = Math.min(1, Math.max(0, Number.isFinite(vol) ? vol : 1));
      try {
        track.setVolume(clamped);
      } catch {
        /* trilha já destacada */
      }
    };
    const origSetTarget = typeof param.setTargetAtTime === "function" ? param.setTargetAtTime.bind(param) : null;
    if (origSetTarget) {
      param.setTargetAtTime = function (target, startTime, timeConstant) {
        current = target;
        forward(target);
        return origSetTarget(target, startTime, timeConstant);
      };
    }
    try {
      const protoDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(param), "value");
      Object.defineProperty(param, "value", {
        configurable: true,
        get() {
          return protoDesc && protoDesc.get ? protoDesc.get.call(this) : current;
        },
        set(v) {
          current = v;
          if (protoDesc && protoDesc.set) protoDesc.set.call(this, v);
          forward(v);
        },
      });
    } catch {
      /* AudioParam não configurável neste ambiente */
    }
    forward(current);
  }

  function buildImprovedVoiceNodes(ctx, gainNode) {
    const comp = ctx.createGain();
    comp.gain.value = INV_TRIVO_GAIN; // cancela exatamente o +9 dB fixo do Trivo em qualquer volume (0..200%)
    // Ganho unitário transparente + limiter suave só para evitar clipping em gritos/picos
    // (até 200% de volume por pessoa). Fala normal passa sem compressão.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 6;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.08;
    return [gainNode, comp, limiter];
  }

  // ------------------------------------------------------------ proteção de CPU do RNNoise
  // O worklet "supressor-de-ruido" do Trivo roda o RNNoise (WASM) na própria thread de áudio e
  // publica {tipo:"supressor-custo", mediaMs, p95Ms} a cada 200 quadros de 10 ms (~2 s). Cada
  // quadro do modelo cabe inteiro num process() de 128 amostras (~2,67 ms a 48 kHz): passar disso
  // com frequência estoura o prazo de renderização e a voz sai picotada. Quando o custo fica alto
  // por relatórios seguidos, manda {tipo:"ativo", ativo:false} (passagem direta que o worklet já
  // suporta). Não religa sozinho: a passagem direta muda a latência do caminho em ~30 ms e as filas
  // guardam amostras antigas, então religar no meio da chamada daria um estalo. Vale até a próxima
  // captura ou até a pessoa religar a redução avançada: nos dois casos o Trivo recria o nó, que
  // nasce ativo e com uma guarda nova.
  const CPU_P95_LIMITE_MS = 2;
  const CPU_MEDIA_LIMITE_MS = 1;
  const CPU_RELATORIOS_SEGUIDOS = 2;

  function attachCpuGuard(node) {
    const port = node && node.port;
    if (!port || typeof port.addEventListener !== "function" || typeof port.postMessage !== "function") return;
    let seguidos = 0;
    const onMessage = (evento) => {
      const msg = evento && evento.data;
      if (!msg || msg.tipo !== "supressor-custo") return;
      if (!active || !opt("protecaoCpu", true)) {
        seguidos = 0;
        return;
      }
      const p95 = Number(msg.p95Ms);
      const media = Number(msg.mediaMs);
      const caro = (Number.isFinite(p95) && p95 > CPU_P95_LIMITE_MS) || (Number.isFinite(media) && media > CPU_MEDIA_LIMITE_MS);
      seguidos = caro ? seguidos + 1 : 0;
      if (seguidos < CPU_RELATORIOS_SEGUIDOS) return;
      seguidos = 0;
      try {
        port.postMessage({ tipo: "ativo", ativo: false });
      } catch {
        return; // nó já encerrado
      }
      node.__tmCpuFallback = { p95Ms: p95, mediaMs: media };
      console.warn(`[TrivoMod] Redução de ruído avançada pausada: custo alto na thread de áudio (p95 ${p95.toFixed(2)} ms, média ${media.toFixed(2)} ms).`);
      const tm = window.TrivoMod;
      if (tm && typeof tm.toast === "function") {
        try {
          tm.toast("Redução de ruído avançada pausada nesta chamada: o processador não deu conta e a voz começaria a falhar.", { tipo: "info", duracao: 7000 });
        } catch {
          /* aviso é melhor esforço */
        }
      }
    };
    port.addEventListener("message", onMessage);
    // addEventListener (ao contrário de onmessage) não liga a entrega sozinho.
    if (typeof port.start === "function") port.start();
  }

  // ------------------------------------------------------------ hooks Web Audio
  function installWebAudioHooks() {
    if (typeof window.AudioContext === "function" && !origAudioContext) {
      origAudioContext = window.AudioContext;
      const PatchedAudioContext = function AudioContext(options) {
        if (active && opt("sampleRate48k", true)) {
          const opts = options && typeof options === "object" ? options : {};
          if (!("sampleRate" in opts) || opts.sampleRate == null) {
            try {
              return new origAudioContext({ ...opts, sampleRate: 48000 });
            } catch {
              /* driver recusou 48 kHz: cai no padrão */
            }
          }
        }
        return options === undefined ? new origAudioContext() : new origAudioContext(options);
      };
      PatchedAudioContext.prototype = origAudioContext.prototype;
      Object.setPrototypeOf(PatchedAudioContext, origAudioContext);
      window.AudioContext = PatchedAudioContext;
    }

    if (typeof window.AudioWorkletNode === "function" && !origAudioWorkletNode) {
      origAudioWorkletNode = window.AudioWorkletNode;
      const PatchedAudioWorkletNode = function AudioWorkletNode(context, name, options) {
        if (
          active &&
          name === "portao-de-voz" &&
          options &&
          options.processorOptions &&
          options.processorOptions.afinacao &&
          options.processorOptions.modo !== "so-medindo"
        ) {
          // Afinação única e automática (sem preset para escolher). Medida com o worklet real do
          // Trivo contra o padrão dele e contra um portão só por nível, com ruído de fundo largo e
          // com zumbido tonal de 100 Hz: é a única que ganha nas consoantes iniciais sem deixar
          // vazar mais ruído. O limiar continua automático, aprendido pelo próprio worklet.
          const tuned = {
            ...options.processorOptions.afinacao,
            // Mantém os 40 ms do Trivo: a antecipação é o que devolve a consoante surda que vem
            // antes da vogal (o detector de voz só confirma na vogal).
            antecipacaoMs: 40,
            confirmacoesParaAbrir: 2,
            voicingMinCorrelation: 0.3,
            voicingMinWindows: 2,
            voicingPitchTolerance: 0.18,
            voicingMemoryMs: 1200,
          };
          const patchedOptions = {
            ...options,
            processorOptions: { ...options.processorOptions, afinacao: tuned },
          };
          return new origAudioWorkletNode(context, name, patchedOptions);
        }
        const node = options === undefined ? new origAudioWorkletNode(context, name) : new origAudioWorkletNode(context, name, options);
        if (active && name === "supressor-de-ruido") attachCpuGuard(node);
        return node;
      };
      PatchedAudioWorkletNode.prototype = origAudioWorkletNode.prototype;
      Object.setPrototypeOf(PatchedAudioWorkletNode, origAudioWorkletNode);
      window.AudioWorkletNode = PatchedAudioWorkletNode;
    }
  }

  function uninstallWebAudioHooks() {
    if (origAudioContext) {
      window.AudioContext = origAudioContext;
      origAudioContext = null;
    }
    if (origAudioWorkletNode) {
      window.AudioWorkletNode = origAudioWorkletNode;
      origAudioWorkletNode = null;
    }
  }

  // ------------------------------------------------------------ hooks Turbopack (LiveKit + captura)
  function findExport(mod, predicate) {
    if (!mod || (typeof mod !== "object" && typeof mod !== "function")) return null;
    for (const key of Object.keys(mod)) {
      let val;
      try {
        val = mod[key];
      } catch {
        continue;
      }
      if (predicate(val, key)) return { key, val };
    }
    return null;
  }

  function patchLiveKitModule(lk) {
    if (!lk || hooksInstalled) return;
    const remote = findExport(lk, (v) => typeof v === "function" && v.prototype && typeof v.prototype.setWebAudioPlugins === "function" && typeof v.prototype.connectWebAudio === "function");
    const local = findExport(lk, (v) => typeof v === "function" && v.prototype && typeof v.prototype.publishTrack === "function" && typeof v.prototype.setMicrophoneEnabled === "function");
    const room = findExport(lk, (v) => typeof v === "function" && v.prototype && typeof v.prototype.connect === "function" && typeof v.prototype.switchActiveDevice === "function");
    if (!remote && !local && !room) return;
    hooksInstalled = true;

    if (remote) {
      patchedRemoteProto = remote.val.prototype;
      origSetWebAudioPlugins = patchedRemoteProto.setWebAudioPlugins;
      patchedRemoteProto.setWebAudioPlugins = function (nodes) {
        if (!active) return origSetWebAudioPlugins.call(this, nodes);
        // Saída nativa (webAudioMix desligado): não há audioContext na trilha remota; encaminha o volume ao <audio>.
        if (!this.audioContext) {
          if (isTrivoVoiceChain(nodes)) bridgeNativeVolume(this, nodes[1], true);
          else if (isTrivoScreenChain(nodes)) bridgeNativeVolume(this, nodes[0], false);
          return origSetWebAudioPlugins.call(this, []);
        }
        if (isTrivoVoiceChain(nodes)) {
          try {
            const improved = buildImprovedVoiceNodes(this.audioContext, nodes[1]);
            return origSetWebAudioPlugins.call(this, improved);
          } catch {
            /* cai na cadeia original */
          }
        }
        return origSetWebAudioPlugins.call(this, nodes);
      };
    }

    if (local) {
      patchedLocalProto = local.val.prototype;
      origPublishTrack = patchedLocalProto.publishTrack;
      patchedLocalProto.publishTrack = function (track, options) {
        if (active && opt("desativarDtx", true)) {
          const isAudio = track && (track.kind === "audio" || (track.mediaStreamTrack && track.mediaStreamTrack.kind === "audio"));
          const isScreen = options && (options.source === "screen_share_audio" || options.source === 4);
          if (isAudio && !isScreen) {
            return origPublishTrack.call(this, track, { ...(options || {}), dtx: false });
          }
        }
        return origPublishTrack.call(this, track, options);
      };
    }

    if (room) {
      patchedRoomProto = room.val.prototype;
      origRoomConnect = patchedRoomProto.connect;
      patchedRoomProto.connect = function () {
        if (active && this.options) {
          syncCaptureAgc();
          if (opt("desativarDtx", true) && this.options.publishDefaults) {
            this.options.publishDefaults = { ...this.options.publishDefaults, dtx: false };
          }
          if (opt("aecNativo", false) && this.options.webAudioMix) {
            this.options.webAudioMix = false;
          }
        }
        return origRoomConnect.apply(this, arguments);
      };
    }
  }

  function syncCaptureAgc() {
    if (!captureRegistry) return;
    const { getProc, setProc } = captureRegistry;
    const current = getProc();
    if (!active || !opt("ganhoAutomatico", true)) {
      if (wrappedProcessor && current === wrappedProcessor && origProcessor) {
        setProc(origProcessor);
      }
      wrappedProcessor = null;
      origProcessor = null;
      return;
    }
    if (!current || typeof current.restricoesDeCaptura !== "function") return;
    if (wrappedProcessor && current === wrappedProcessor) return;
    origProcessor = current;
    wrappedProcessor = Object.create(origProcessor);
    wrappedProcessor.restricoesDeCaptura = function (prefs) {
      const base = origProcessor.restricoesDeCaptura(prefs);
      return active && opt("ganhoAutomatico", true) ? { ...base, autoGainControl: true } : base;
    };
    setProc(wrappedProcessor);
  }

  function patchCaptureRegistry(mod) {
    if (!mod || captureRegistry) return;
    let getProc = null;
    let setProc = null;
    for (const key of Object.keys(mod)) {
      let val;
      try {
        val = mod[key];
      } catch {
        continue;
      }
      if (typeof val !== "function" || val.length !== 0) continue;
      try {
        const probe = val();
        if (probe && typeof probe === "object" && typeof probe.restricoesDeCaptura === "function") {
          getProc = val;
          break;
        }
      } catch {
        /* ignora */
      }
    }
    if (!getProc) return;
    const orig = getProc();
    const sentinel = Object.create(orig);
    for (const key of Object.keys(mod)) {
      let val;
      try {
        val = mod[key];
      } catch {
        continue;
      }
      if (typeof val !== "function" || val === getProc || val.length !== 1) continue;
      try {
        val(sentinel);
        const matched = getProc() === sentinel;
        if (matched) {
          val(orig);
          setProc = val;
          break;
        }
      } catch {
        /* ignora */
      }
    }
    if (!setProc) return;
    captureRegistry = { getProc, setProc };
    syncCaptureAgc();
  }

  function attachModuleHooks() {
    const mods = window.TrivoMod && window.TrivoMod.modules;
    if (!mods || modulesPending) return;
    modulesPending = true;

    const lkFilter = (ex) => Boolean(findExport(ex, (v) => typeof v === "function" && v.prototype && typeof v.prototype.setWebAudioPlugins === "function" && typeof v.prototype.connectWebAudio === "function"));
    const existingLk = mods.find(lkFilter);
    if (existingLk) patchLiveKitModule(existingLk);
    else mods.waitFor(lkFilter).then((m) => { if (active) patchLiveKitModule(m); }).catch(() => {});

    // Módulo de processamento de captura (registra restricoesDeCaptura e modos de redução de ruído).
    const capFilter = mods.filters.byCode("restricoesDeCaptura", "ganhoAutomatico", "Redução de ruído avançada");
    const existingCap = mods.find(capFilter);
    if (existingCap) patchCaptureRegistry(existingCap);
    else mods.waitFor(capFilter).then((m) => { if (active) patchCaptureRegistry(m); }).catch(() => {});

    // Observa quando o chunk da chamada (que registra o processador web-rnnoise) é avaliado,
    // para re-embrulhar o processador de forma síncrona antes de conectar na sala.
    const voiceSessionFilter = mods.filters.byProps("conectarChamadaLiveKit");
    if (mods.find(voiceSessionFilter)) syncCaptureAgc();
    else mods.waitFor(voiceSessionFilter, () => { if (active) syncCaptureAgc(); }).catch(() => {});
  }

  function uninstallModuleHooks() {
    if (patchedRemoteProto && origSetWebAudioPlugins) {
      patchedRemoteProto.setWebAudioPlugins = origSetWebAudioPlugins;
    }
    if (patchedLocalProto && origPublishTrack) {
      patchedLocalProto.publishTrack = origPublishTrack;
    }
    if (patchedRoomProto && origRoomConnect) {
      patchedRoomProto.connect = origRoomConnect;
    }
    patchedRemoteProto = null;
    patchedLocalProto = null;
    patchedRoomProto = null;
    origSetWebAudioPlugins = null;
    origPublishTrack = null;
    origRoomConnect = null;
    hooksInstalled = false;
    modulesPending = false;
    syncCaptureAgc();
  }

  TrivoMod.definePlugin({
    name: "Áudio aprimorado",
    description: "Melhora a qualidade de voz nas chamadas: saída limpa (sem +9 dB / compressão 12:1), 48 kHz nativo, portão que corta menos o início das falas, AGC opcional, DTX desligado e proteção de CPU da redução de ruído.",
    authors: ["TrivoMod"],
    defaultEnabled: false,
    settings: {
      // Saída e portão de voz não têm preset: a afinação é automática (ver os hooks acima).
      // Quem quiser o comportamento original do Trivo desliga o plugin.
      sampleRate48k: { type: "boolean", label: "Forçar 48 kHz (evita reamostragem no RNNoise)", default: true },
      ganhoAutomatico: { type: "boolean", label: "Ganho automático do microfone (AGC)", default: true },
      desativarDtx: { type: "boolean", label: "Desativar DTX (menos cortes no início das falas)", default: true },
      aecNativo: { type: "boolean", label: "Saída nativa <audio> (melhora eco/AEC com caixas)", default: false },
      protecaoCpu: { type: "boolean", label: "Pausar a redução de ruído avançada se o processador não der conta", default: true },
    },
    start() {
      pluginRef = this;
      active = true;
      installWebAudioHooks();
      attachModuleHooks();
      syncCaptureAgc();
    },
    stop() {
      active = false;
      uninstallWebAudioHooks();
      uninstallModuleHooks();
      pluginRef = null;
    },
    settingsChanged(key) {
      if (key === "ganhoAutomatico") syncCaptureAgc();
    },
  });
})();
