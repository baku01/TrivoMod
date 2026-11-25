"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const pluginSrc = fs.readFileSync(path.join(root, "src", "plugins", "audio-aprimorado.js"), "utf8");
const turbopackSrc = fs.readFileSync(path.join(root, "src", "renderer", "turbopack.js"), "utf8");

function makeFakeContext() {
  const createdGains = [];
  const createdComps = [];
  return {
    createdGains,
    createdComps,
    createGain() {
      const node = { type: "gain", gain: { value: 1, setTargetAtTime(v) { this.value = v; } } };
      createdGains.push(node);
      return node;
    },
    createDynamicsCompressor() {
      const node = {
        type: "compressor",
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 1 },
        attack: { value: 0 },
        release: { value: 0 },
      };
      createdComps.push(node);
      return node;
    },
  };
}

function loadAudioPlugin(overrides = {}) {
  const audioCtxCalls = [];
  const workletCalls = [];

  function BaseAudioContext(opts) {
    audioCtxCalls.push(opts);
    if (overrides.fail48k && opts && opts.sampleRate === 48000) throw new Error("48k unsupported");
    this.opts = opts;
  }
  function BaseAudioWorkletNode(ctx, name, opts) {
    workletCalls.push({ ctx, name, opts });
    this.ctx = ctx;
    this.name = name;
    this.opts = opts;
    if (overrides.withPort) {
      const listeners = [];
      this.port = {
        sent: [],
        started: 0,
        addEventListener(type, fn) {
          if (type === "message") listeners.push(fn);
        },
        start() {
          this.started += 1;
        },
        postMessage(msg) {
          this.sent.push(msg);
        },
        emit(data) {
          for (const fn of listeners) fn({ data });
        },
      };
    }
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    AudioContext: BaseAudioContext,
    AudioWorkletNode: BaseAudioWorkletNode,
  };
  const ctx = vm.createContext(sandbox);
  const win = vm.runInContext("globalThis", ctx);
  win.window = win;

  // Instala hook real do Turbopack no mesmo contexto.
  vm.runInContext(turbopackSrc, ctx, { filename: "turbopack.js" });

  let def = null;
  const store = {};
  win.TrivoMod = {
    get modules() {
      return win.__trivomodModules;
    },
    definePlugin(d) {
      def = d;
      d.options = {
        get(k) {
          return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d.settings[k] && d.settings[k].default;
        },
        set(k, v) {
          store[k] = v;
          if (typeof d.settingsChanged === "function") d.settingsChanged(k, v);
        },
      };
      return d;
    },
  };

  vm.runInContext(pluginSrc, ctx, { filename: "audio-aprimorado.js" });
  return {
    win,
    ctx,
    def,
    store,
    BaseAudioContext,
    BaseAudioWorkletNode,
    audioCtxCalls,
    workletCalls,
    setOption(k, v) {
      def.options.set(k, v);
    },
  };
}

