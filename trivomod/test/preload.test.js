"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "src", "preload", "index.js"), "utf8");

function runPreload({ origin = "https://trivo.app.br", isTop = true, boot, argv = [] }) {
  const calls = { sendSync: [], exposed: [], executed: [], errors: [], invoked: [], listeners: new Map(), order: [] };
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => (calls.order.push("expose"), calls.exposed.push([name, api])) },
    ipcRenderer: {
      sendSync: (c) => (calls.sendSync.push(c), boot),
      on: (c, f) => calls.listeners.set(c, f),
      invoke: async (...a) => (calls.invoked.push(a), true),
    },
    webFrame: {
      executeJavaScript: (code) => {
        calls.order.push("exec");
        calls.executed.push(code);
        return code.includes("HOOK_FALHA") ? Promise.reject(new Error("falhou")) : Promise.resolve(undefined);
      },
    },
  };
  const win = {};
  win.parent = isTop ? win : {};
  const sandbox = {
    window: win,
    location: { origin },
    process: { argv: ["electron", ...argv] },
    console: { error: (...a) => calls.errors.push(a), log() {} },
    JSON,
    String,
    Promise,
    require: (m) => {
      assert.equal(m, "electron");
      return fakeElectron;
    },
  };
  vm.runInNewContext(source, sandbox);
  return new Promise((resolve) => setTimeout(() => resolve(calls), 20));
}

const bootData = {
  runtime: "/* runtime */",
  settings: {},
  themes: [],
  plugins: [{ id: "builtin:a", builtin: true, source: "TrivoMod.definePlugin({name:'A'})" }],
  info: { version: "x" },
};

test("preload: injeta runtime, depois plugins, depois __ready, e expõe só a API nativa", async () => {
  const calls = await runPreload({ boot: bootData });
  assert.equal(calls.exposed.length, 1);
  assert.equal(calls.exposed[0][0], "TrivoModNative");
  assert.equal(Object.keys(calls.exposed[0][1]).sort().join(), "boot,bootOk,exportBackup,importBackup,leaveSafeMode,onFrameAction,onSystemAccent,onThemesChanged,openFolder,refreshThemeLinks,resetIcon,restartToApplyIcon,saveSettings,setFrame,setIcon,setThemeIcon");
  assert.equal(JSON.stringify(calls.exposed[0][1].boot.plugins), '[{"id":"builtin:a","builtin":true}]'); // sem o código dos plugins
  assert.equal(calls.executed.length, 3);
  assert.match(calls.executed[0], /^\/\* runtime \*\//);
  assert.match(calls.executed[1], /__loadPlugin\("builtin:a", true, function/);
  assert.match(calls.executed[2], /^TrivoMod\.__ready\(\)/);
});

test("preload: não faz nada em outra origem, em subquadro ou sem confiança do processo principal", async () => {
  for (const opts of [
    { origin: "https://evil.example", boot: bootData },
    { origin: "null", boot: bootData },
    { isTop: false, boot: bootData },
  ]) {
    const calls = await runPreload(opts);
    assert.equal(calls.sendSync.length, 0, String(opts.origin));
    assert.equal(calls.exposed.length, 0);
  }
  const refused = await runPreload({ boot: null });
  assert.equal(refused.sendSync.length, 1);
  assert.equal(refused.exposed.length, 0);
  assert.equal(refused.executed.length, 0);
});

test("preload: aceita a origem que o próprio app declara (desenvolvimento)", async () => {
  const calls = await runPreload({ origin: "http://localhost:3000", argv: ["--trivo-origem=http://localhost:3000"], boot: bootData });
  assert.equal(calls.exposed.length, 1);
});

test("preload: hook de módulos roda primeiro, síncrono, antes de expor a API; erro só é registrado", async () => {
  const calls = await runPreload({ boot: { ...bootData, modulesHook: "/* HOOK_FALHA */" } });
  assert.equal(calls.order[0], "exec", "o hook é a primeira coisa executada");
  assert.equal(calls.order[1], "expose");
  assert.equal(calls.executed[0], "/* HOOK_FALHA */\n//# sourceURL=trivomod/turbopack.js");
  assert.match(calls.executed[1], /^\/\* runtime \*\//, "o runtime vem depois, mesmo com o hook falhando");
  assert.equal(calls.executed.length, 4);
  assert.ok(calls.errors.some((e) => String(e[0]).includes("hook de módulos")));
});

test("preload: hook de módulos é pulado no modo seguro ou se vier vazio", async () => {
  for (const boot of [{ ...bootData, modulesHook: "/* hook */", info: { safeMode: true } }, { ...bootData, modulesHook: "" }]) {
    const calls = await runPreload({ boot });
    assert.ok(!calls.executed.some((c) => c.includes("turbopack.js")));
    assert.match(calls.executed[0], /^\/\* runtime \*\//);
  }
});

test("preload: métodos novos usam os canais certos e onSystemAccent recebe o aviso", async () => {
  const calls = await runPreload({ boot: bootData });
  const api = calls.exposed[0][1];
  await api.bootOk();
  await api.leaveSafeMode();
  await api.exportBackup();
  await api.importBackup();
  await api.refreshThemeLinks();
  await api.setFrame({ translucent: true });
  assert.deepEqual(
    calls.invoked.map((a) => a[0]),
    ["trivomod:boot-ok", "trivomod:leave-safe-mode", "trivomod:export-backup", "trivomod:import-backup", "trivomod:refresh-theme-links", "trivomod:set-frame"],
  );
  assert.deepEqual(calls.invoked[5][1], { translucent: true });
  const got = [];
  api.onSystemAccent((c) => got.push(c));
  calls.listeners.get("trivomod:system-accent")({}, "#ff0088");
  api.onSystemAccent(null);
  calls.listeners.get("trivomod:system-accent")({}, "#000000");
  assert.deepEqual(got, ["#ff0088"]);
});

test("preload: injeta defaultIcon antes do runtime e expõe setThemeIcon", async () => {
  const calls = await runPreload({ boot: { ...bootData, defaultIcon: "/* default-icon */" } });
  assert.equal(calls.executed.length, 4);
  assert.match(calls.executed[0], /^\/\* default-icon \*\//);
  assert.match(calls.executed[1], /^\/\* runtime \*\//);
  await calls.exposed[0][1].setThemeIcon("data:image/png;base64,AAA");
  assert.deepEqual(calls.invoked[0], ["trivomod:set-theme-icon", "data:image/png;base64,AAA"]);
});
