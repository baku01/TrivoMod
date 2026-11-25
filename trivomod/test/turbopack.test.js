"use strict";
// Testes do hook do Turbopack (src/renderer/turbopack.js).
// Roda o hook e o runtime REAL do Trivo (test/fixtures/turbopack/runtime.js, cópia do
// chunk turbopack-077hmtqrhcoji.js) num contexto vm sem geração de código por string
// (equivalente à CSP sem eval/new Function), junto com 2 chunks reais e 1 sintético.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const fixtures = path.join(__dirname, "fixtures", "turbopack");
const hookSource = fs.readFileSync(path.join(root, "src", "renderer", "turbopack.js"), "utf8");
const read = (name) => fs.readFileSync(path.join(fixtures, name), "utf8");

const CHUNKS = {
  runtime: { file: "runtime.js", src: "/_next/static/chunks/turbopack-077hmtqrhcoji.js" },
  globalError: { file: "global-error.js", src: "/_next/static/chunks/326o5fjda63-p.js" },
  lazy: { file: "lazy-loaders.js", src: "/_next/static/chunks/1eawmpzyrhgbf.js" },
  app: { file: "app-sintetico.js", src: "/_next/static/chunks/app-sintetico.js" },
};
const PAGE_CHUNKS = [CHUNKS.globalError, CHUNKS.lazy, CHUNKS.app];