function registerSyntheticTrivoModules(ctx) {
  // Registra um registry Turbopack mínimo que avalia factories imediatamente.
  const evaluated = new Map();
  ctx.TURBOPACK = {
    push(chunk) {
      const ids = [];
      for (let i = 1; i < chunk.length; i++) {
        const v = chunk[i];
        if (typeof v === "function") {
          for (const id of ids) {
            const mod = { id, exports: {} };
            const helper = {
              m: mod,
              e: mod.exports,
              s(list) {
                for (let j = 0; j < list.length; j += 3) {
                  mod.exports[list[j]] = typeof list[j + 2] === "function" && list[j + 1] !== 0 ? list[j + 2]() : list[j + 2];
                }
              },
            };
            v(helper, mod, mod.exports);
            evaluated.set(id, mod.exports);
          }
          ids.length = 0;
        } else if (typeof v === "number") {
          ids.push(v);
        }
      }
    },
  };

  // Módulo 802025 (registro do processador de captura)
  let capMod;
  ctx.TURBOPACK.push([
    "cap.js",
    802025,
    (e) => {
      let n = {
        nome: "web",
        modos: ["desligado", "navegador"],
        restricoesDeCaptura: (p) => ({
          echoCancellation: p.cancelamentoDeEco,
          noiseSuppression: p.modo === "navegador",
          autoGainControl: p.ganhoAutomatico,
          voiceIsolation: p.modo === "navegador",
        }),
      };
      const rotulo = "Redução de ruído avançada";
      void rotulo;
      e.s(["U", 0, function () { return n; }, "F", 0, function (x) { n = x; }]);
      capMod = e.m.exports;
    },
  ]);

  // Módulo LiveKit (RemoteAudioTrack, LocalParticipant, Room)
  const calls = { setPlugins: [], publish: [], connect: [], setVolume: [] };
  class FakeRemoteAudioTrack {
    constructor(audioContext) {
      this.audioContext = audioContext;
      this.webAudioPluginNodes = [];
    }
    connectWebAudio() {}
    setWebAudioPlugins(nodes) {
      this.webAudioPluginNodes = nodes;
      calls.setPlugins.push(nodes);
    }
    setVolume(v) {
      calls.setVolume.push(v);
    }
  }
  class FakeLocalParticipant {
    setMicrophoneEnabled() {}
    publishTrack(track, options) {
      calls.publish.push({ track, options });
      return { track, options };
    }
  }
  class FakeRoom {
    constructor(options) {
      this.options = options;
    }
    switchActiveDevice() {}
    connect(url, token) {
      calls.connect.push({ url, token, options: this.options });
    }
  }

  ctx.TURBOPACK.push([
    "livekit.js",
    104759,
    (e) => {
      e.s(["E", 0, FakeRemoteAudioTrack, "L", 0, FakeLocalParticipant, "_", 0, FakeRoom]);
    },
  ]);

  return { evaluated, capMod, FakeRemoteAudioTrack, FakeLocalParticipant, FakeRoom, calls };
}

test("audio-aprimorado: nasce desligado (modo padrão) e restaura tudo ao parar", () => {
  const env = loadAudioPlugin();
  assert.equal(env.def.name, "Áudio aprimorado");
  assert.equal(env.def.defaultEnabled, false);
  assert.equal(env.win.AudioContext, env.BaseAudioContext);
  assert.equal(env.win.AudioWorkletNode, env.BaseAudioWorkletNode);

  env.def.start();
  assert.notEqual(env.win.AudioContext, env.BaseAudioContext);
  assert.notEqual(env.win.AudioWorkletNode, env.BaseAudioWorkletNode);

  env.def.stop();
  assert.equal(env.win.AudioContext, env.BaseAudioContext);
  assert.equal(env.win.AudioWorkletNode, env.BaseAudioWorkletNode);
});

test("audio-aprimorado: força AudioContext em 48 kHz com fallback se o driver recusar", () => {
  const env = loadAudioPlugin();
  env.def.start();

  new env.win.AudioContext({ latencyHint: "interactive" });
  assert.deepEqual({ ...env.audioCtxCalls[0] }, { latencyHint: "interactive", sampleRate: 48000 });

  new env.win.AudioContext({ sampleRate: 44100 });
  assert.deepEqual({ ...env.audioCtxCalls[1] }, { sampleRate: 44100 });

  env.setOption("sampleRate48k", false);
  new env.win.AudioContext({ latencyHint: "interactive" });
  assert.deepEqual({ ...env.audioCtxCalls[2] }, { latencyHint: "interactive" });
  env.def.stop();

  const fb = loadAudioPlugin({ fail48k: true });
  fb.def.start();
  const c = new fb.win.AudioContext({ latencyHint: "interactive" });
  assert.deepEqual({ ...c.opts }, { latencyHint: "interactive" });
  fb.def.stop();
});

