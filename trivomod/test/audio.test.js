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

  // Modo equilibrado (padrão)
  new env.win.AudioWorkletNode({}, "portao-de-voz", {
    processorOptions: { afinacao: origTuning, manualDb: null, modo: "cortando" },
  });
  assert.equal(origTuning.antecipacaoMs, 40, "não deve mutar o objeto original do Trivo");
  const eq = env.workletCalls[0].opts.processorOptions.afinacao;
  assert.equal(eq.antecipacaoMs, 20);
  assert.equal(eq.confirmacoesParaAbrir, 2);
  assert.equal(eq.voicingMinCorrelation, 0.3);
  assert.equal(eq.voicingMemoryMs, 1200);

  // Modo clássico (sem VoicingDetector)
  env.setOption("portao", "classico");
  new env.win.AudioWorkletNode({}, "portao-de-voz", {
    processorOptions: { afinacao: origTuning, manualDb: null, modo: "cortando" },
  });
  const cl = env.workletCalls[1].opts.processorOptions.afinacao;
  assert.equal(cl.antecipacaoMs, 15);
  assert.ok(Number.isNaN(cl.voicingRateHz));

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
  assert.equal(applied1[2].ratio.value, 6);

  // Modo limpa (sem compressão)
  env.setOption("saida", "limpa");
  const nodes2 = trivoVoiceNodes();
  track.setWebAudioPlugins(nodes2);
  const applied2 = calls.setPlugins.at(-1);
  assert.equal(applied2.length, 2);
  assert.ok(Math.abs(applied2[0].gain.value * applied2[1].gain.value - 1) < 1e-6);

  // Tela compartilhada (2 nós) fica intacta
  const screenNodes = [fakeCtx.createGain(), fakeCtx.createDynamicsCompressor()];
  track.setWebAudioPlugins(screenNodes);
  assert.deepEqual(calls.setPlugins.at(-1), screenNodes);

  // Modo padrão dentro do plugin ou plugin parado devolve a cadeia original
  env.setOption("saida", "padrao");
  const nodes3 = trivoVoiceNodes();
  track.setWebAudioPlugins(nodes3);
  assert.deepEqual(calls.setPlugins.at(-1), nodes3);

  env.def.stop();
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