function makeWorld() {
  const warnings = [];
  const document = {
    currentScript: null,
    querySelectorAll: () => [],
    createElement: () => ({}),
    head: { appendChild() {} },
  };
  const sandbox = {
    console: { log() {}, error() {}, warn: (...a) => warnings.push(a.map(String).join(" ")) },
    document,
    URL,
    setTimeout,
    clearTimeout,
  };
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const g = vm.runInContext("globalThis", ctx);
  g.self = g;
  const run = (code, src, file) => {
    document.currentScript = { getAttribute: (n) => (n === "src" ? src : null) };
    try {
      vm.runInContext(code, ctx, { filename: file || src });
    } finally {
      document.currentScript = null;
    }
  };
  return {
    g,
    warnings,
    run,
    hook: () => vm.runInContext(hookSource, ctx, { filename: "turbopack.js" }),
    chunk: (c) => run(read(c.file), c.src, c.file),
    entry: (ids) =>
      run(
        `(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push(${JSON.stringify({
          otherChunks: PAGE_CHUNKS.map((c) => c.src.replace("/_next/", "")),
          runtimeModuleIds: ids,
        })});`,
        undefined,
        "inline-entry.js"
      ),
    get mods() {
      return g.__trivomodModules;
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

async function checkLoadedPage(w) {
  const M = w.mods;
  await M.ready;
  assert.equal(M.isReady, true);
  // Pendurado antes de o módulo assíncrono terminar.
  const asyncP = M.waitForProps("asyncThing");
  w.entry([700001, 700010]);
  const asyncExports = await asyncP;
  assert.equal(asyncExports.asyncThing, 42);
  for (let i = 0; i < 5; i++) await flush();

  // A entrada real do runtime avaliou tudo e importou módulos via e.i.
  assert.equal(w.g.__entradaRodou, "function|function|true");

  // findByProps em módulo ESM (e.s).
  const jsx = M.findByProps("jsx", "jsxs");
  assert.ok(jsx);
  assert.equal(typeof jsx.jsx, "function");
  assert.equal(jsx.Fragment, "fragment");
  assert.equal(M.findByProps("jsx", "naoExiste"), undefined);

  // findByCode no texto da factory real (global-error do Trivo) -> exports ESM com default.
  const ge = M.findByCode("O Trivo não conseguiu carregar");
  assert.ok(ge);
  assert.equal(typeof ge.default, "function");
  assert.equal(M.findByCode("O Trivo não conseguiu carregar", "isso não está no código"), undefined);
  assert.equal(M.findByCode(/Tentar de novo/), ge);

  // findByCode em módulo CJS real (s.v): exports é a própria função de carregamento.
  const lazy = M.findByCode("static/chunks/0td9h_46_m-89.js");
  assert.equal(typeof lazy, "function");
  assert.equal(M.get(525468), lazy);

  // Factory compartilhada por dois ids (700030, 700031); só 700031 foi avaliado.
  assert.equal(M.get(700031).compartilhada, true);
  assert.equal(M.get(700030), undefined);
  assert.deepEqual(Array.from(M.findIdsByCode("TRIVOMOD_COMPARTILHADA")).sort(), [700030, 700031]);
  assert.ok(M.code(700030).includes("TRIVOMOD_COMPARTILHADA"));
  // ids conhecidos mas não avaliados aparecem em findIdsByCode, não em findByCode.
  assert.ok(M.findIdsByCode("static/chunks/0td9h_46_m-89.js").includes(525468));
  assert.ok(M.findIdsByCode("3l4itdtpevyjv").length === 0);

  // all(), findAll, waitFor já satisfeito e filtro por default.
  const all = M.all();
  for (const id of [305936, 931823, 525468, 700001, 700010, 700031]) assert.ok(all.has(id), "all() sem " + id);
  assert.equal(M.findAll(M.filters.byProps("jsx")).length, 1);
  let cbArgs;
  const viaCb = await M.waitFor((e) => e.Fragment === "fragment", (e, id) => (cbArgs = [e, id]));
  assert.equal(viaCb, jsx);
  assert.equal(cbArgs[1], 305936);
  const def = M.find((e) => typeof e === "function" && String(e).includes("pt-BR"));
  assert.equal(def, ge.default);

  // Nada do hook gerou avisos.
  assert.deepEqual(w.warnings, []);
}

test("API exposta e não enumerável", () => {
  const w = makeWorld();
  w.hook();
  const d = Object.getOwnPropertyDescriptor(w.g, "__trivomodModules");
  assert.equal(d.enumerable, false);
  assert.equal(d.writable, false);
  for (const k of ["all", "find", "findAll", "findByProps", "findByCode", "waitFor", "waitForProps"]) {
    assert.equal(typeof w.mods[k], "function", k);
  }
  assert.equal(typeof w.mods.ready.then, "function");
  assert.equal(w.mods.isReady, false);
  // Rodar de novo não reinstala nem quebra.
  const api = w.mods;
  w.hook();
  assert.equal(w.mods, api);
});

test("(a) chunks reais empurrados ANTES do runtime real (fase array)", async () => {
  const w = makeWorld();
  w.hook();
  for (const c of PAGE_CHUNKS) w.chunk(c);
  assert.ok(Array.isArray(w.g.TURBOPACK));
  assert.equal(w.g.TURBOPACK.length, 3);
  // Factories já estão conhecidas (texto) mesmo antes de avaliar.
  assert.deepEqual(Array.from(w.mods.findIdsByCode("O Trivo não conseguiu carregar")), [931823]);
  w.chunk(CHUNKS.runtime);
  assert.equal(Array.isArray(w.g.TURBOPACK), false);
  await checkLoadedPage(w);
});

test("(b) runtime real primeiro, chunks depois (fase registry)", async () => {
  const w = makeWorld();
  w.hook();
  w.chunk(CHUNKS.runtime);
  await w.mods.ready;
  // waitFor pendurado antes de o chunk existir.
  const pending = w.mods.waitForCode("O Trivo não conseguiu carregar");
  for (const c of PAGE_CHUNKS) w.chunk(c);
  await checkLoadedPage(w);
  const ge = await pending;
  assert.equal(typeof ge.default, "function");
});

test("ordem mista: entrada inline e parte dos chunks antes do runtime", async () => {
  const w = makeWorld();
  w.hook();
  w.chunk(CHUNKS.globalError);
  const asyncP = w.mods.waitForProps("asyncThing");
  w.entry([700001, 700010]);
  w.chunk(CHUNKS.runtime);
  w.chunk(CHUNKS.lazy);
  w.chunk(CHUNKS.app);
  assert.equal((await asyncP).asyncThing, 42);
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(w.g.__entradaRodou, "function|function|true");
  assert.equal(typeof w.mods.findByCode("pt-BR").default, "function");
  assert.deepEqual(w.warnings, []);
});

test("hook instalado tarde: adota array existente", async () => {
  const w = makeWorld();
  w.chunk(CHUNKS.globalError);
  w.chunk(CHUNKS.lazy);
  w.hook();
  w.chunk(CHUNKS.app);
  w.chunk(CHUNKS.runtime);
  await checkLoadedPage(w);
});

test("erro dentro do hook não impede o push", () => {
  const w = makeWorld();
  w.hook();
  const received = [];
  w.g.TURBOPACK = { push: (...items) => (received.push(...items), "ok") };
  // Array cujo slice lança: o hook falha ao copiar e o push original recebe o item intacto.
  const evil = new Proxy([null, 1, () => {}], {
    get(t, k) {
      if (k === "slice") throw new Error("boom no hook");
      return Reflect.get(t, k);
    },
  });
  assert.equal(w.g.TURBOPACK.push(evil), "ok");
  assert.equal(received[0], evil);
  assert.ok(w.warnings.some((m) => m.includes("[TrivoMod:turbopack]") && m.includes("boom no hook")));

  // Erro ao registrar (module.id lança) vira log; o retorno da factory segue.
  w.warnings.length = 0;
  w.g.TURBOPACK.push([null, 5, () => "retorno"]);
  const wrapped = received[1][2];
  const badModule = {
    exports: {},
    get id() {
      throw new Error("id quebrado");
    },
  };
  assert.equal(wrapped({ m: badModule }, badModule, {}), "retorno");
  assert.ok(w.warnings.some((m) => m.includes("id quebrado")));

  // Erro da própria factory propaga (como sem o hook) e o módulo não é registrado.
  w.g.TURBOPACK.push([null, 6, () => {
    throw new Error("factory falhou");
  }]);
  const mod = { exports: {}, id: 6 };
  assert.throws(() => received[2][2]({ m: mod }, mod, mod.exports), /factory falhou/);
  assert.equal(w.mods.get(6), undefined);
});

test("preserva this, argumentos e retorno do push e da factory", () => {
  const w = makeWorld();
  w.hook();
  let seenThis;
  let seenArgs;
  const registry = {
    tag: "registry",
    push(...items) {
      seenThis = this;
      seenArgs = items;
      return 123;
    },
  };
  w.g.TURBOPACK = registry;
  const factory = function (ctx, module, exports) {
    this.chamado = [ctx.tag, module.id, exports.x, arguments.length];
    module.exports = { pronto: true };
    return "valor";
  };
  const extra = { otherChunks: [], runtimeModuleIds: [] };
  assert.equal(w.g.TURBOPACK.push(["chunk.js", 9, 10, factory], extra), 123);
  assert.equal(seenThis, registry);
  assert.equal(seenArgs.length, 2);
  assert.equal(seenArgs[1], extra);
  assert.equal(seenArgs[0][0], "chunk.js");
  assert.equal(seenArgs[0][1], 9);
  assert.equal(seenArgs[0][2], 10);
  const wrapped = seenArgs[0][3];
  assert.notEqual(wrapped, factory);
  const self = {};
  const mod = { exports: { x: 7 }, id: 10 };
  assert.equal(wrapped.call(self, { tag: "ctx", m: mod }, mod, mod.exports, "extra"), "valor");
  assert.deepEqual(self.chamado, ["ctx", 10, 7, 4]);
  assert.equal(w.mods.findByProps("pronto"), mod.exports);
  assert.equal(w.mods.code(9), w.mods.code(10));
  assert.ok(w.mods.code(9).includes("this.chamado"));
});

test("waitFor com timeout rejeita e filtro inválido lança", async () => {
  const w = makeWorld();
  w.hook();
  await assert.rejects(w.mods.waitFor(() => false, { timeout: 20 }), /tempo esgotado/);
  assert.throws(() => w.mods.find("x"), { name: "TypeError" });
  assert.throws(() => w.mods.findByProps(), { name: "TypeError" });
});