test("audio-aprimorado: afina portao-de-voz sem mutar a constante original nem tocar em so-medindo", () => {
  const env = loadAudioPlugin();
  env.def.start();

  const origTuning = {
    antecipacaoMs: 40,
    confirmacoesParaAbrir: 3,
    retencaoMs: 300,
    voicingRateHz: 8000,
    voicingMinCorrelation: 0.45,
    voicingMinWindows: 3,
    voicingPitchTolerance: 0.1,
    voicingMemoryMs: 600,
  };

  // Afinação automática (única)
  new env.win.AudioWorkletNode({}, "portao-de-voz", {
    processorOptions: { afinacao: origTuning, manualDb: null, modo: "cortando" },
  });
  assert.equal(origTuning.antecipacaoMs, 40, "não deve mutar o objeto original do Trivo");
  const eq = env.workletCalls[0].opts.processorOptions.afinacao;
  assert.equal(eq.antecipacaoMs, 40, "antecipação do Trivo: com 20 ms consoantes surdas iniciais eram cortadas");
  assert.equal(eq.confirmacoesParaAbrir, 2);
  assert.equal(eq.voicingMinCorrelation, 0.3);
  assert.equal(eq.voicingMinWindows, 2);
  assert.equal(eq.voicingPitchTolerance, 0.18);
  assert.equal(eq.voicingMemoryMs, 1200);
  assert.equal(eq.retencaoMs, 300, "retenção fica a do Trivo (400 ms não mostrou ganho medido)");
  assert.equal(eq.voicingRateHz, 8000);

  // Preset salvo por versões antigas ("classico"/"padrao") é ignorado: a afinação é automática
  assert.equal(env.def.settings.portao, undefined, "não há mais preset de portão para escolher");
  env.setOption("portao", "classico");
  new env.win.AudioWorkletNode({}, "portao-de-voz", {
    processorOptions: { afinacao: origTuning, manualDb: null, modo: "cortando" },
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(env.workletCalls[1].opts.processorOptions.afinacao)),
    JSON.parse(JSON.stringify(eq)),
  );

  // Medidores remotos ("so-medindo") não são alterados
  new env.win.AudioWorkletNode({}, "portao-de-voz", {
    processorOptions: { afinacao: origTuning, manualDb: null, modo: "so-medindo" },
  });
  assert.equal(env.workletCalls[2].opts.processorOptions.afinacao.antecipacaoMs, 40);

  env.def.stop();
});

test("audio-aprimorado: substitui cadeia +9 dB / 12:1 / 20:1 na recepção e preserva tela compartilhada", () => {
  const env = loadAudioPlugin();
  const { FakeRemoteAudioTrack, calls } = registerSyntheticTrivoModules(env.ctx);
  env.def.start();

  const fakeCtx = makeFakeContext();
  const track = new FakeRemoteAudioTrack(fakeCtx);
  const trivoVoiceNodes = () => {
    const c1 = fakeCtx.createDynamicsCompressor();
    c1.threshold.value = -24;
    c1.ratio.value = 12;
    const g = fakeCtx.createGain();
    g.gain.value = Math.pow(10, 9 / 20);
    const c2 = fakeCtx.createDynamicsCompressor();
    c2.threshold.value = -6;
    c2.ratio.value = 20;
    return [c1, g, c2];
  };

  // Modo suave (padrão): gain original + compensação -9 dB + limiter leve (-1.5 dB, 6:1)
  const nodes1 = trivoVoiceNodes();
  track.setWebAudioPlugins(nodes1);
  const applied1 = calls.setPlugins.at(-1);
  assert.equal(applied1.length, 3);
  assert.equal(applied1[0], nodes1[1]);
  assert.ok(Math.abs(applied1[0].gain.value * applied1[1].gain.value - 1) < 1e-6, "ganho líquido unitário (0 dB)");
  assert.equal(applied1[2].threshold.value, -1.5);
  assert.equal(applied1[2].knee.value, 6);
  assert.equal(applied1[2].ratio.value, 6);
  assert.equal(applied1[2].attack.value, 0.003);
  assert.equal(applied1[2].release.value, 0.08);

  // Preset de saída salvo por versões antigas ("limpa"/"padrao") é ignorado
  assert.equal(env.def.settings.saida, undefined, "não há mais preset de saída para escolher");
  for (const antigo of ["limpa", "padrao"]) {
    env.setOption("saida", antigo);
    track.setWebAudioPlugins(trivoVoiceNodes());
    assert.equal(calls.setPlugins.at(-1).length, 3, `saida=${antigo} salvo não muda a cadeia`);
  }

  // Tela compartilhada (2 nós) fica intacta
  const screenNodes = [fakeCtx.createGain(), fakeCtx.createDynamicsCompressor()];
  track.setWebAudioPlugins(screenNodes);
  assert.deepEqual(calls.setPlugins.at(-1), screenNodes);

  // Plugin parado devolve a cadeia original do Trivo
  env.def.stop();
  const nodes3 = trivoVoiceNodes();
  track.setWebAudioPlugins(nodes3);
  assert.deepEqual(calls.setPlugins.at(-1), nodes3);
});

test("audio-aprimorado: desativa DTX, ativa AGC com re-wrap do web-rnnoise e suporta saída nativa AEC", () => {
  const env = loadAudioPlugin();
  const { capMod, FakeRemoteAudioTrack, FakeLocalParticipant, FakeRoom, calls } = registerSyntheticTrivoModules(env.ctx);
  env.def.start();

  // AGC ativo no processador web inicial
  const cWeb = capMod.U().restricoesDeCaptura({ cancelamentoDeEco: true, modo: "navegador", ganhoAutomatico: false });
  assert.equal(cWeb.autoGainControl, true);

  // Simula o chunk da chamada trocando para web-rnnoise (como 1tlvxbp3zcq3j.js faz)
  env.ctx.TURBOPACK.push([
    "voice.js",
    635882,
    (e) => {
      capMod.F({
        nome: "web-rnnoise",
        modos: ["desligado", "navegador", "avancado"],
        restricoesDeCaptura: (p) => ({
          echoCancellation: p.cancelamentoDeEco,
          noiseSuppression: p.modo === "navegador",
          autoGainControl: p.ganhoAutomatico,
          voiceIsolation: p.modo === "navegador",
        }),
      });
      e.s(["conectarChamadaLiveKit", 0, () => {}]);
    },
  ]);
  const cRn = capMod.U().restricoesDeCaptura({ cancelamentoDeEco: true, modo: "avancado", ganhoAutomatico: false });
  assert.equal(cRn.autoGainControl, true);
  assert.equal(cRn.noiseSuppression, false);

  // DTX desativado na publicação de microfone, preservado em vídeo/tela
  const lp = new FakeLocalParticipant();
  lp.publishTrack({ kind: "audio" }, { source: "microphone", dtx: true });
  assert.equal(calls.publish[0].options.dtx, false);
  lp.publishTrack({ kind: "audio" }, { source: "screen_share_audio", dtx: false });
  assert.equal(calls.publish[1].options.source, "screen_share_audio");

  // Room.connect desativa DTX e, quando aecNativo=true, desliga webAudioMix + encaminha volume
  env.setOption("aecNativo", true);
  const room = new FakeRoom({ webAudioMix: { audioContext: {} }, publishDefaults: { dtx: true } });
  room.connect("wss://lk.example", "tok");
  assert.equal(room.options.publishDefaults.dtx, false);
  assert.equal(room.options.webAudioMix, false);

  // Trilha remota sem audioContext (AEC nativo) encaminha ganho do Trivo para track.setVolume
  const fakeCtx = makeFakeContext();
  const nativeTrack = new FakeRemoteAudioTrack(undefined);
  const c1 = fakeCtx.createDynamicsCompressor();
  c1.threshold.value = -24;
  c1.ratio.value = 12;
  const g = fakeCtx.createGain();
  const makeup = Math.pow(10, 9 / 20);
  g.gain.value = makeup;
  const c2 = fakeCtx.createDynamicsCompressor();
  c2.threshold.value = -6;
  c2.ratio.value = 20;
  nativeTrack.setWebAudioPlugins([c1, g, c2]);
  assert.equal(calls.setVolume.at(-1), 1);
  g.gain.value = makeup * 0.5;
  assert.ok(Math.abs(calls.setVolume.at(-1) - 0.5) < 1e-6);

  // Ao desligar o plugin, AGC volta ao padrão false do Trivo
  env.def.stop();
  const cAfter = capMod.U().restricoesDeCaptura({ cancelamentoDeEco: true, modo: "avancado", ganhoAutomatico: false });
  assert.equal(cAfter.autoGainControl, false);
});

test("aba TrivoMod: renderAbout inclui o switch de modo padrão / áudio aprimorado", () => {
  const rendererSrc = fs.readFileSync(path.join(root, "src", "renderer", "index.js"), "utf8");
  assert.match(rendererSrc, /function renderAudioSection\(\)/);
  assert.match(rendererSrc, /plugins\.get\("builtin:audio-aprimorado"\)/);
  assert.match(rendererSrc, /enabled \? "Aprimorado" : "Padrão"/);
  assert.match(rendererSrc, /\.\.\.renderAudioSection\(\)/);
});

function trivoVoiceNodes(fakeCtx, { c1Threshold = -24, c1Ratio = 12, c2Threshold = -6, c2Ratio = 20 } = {}) {
  const c1 = fakeCtx.createDynamicsCompressor();
  c1.threshold.value = c1Threshold;
  c1.ratio.value = c1Ratio;
  const g = fakeCtx.createGain();
  g.gain.value = Math.pow(10, 9 / 20);
  const c2 = fakeCtx.createDynamicsCompressor();
  c2.threshold.value = c2Threshold;
  c2.ratio.value = c2Ratio;
  return [c1, g, c2];
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("audio-aprimorado: stop devolve os protótipos do LiveKit e o processador de captura originais", () => {
  const env = loadAudioPlugin();
  const { capMod, FakeRemoteAudioTrack, FakeLocalParticipant, FakeRoom, calls } = registerSyntheticTrivoModules(env.ctx);
  const origSet = FakeRemoteAudioTrack.prototype.setWebAudioPlugins;
  const origPublish = FakeLocalParticipant.prototype.publishTrack;
  const origConnect = FakeRoom.prototype.connect;
  const origProc = capMod.U();

  env.def.start();
  assert.notEqual(FakeRemoteAudioTrack.prototype.setWebAudioPlugins, origSet);
  assert.notEqual(FakeLocalParticipant.prototype.publishTrack, origPublish);
  assert.notEqual(FakeRoom.prototype.connect, origConnect);
  assert.notEqual(capMod.U(), origProc);

  env.def.stop();
  assert.equal(FakeRemoteAudioTrack.prototype.setWebAudioPlugins, origSet);
  assert.equal(FakeLocalParticipant.prototype.publishTrack, origPublish);
  assert.equal(FakeRoom.prototype.connect, origConnect);
  assert.equal(capMod.U(), origProc);

  // Parado, nada é alterado
  const fakeCtx = makeFakeContext();
  const nodes = trivoVoiceNodes(fakeCtx);
  new FakeRemoteAudioTrack(fakeCtx).setWebAudioPlugins(nodes);
  assert.equal(calls.setPlugins.at(-1), nodes);
  new FakeLocalParticipant().publishTrack({ kind: "audio" }, { source: "microphone", dtx: true });
  assert.equal(calls.publish.at(-1).options.dtx, true);
  const room = new FakeRoom({ webAudioMix: true, publishDefaults: { dtx: true } });
  room.connect("wss://lk.example", "tok");
  assert.equal(room.options.publishDefaults.dtx, true);
  assert.equal(room.options.webAudioMix, true);
});

test("audio-aprimorado: religar depois de parar instala os hooks de novo", () => {
  const env = loadAudioPlugin();
  const { FakeRemoteAudioTrack, calls } = registerSyntheticTrivoModules(env.ctx);
  env.def.start();
  env.def.stop();
  env.def.start();

  const fakeCtx = makeFakeContext();
  new FakeRemoteAudioTrack(fakeCtx).setWebAudioPlugins(trivoVoiceNodes(fakeCtx));
  assert.equal(calls.setPlugins.at(-1).length, 3);
  assert.equal(calls.setPlugins.at(-1)[2].threshold.value, -1.5, "cadeia suave aplicada de novo");
  assert.notEqual(env.win.AudioContext, env.BaseAudioContext);
  env.def.stop();
});

test("audio-aprimorado: módulos carregados depois do start são interceptados", async () => {
  const env = loadAudioPlugin();
  env.def.start();
  const { capMod, FakeRemoteAudioTrack, FakeLocalParticipant, calls } = registerSyntheticTrivoModules(env.ctx);
  await tick();

  const fakeCtx = makeFakeContext();
  new FakeRemoteAudioTrack(fakeCtx).setWebAudioPlugins(trivoVoiceNodes(fakeCtx));
  assert.equal(calls.setPlugins.at(-1).length, 3);
  new FakeLocalParticipant().publishTrack({ kind: "audio" }, { source: "microphone", dtx: true });
  assert.equal(calls.publish.at(-1).options.dtx, false);
  const c = capMod.U().restricoesDeCaptura({ cancelamentoDeEco: true, modo: "navegador", ganhoAutomatico: false });
  assert.equal(c.autoGainControl, true);
  env.def.stop();
});

test("audio-aprimorado: módulos que chegam depois do stop não são alterados", async () => {
  const env = loadAudioPlugin();
  env.def.start();
  env.def.stop();
  const { capMod, FakeRemoteAudioTrack, FakeLocalParticipant } = registerSyntheticTrivoModules(env.ctx);
  const origSet = FakeRemoteAudioTrack.prototype.setWebAudioPlugins;
  const origPublish = FakeLocalParticipant.prototype.publishTrack;
  const origProc = capMod.U();
  await tick();

  assert.equal(FakeRemoteAudioTrack.prototype.setWebAudioPlugins, origSet);
  assert.equal(FakeLocalParticipant.prototype.publishTrack, origPublish);
  assert.equal(capMod.U(), origProc);
});

test("audio-aprimorado: cadeia de voz com parâmetros diferentes passa intacta", () => {
  const env = loadAudioPlugin();
  const { FakeRemoteAudioTrack, calls } = registerSyntheticTrivoModules(env.ctx);
  env.def.start();
  const fakeCtx = makeFakeContext();
  const track = new FakeRemoteAudioTrack(fakeCtx);

  for (const variant of [{ c1Threshold: -30 }, { c1Ratio: 4 }, { c2Threshold: -12 }, { c2Ratio: 10 }]) {
    const nodes = trivoVoiceNodes(fakeCtx, variant);
    track.setWebAudioPlugins(nodes);
    assert.equal(calls.setPlugins.at(-1), nodes, JSON.stringify(variant));
  }
  // Quantidade de nós diferente de 2 ou 3 também passa intacta
  const one = [fakeCtx.createGain()];
  track.setWebAudioPlugins(one);
  assert.equal(calls.setPlugins.at(-1), one);
  env.def.stop();
});

test("audio-aprimorado: saída nativa encaminha volume com limites e sem dividir na tela compartilhada", () => {
  const env = loadAudioPlugin();
  const { FakeRemoteAudioTrack, calls } = registerSyntheticTrivoModules(env.ctx);
  env.def.start();
  const fakeCtx = makeFakeContext();
  const makeup = Math.pow(10, 9 / 20);

  // Voz: remove a cadeia (lista vazia) e divide pelo +9 dB
  const voiceTrack = new FakeRemoteAudioTrack(undefined);
  const voice = trivoVoiceNodes(fakeCtx);
  voiceTrack.setWebAudioPlugins(voice);
  assert.equal(calls.setPlugins.at(-1).length, 0);
  assert.equal(calls.setVolume.at(-1), 1);

  voice[1].gain.value = makeup * 2; // volume 200% no Trivo
  assert.equal(calls.setVolume.at(-1), 1, "limita em 1");
  voice[1].gain.value = -1;
  assert.equal(calls.setVolume.at(-1), 0, "limita em 0");
  voice[1].gain.value = Number.NaN;
  assert.equal(calls.setVolume.at(-1), 1, "valor inválido volta a 1");
  voice[1].gain.setTargetAtTime(makeup * 0.25, 0, 0.01);
  assert.ok(Math.abs(calls.setVolume.at(-1) - 0.25) < 1e-6, "setTargetAtTime também encaminha");
  assert.ok(Math.abs(voice[1].gain.value - makeup * 0.25) < 1e-6, "setTargetAtTime original continua sendo chamado");

  // Reaplicar o mesmo nó não cria uma segunda ponte
  const before = calls.setVolume.length;
  voiceTrack.setWebAudioPlugins(voice);
  voice[1].gain.value = makeup * 0.5;
  assert.equal(calls.setVolume.length, before + 1);

  // Tela compartilhada: ganho vai direto, sem dividir pelo +9 dB
  const screenTrack = new FakeRemoteAudioTrack(undefined);
  const screenGain = fakeCtx.createGain();
  screenGain.gain.value = 0.6;
  screenTrack.setWebAudioPlugins([screenGain, fakeCtx.createDynamicsCompressor()]);
  assert.equal(calls.setPlugins.at(-1).length, 0);
  assert.ok(Math.abs(calls.setVolume.at(-1) - 0.6) < 1e-6);
  env.def.stop();
});

test("audio-aprimorado: DTX só muda em microfone e respeita a opção desligada", () => {
  const env = loadAudioPlugin();
  const { FakeLocalParticipant, FakeRoom, calls } = registerSyntheticTrivoModules(env.ctx);
  env.def.start();
  const lp = new FakeLocalParticipant();

  lp.publishTrack({ kind: "audio" });
  assert.equal(calls.publish.at(-1).options.dtx, false, "sem options cria { dtx: false }");
  lp.publishTrack({ mediaStreamTrack: { kind: "audio" } }, { source: "microphone" });
  assert.equal(calls.publish.at(-1).options.dtx, false, "detecta áudio pelo mediaStreamTrack");
  const videoOpts = { source: "camera", dtx: true };
  lp.publishTrack({ kind: "video" }, videoOpts);
  assert.equal(calls.publish.at(-1).options, videoOpts);
  const screenOpts = { source: 4, dtx: true };
  lp.publishTrack({ kind: "audio" }, screenOpts);
  assert.equal(calls.publish.at(-1).options, screenOpts, "source numérico 4 = áudio da tela");

  // aecNativo desligado (padrão) mantém webAudioMix; sem publishDefaults nada é criado
  const mix = { audioContext: {} };
  const room = new FakeRoom({ webAudioMix: mix });
  room.connect("wss://lk.example", "tok");
  assert.equal(room.options.webAudioMix, mix);
  assert.equal(room.options.publishDefaults, undefined);

  env.setOption("desativarDtx", false);
  const micOpts = { source: "microphone", dtx: true };
  lp.publishTrack({ kind: "audio" }, micOpts);
  assert.equal(calls.publish.at(-1).options, micOpts);
  const room2 = new FakeRoom({ publishDefaults: { dtx: true } });
  room2.connect("wss://lk.example", "tok");
  assert.equal(room2.options.publishDefaults.dtx, true);
  env.def.stop();
});

test("audio-aprimorado: alternar ganhoAutomatico desembrulha e reembrulha o processador", () => {
  const env = loadAudioPlugin();
  const { capMod } = registerSyntheticTrivoModules(env.ctx);
  const origProc = capMod.U();
  const prefs = { cancelamentoDeEco: true, modo: "navegador", ganhoAutomatico: false };
  env.def.start();
  assert.equal(capMod.U().restricoesDeCaptura(prefs).autoGainControl, true);

  env.setOption("ganhoAutomatico", false);
  assert.equal(capMod.U(), origProc);
  assert.equal(capMod.U().restricoesDeCaptura(prefs).autoGainControl, false);

  env.setOption("ganhoAutomatico", true);
  assert.notEqual(capMod.U(), origProc);
  assert.equal(capMod.U().nome, "web", "wrapper herda as demais propriedades");
  assert.equal(capMod.U().restricoesDeCaptura(prefs).autoGainControl, true);

  // Preferência do usuário já ligada continua ligada mesmo sem o wrapper
  env.def.stop();
  assert.equal(capMod.U().restricoesDeCaptura({ ...prefs, ganhoAutomatico: true }).autoGainControl, true);
});

test("audio-aprimorado: portão sem afinação, outros worklets e AudioContext sem argumentos", () => {
  const env = loadAudioPlugin();
  env.def.start();

  const options = { processorOptions: { afinacao: { antecipacaoMs: 40 }, modo: "cortando" } };
  new env.win.AudioWorkletNode({}, "outro-processador", options);
  assert.equal(env.workletCalls.at(-1).opts, options);
  new env.win.AudioWorkletNode({}, "portao-de-voz");
  assert.equal(env.workletCalls.at(-1).opts, undefined);
  const semAfinacao = { processorOptions: { manualDb: null, modo: "cortando" } };
  new env.win.AudioWorkletNode({}, "portao-de-voz", semAfinacao);
  assert.equal(env.workletCalls.at(-1).opts, semAfinacao, "sem afinação do Trivo não há o que ajustar");

  const ac = new env.win.AudioContext();
  assert.equal(ac.opts.sampleRate, 48000);
  assert.ok(ac instanceof env.BaseAudioContext);
  new env.win.AudioContext({ sampleRate: null });
  assert.equal(env.audioCtxCalls.at(-1).sampleRate, 48000, "sampleRate nulo é tratado como ausente");
  env.def.stop();
});

// Os objetos nascem no realm do vm; copia via JSON para comparar só a estrutura.
const enviados = (node) => JSON.parse(JSON.stringify(node.port.sent));

function custo(p95Ms, mediaMs = 0.2) {
  return { tipo: "supressor-custo", quadros: 200, mediaMs, p95Ms };
}

test("audio-aprimorado: proteção de CPU pausa o RNNoise só depois de relatórios caros seguidos", () => {
  const env = loadAudioPlugin({ withPort: true });
  const toasts = [];
  env.win.TrivoMod.toast = (text, opts) => toasts.push({ text, opts });
  env.def.start();

  const node = new env.win.AudioWorkletNode({}, "supressor-de-ruido", { processorOptions: { ativo: true, mistura: 0.85 } });
  assert.equal(node.port.started, 1, "addEventListener precisa de start() para receber mensagens");

  // Mensagens que não são de custo e relatórios baratos não fazem nada
  node.port.emit({ tipo: "supressor-pronto", taxa: 48000 });
  node.port.emit(custo(0.4));
  // Um pico isolado não basta: o seguinte barato zera a contagem
  node.port.emit(custo(3.5));
  node.port.emit(custo(0.4));
  node.port.emit(custo(3.5));
  assert.deepEqual(enviados(node), []);
  assert.equal(toasts.length, 0);

  // Segundo relatório caro seguido: passagem direta
  node.port.emit(custo(3.5));
  assert.deepEqual(enviados(node), [{ tipo: "ativo", ativo: false }]);
  assert.equal(node.__tmCpuFallback.p95Ms, 3.5);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].opts.tipo, "info");

  // Média alta também conta, mesmo com p95 dentro do limite
  const node2 = new env.win.AudioWorkletNode({}, "supressor-de-ruido", {});
  node2.port.emit(custo(1.5, 1.2));
  node2.port.emit(custo(1.5, 1.2));
  assert.deepEqual(enviados(node2), [{ tipo: "ativo", ativo: false }]);

  // Valores de limite exatos não disparam
  const node3 = new env.win.AudioWorkletNode({}, "supressor-de-ruido", {});
  node3.port.emit(custo(2, 1));
  node3.port.emit(custo(2, 1));
  node3.port.emit({ tipo: "supressor-custo", p95Ms: Number.NaN, mediaMs: undefined });
  assert.deepEqual(enviados(node3), []);

  env.def.stop();
});

test("audio-aprimorado: proteção de CPU respeita a opção, o stop e só vale para o supressor", () => {
  const env = loadAudioPlugin({ withPort: true });

  // Nó criado com o plugin desligado não ganha guarda
  const antes = new env.win.AudioWorkletNode({}, "supressor-de-ruido", {});
  assert.equal(antes.port.started, 0);

  env.def.start();
  env.setOption("protecaoCpu", false);
  const node = new env.win.AudioWorkletNode({}, "supressor-de-ruido", {});
  node.port.emit(custo(5));
  node.port.emit(custo(5));
  assert.deepEqual(enviados(node), [], "opção desligada não pausa");

  // Religar a opção vale para o mesmo nó, contando do zero
  env.setOption("protecaoCpu", true);
  node.port.emit(custo(5));
  assert.deepEqual(enviados(node), []);
  node.port.emit(custo(5));
  assert.deepEqual(enviados(node), [{ tipo: "ativo", ativo: false }]);

  // Outros worklets não ganham guarda
  const portao = new env.win.AudioWorkletNode({}, "portao-de-voz", {});
  assert.equal(portao.port.started, 0);

  // Depois do stop, relatórios caros são ignorados
  const vivo = new env.win.AudioWorkletNode({}, "supressor-de-ruido", {});
  env.def.stop();
  vivo.port.emit(custo(5));
  vivo.port.emit(custo(5));
  assert.deepEqual(enviados(vivo), []);

  // Sem toast disponível e com postMessage quebrado, não lança
  env.def.start();
  delete env.win.TrivoMod.toast;
  const quebrado = new env.win.AudioWorkletNode({}, "supressor-de-ruido", {});
  quebrado.port.postMessage = () => {
    throw new Error("porta fechada");
  };
  quebrado.port.emit(custo(5));
  assert.doesNotThrow(() => quebrado.port.emit(custo(5)));
  assert.equal(quebrado.__tmCpuFallback, undefined);
  env.def.stop();
});
