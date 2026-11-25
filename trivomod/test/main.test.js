"use strict";
// Exercita src/main/index.js com um `electron` simulado: registro do preload, confiança do IPC, ajustes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

// Cada harness cria um gerenciador de ícone, que registra um `process.on("exit")`.
process.setMaxListeners(100);

function harness(opts = {}) {
  const handlers = { on: new Map(), handle: new Map() };
  const app = new EventEmitter();
  app.whenReady = () => Promise.resolve();
  const lifecycle = [];
  app.relaunch = () => lifecycle.push("relaunch");
  app.exit = (code) => lifecycle.push(`exit:${code}`);
  app.quit = () => lifecycle.push("quit");
  const sent = [];
  const dialogCalls = [];
  app.dock = { setIcon: (img) => (iconCalls.push(img), undefined) };
  const opened = [];
  const iconCalls = [];
  const fakeImage = (buf) => ({
    isEmpty: () => !buf || buf.length === 0,
    buf,
    resize: ({ width }) => fakeImage(Buffer.concat([buf.subarray(0, 8), Buffer.from(`png-${width}`)])),
    toPNG: () => buf,
  });
  const fakeElectron = {
    app,
    ipcMain: { on: (c, f) => handlers.on.set(c, f), handle: (c, f) => handlers.handle.set(c, f) },
    shell: { openPath: async (p) => (opened.push(p), "") },
    webContents: { getAllWebContents: () => opts.contents || [] },
    net: opts.fetch ? { fetch: opts.fetch } : {},
    dialog: {
      showSaveDialog: async (...a) => (dialogCalls.push(["save", ...a]), opts.save ? opts.save(...a) : { canceled: true }),
      showOpenDialog: async (...a) => (dialogCalls.push(["open", ...a]), opts.open ? opts.open(...a) : { canceled: true, filePaths: [] }),
    },
    nativeImage: {
      createFromBuffer: (b) => fakeImage(b),
      createFromPath: (p) => fakeImage(fs.existsSync(p) ? fs.readFileSync(p) : null),
    },
    BaseWindow: { getAllWindows: () => opts.windows || [] },
  };
  const original = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === "electron") return fakeElectron;
    // native.js é de outro dono: o teste decide se ele "existe" e o que faz.
    if (request === "./native" && parent && /(src|dist)[\\/]main[\\/]index\.js$/.test(parent.filename)) {
      if (opts.native) return { createNativeManager: (o) => (opts.native.options = o, opts.native) };
      const error = new Error("Cannot find module './native'");
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    return original.call(this, request, parent, ...rest);
  };
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-test-"));
  if (opts.files) {
    for (const [rel, text] of Object.entries(opts.files)) {
      fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dataDir, rel), text);
    }
  }
  const env = { TRIVOMOD_SAFE: undefined, TRIVOMOD_SELFTEST: undefined, TRIVOMOD_NO_UPDATE: undefined, ...(opts.env || {}) };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    // installed: roda a cópia de <dados>/dist, como o loader do Trivo faz (é onde o atualizador liga).
    // realpath: as chaves do require.cache são caminhos reais (no macOS /var -> /private/var).
    const distDir = path.join(fs.realpathSync(dataDir), "dist");
    const entry = opts.installed ? path.join(distDir, "main", "index.js") : require.resolve("../src/main/index.js");
    for (const key of Object.keys(require.cache)) if (key === entry || key.startsWith(distDir + path.sep)) delete require.cache[key];
    require(entry).start({ dataDir, appPath: "/fake/app.asar" });
  } finally {
    Module._load = original;
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
  const bootData = (event = trusted) => {
    const out = {};
    handlers.on.get("trivomod:boot")({ ...event, set returnValue(v) { out.v = v; } });
    return out.v;
  };
  return { app, handlers, dataDir, opened, iconCalls, lifecycle, sent, dialogCalls, bootData };
}

const trusted = { senderFrame: { parent: null, url: "https://trivo.app.br/painel" } };

test("registra o preload em cada sessão criada, uma vez só", () => {
  const { app } = harness();
  const calls = [];
  const ses = { registerPreloadScript: (o) => calls.push(o) };
  app.emit("session-created", ses);
  app.emit("session-created", ses);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "frame");
  assert.deepEqual(calls[0].matches, ["https://trivo.app.br/*"]);
  assert.ok(fs.existsSync(calls[0].filePath), "o arquivo de preload precisa existir");
});

test("boot: só a origem do Trivo recebe o runtime", () => {
  const { handlers } = harness();
  const boot = handlers.on.get("trivomod:boot");
  const ok = {};
  boot({ ...trusted, returnValue: undefined, set returnValue(v) { ok.v = v; } });
  assert.match(ok.v.runtime, /TrivoMod/);
  assert.ok(ok.v.themes.length >= 2);
  assert.ok(ok.v.plugins.length >= 3);

  for (const senderFrame of [
    { parent: null, url: "https://evil.example/" },
    { parent: null, url: "https://trivo.app.br.evil.example/" },
    { parent: {}, url: "https://trivo.app.br/" }, // subquadro
    null,
  ]) {
    const bad = {};
    boot({ senderFrame, set returnValue(v) { bad.v = v; } });
    assert.equal(bad.v, null);
  }
});

test("ajustes: grava só o formato conhecido e recusa origem de fora", async () => {
  const { handlers, dataDir } = harness();
  const save = handlers.handle.get("trivomod:save-settings");
  assert.equal(await save({ senderFrame: { parent: null, url: "https://evil.example/" } }, { quickCss: "x" }), false);
  assert.equal(fs.existsSync(path.join(dataDir, "settings.json")), false);

  assert.equal(await save(trusted, { themes: { "builtin:amoled": true }, extra: "descartado", quickCss: "a{}" }), true);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
  assert.deepEqual(saved.themes, { "builtin:amoled": true });
  assert.equal(saved.extra, undefined);
});

test("open-folder: só pastas conhecidas", async () => {
  const { handlers, dataDir, opened } = harness();
  const open = handlers.handle.get("trivomod:open-folder");
  assert.equal(await open(trusted, "themes"), true);
  assert.equal(await open(trusted, "../../etc"), false);
  assert.equal(await open({ senderFrame: null }, "themes"), false);
  assert.deepEqual(opened, [path.join(dataDir, "themes")]);
});

test("boot: entrega layouts e informa a plataforma", () => {
  const { handlers } = harness();
  const out = {};
  handlers.on.get("trivomod:boot")({ ...trusted, set returnValue(v) { out.v = v; } });
  assert.ok(out.v.layouts.some((l) => l.id === "builtin:discord" && l.name === "Discord"));
  assert.ok(out.v.themes.filter((t) => t.id.startsWith("builtin:catppuccin-")).length === 4);
  assert.equal(out.v.info.platform, process.platform);
  assert.equal(out.v.info.customIcon, false);
});

test("ícone: aceita só PNG de verdade, grava, aplica e restaura; recusa origem de fora", async () => {
  const { handlers, dataDir, iconCalls } = harness();
  const set = handlers.handle.get("trivomod:set-icon");
  const reset = handlers.handle.get("trivomod:reset-icon");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  const url = `data:image/png;base64,${png.toString("base64")}`;

  assert.equal((await set({ senderFrame: { parent: null, url: "https://evil.example/" } }, url)).ok, false);
  assert.equal((await set(trusted, "data:image/svg+xml;base64,PHN2Zz4=")).ok, false);
  assert.equal((await set(trusted, `data:image/png;base64,${Buffer.from("nao e png nao e png nao e png nao e png nao e png nao e png nao e png").toString("base64")}`)).ok, false);
  assert.equal(fs.existsSync(path.join(dataDir, "icon.png")), false);

  assert.equal((await set(trusted, url)).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, "icon.png")), png);
  assert.ok(fs.existsSync(path.join(dataDir, "icon.icns")) && fs.existsSync(path.join(dataDir, "icon.ico")), "gera .icns e .ico");
  if (process.platform === "darwin") assert.equal(iconCalls.length, 1);

  assert.equal((await reset(trusted)).ok, true);
  assert.equal(fs.existsSync(path.join(dataDir, "icon.png")), false);
  assert.equal(fs.existsSync(path.join(dataDir, "icon.icns")), false);
});

// ============================================================ recursos: modo seguro, backup, temas online, hook, janela nativa
const settings = require("../src/main/settings");
const { download, hashOf, fallbackName } = require("../src/main/themelinks");
const start = harness;
const evil = { senderFrame: { parent: null, url: "https://evil.example/" } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).failedBoots;

// ------------------------------------------------------------ ajustes
test("ajustes: native e themeLinks com padrão e saneados", () => {
  const d = settings.defaults();
  assert.deepEqual(d.native, { enabled: true, translucent: true, systemFont: true, systemAccent: false });
  assert.deepEqual(d.themeLinks, []);
  const out = settings.sanitize({
    native: { enabled: false, translucent: "sim", systemAccent: true, extra: true },
    themeLinks: [
      "https://a.example/t.css",
      "http://b.example/t.css",
      "javascript:alert(1)",
      "nem url",
      42,
      `https://c.example/${"x".repeat(500)}`,
      "https://a.example/t.css",
      ...Array.from({ length: 30 }, (_, i) => `https://n.example/${i}.css`),
    ],
  });
  assert.deepEqual(out.native, { enabled: false, translucent: true, systemFont: true, systemAccent: true });
  assert.equal(out.themeLinks.length, 20);
  assert.equal(out.themeLinks[0], "https://a.example/t.css");
  assert.ok(out.themeLinks.every((u) => u.startsWith("https://") && u.length <= 500));
  assert.equal(new Set(out.themeLinks).size, 20);
  assert.deepEqual(settings.sanitize({ native: null, themeLinks: "https://x" }).themeLinks, []);
});

// ------------------------------------------------------------ modo seguro automático
test("modo seguro: 3 falhas seguidas ligam o modo automático; boot-ok zera", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-test-"));
  for (let i = 1; i <= 3; i++) {
    const h = start({ dataDir });
    assert.equal(h.bootData().info.safeReason, null, `abertura ${i}`);
    assert.equal(state(dataDir), i);
  }
  const h = start({ dataDir });
  const info = h.bootData().info;
  assert.equal(info.safeMode, true);
  assert.equal(info.safeReason, "auto");
  assert.equal(h.bootData().modulesHook, "");
  // em modo seguro, boot-ok não tira do modo seguro; importar e gravar ficam bloqueados
  assert.equal(await h.handlers.handle.get("trivomod:boot-ok")(trusted), false);
  assert.equal((await h.handlers.handle.get("trivomod:import-backup")(trusted)).ok, false);
  assert.equal(state(dataDir), 4);

  const normal = start({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-test-")) });
  assert.equal(await normal.handlers.handle.get("trivomod:boot-ok")(evil), false);
  assert.equal(state(normal.dataDir), 1);
  assert.equal(await normal.handlers.handle.get("trivomod:boot-ok")(trusted), true);
  assert.equal(state(normal.dataDir), 0);
});

test("modo seguro: TRIVOMOD_SAFE=1 dá safeReason env", () => {
  const h = start({ env: { TRIVOMOD_SAFE: "1" } });
  const info = h.bootData().info;
  assert.equal(info.safeMode, true);
  assert.equal(info.safeReason, "env");
});

test("modo seguro: queda do processo da página do Trivo conta; clean-exit e outras origens não", () => {
  const h = start();
  const wc = (url) => Object.assign(new EventEmitter(), { getURL: () => url });
  const trivo = wc("https://trivo.app.br/painel");
  const other = wc("https://evil.example/");
  h.app.emit("web-contents-created", {}, trivo);
  h.app.emit("web-contents-created", {}, other);
  assert.equal(state(h.dataDir), 1);
  trivo.emit("render-process-gone", {}, { reason: "clean-exit" });
  other.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(state(h.dataDir), 1);
  trivo.emit("render-process-gone", {}, { reason: "crashed" });
  trivo.emit("render-process-gone", {}, { reason: "oom" });
  assert.equal(state(h.dataDir), 3);
});

test("modo seguro: leave-safe-mode zera, reinicia; sem relaunch no autoteste", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-test-"));
  fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({ failedBoots: 7 }));
  const h = start({ dataDir });
  assert.equal(h.bootData().info.safeReason, "auto");
  assert.equal(await h.handlers.handle.get("trivomod:leave-safe-mode")(evil), false);
  assert.equal(await h.handlers.handle.get("trivomod:leave-safe-mode")(trusted), true);
  assert.equal(state(dataDir), 0);
  await tick(150);
  assert.deepEqual(h.lifecycle, ["relaunch", "exit:0"]);

  const s = start({ env: { TRIVOMOD_SELFTEST: "1" } });
  await s.handlers.handle.get("trivomod:leave-safe-mode")(trusted);
  await tick(150);
  assert.deepEqual(s.lifecycle, ["exit:0"]);
});

test("modo seguro: state.json corrompido conta como zero", () => {
  const h = start({ files: { "state.json": "{lixo" } });
  assert.equal(h.bootData().info.safeReason, null);
  assert.equal(state(h.dataDir), 1);
});

// ------------------------------------------------------------ backup
test("backup: exporta só arquivos do usuário, na janela de quem pediu", async () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-bk-")), "b.json");
  const sender = { id: 1 };
  const win = { contentView: { children: [{ webContents: { id: 2 } }, { webContents: sender }] } };
  const h = start({
    windows: [{ contentView: { children: [] } }, win],
    save: () => ({ canceled: false, filePath: out }),
    files: {
      "settings.json": JSON.stringify({ quickCss: "a{}", themeLinks: ["https://x.example/t.css"] }),
      "themes/meu.css": "/* @name Meu */",
      "themes/nao.txt": "fora",
      "layouts/lay.css": "b{}",
      "plugins/p.js": "1",
      "plugins/errado.css": "x",
    },
  });
  assert.equal((await h.handlers.handle.get("trivomod:export-backup")(evil)).ok, false);
  const res = await h.handlers.handle.get("trivomod:export-backup")({ ...trusted, sender });
  assert.equal(res.ok, true);
  assert.deepEqual(res.counts, { themes: 1, layouts: 1, plugins: 1 });
  const [kind, usedWin, options] = h.dialogCalls[0];
  assert.equal(kind, "save");
  assert.equal(usedWin, win);
  assert.match(options.defaultPath, /^trivomod-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(data.format, "trivomod-backup");
  assert.equal(data.version, 1);
  assert.ok(!Number.isNaN(Date.parse(data.createdAt)));
  assert.equal(data.settings.quickCss, "a{}");
  assert.deepEqual(data.themes, { "meu.css": "/* @name Meu */" });
  assert.deepEqual(data.layouts, { "lay.css": "b{}" });
  assert.deepEqual(data.plugins, { "p.js": "1" });

  // sem janela conhecida: o diálogo abre sem janela-mãe
  const h2 = start({ save: () => ({ canceled: true }) });
  const r2 = await h2.handlers.handle.get("trivomod:export-backup")({ ...trusted, sender });
  assert.equal(r2.ok, false);
  assert.equal(r2.canceled, true);
  assert.equal(typeof h2.dialogCalls[0][1].defaultPath, "string");
});

test("backup: importa, grava arquivos e ajustes saneados; recusa backups ruins", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-bk-"));
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const good = write("bom.json", {
    format: "trivomod-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    settings: { quickCss: "z{}", extra: 1, themeLinks: ["http://inseguro.example/a.css"] },
    themes: { "t 1.css": "/* t */" },
    layouts: { "l.css": "l{}" },
    plugins: { "p.js": "// p" },
  });
  let pick = good;
  const h = start({ open: () => ({ canceled: false, filePaths: [pick] }) });
  const imp = h.handlers.handle.get("trivomod:import-backup");
  assert.equal((await imp(evil)).ok, false);
  const res = await imp(trusted);
  assert.deepEqual(res, { ok: true, counts: { themes: 1, layouts: 1, plugins: 1 } });
  assert.equal(fs.readFileSync(path.join(h.dataDir, "themes", "t 1.css"), "utf8"), "/* t */");
  assert.equal(fs.readFileSync(path.join(h.dataDir, "plugins", "p.js"), "utf8"), "// p");
  const saved = JSON.parse(fs.readFileSync(path.join(h.dataDir, "settings.json"), "utf8"));
  assert.equal(saved.quickCss, "z{}");
  assert.equal(saved.extra, undefined);
  assert.deepEqual(saved.themeLinks, []);
  assert.deepEqual(h.dialogCalls[0][1].filters[0].extensions, ["json"]);

  const base = { format: "trivomod-backup", version: 1, settings: {} };
  const bad = [
    write("nao-json.json", "{"),
    write("formato.json", { ...base, format: "outro" }),
    write("versao.json", { ...base, version: 2 }),
    write("travessia.json", { ...base, themes: { "../../fora.css": "x" } }),
    write("barra.json", { ...base, plugins: { "a/b.js": "x" } }),
    write("extensao.json", { ...base, themes: { "t.js": "x" } }),
    write("plugin-css.json", { ...base, plugins: { "p.css": "x" } }),
    write("conteudo.json", { ...base, themes: { "t.css": 1 } }),
    write("grande.json", JSON.stringify({ ...base, quickCss: "x".repeat(5 * 1024 * 1024) })),
  ];
  for (const file of bad) {
    pick = file;
    const r = await imp(trusted);
    assert.equal(r.ok, false, path.basename(file));
    assert.equal(typeof r.error, "string");
  }
  assert.equal(fs.existsSync(path.join(h.dataDir, "fora.css")), false);
  assert.equal(fs.existsSync(path.join(h.dataDir, "themes", "t.js")), false);
});

// ------------------------------------------------------------ temas online
const cssResponse = (body, init = {}) => new Response(body, { status: 200, headers: { "content-type": "text/css" }, ...init });

test("temas online: download só https, segue redirecionamento https, limita tamanho e tempo", async () => {
  await assert.rejects(download(async () => cssResponse("a{}"), "http://x.example/a.css"), /https/);
  const hops = [];
  const redirecting = async (url) => {
    hops.push(url);
    if (url === "https://x.example/a.css") return new Response(null, { status: 302, headers: { location: "/b.css" } });
    if (url === "https://x.example/b.css") return cssResponse("b{}");
    if (url === "https://x.example/c.css") return new Response(null, { status: 301, headers: { location: "http://x.example/b.css" } });
    return new Response("", { status: 404 });
  };
  assert.equal(await download(redirecting, "https://x.example/a.css"), "b{}");
  assert.deepEqual(hops, ["https://x.example/a.css", "https://x.example/b.css"]);
  await assert.rejects(download(redirecting, "https://x.example/c.css"), /https/);
  await assert.rejects(download(redirecting, "https://x.example/404.css"), /HTTP 404/);
  await assert.rejects(download(async () => cssResponse("x".repeat(1024 * 1024 + 1)), "https://x.example/a.css"), /1 MB/);
  const loop = async () => new Response(null, { status: 302, headers: { location: "https://x.example/a.css" } });
  await assert.rejects(download(loop, "https://x.example/a.css"), /redirecionamentos/);
  const hang = (_url, { signal }) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(new Error("abort"))));
  await assert.rejects(download(hang, "https://x.example/a.css", { timeout: 30 }), /tempo esgotado/);
});

test("temas online: nome pelo cabeçalho ou hostname + último segmento", () => {
  assert.equal(fallbackName("https://cdn.example/u/meu%20tema.css?x=1"), "cdn.example/meu tema.css");
  assert.equal(fallbackName("https://cdn.example/"), "cdn.example");
  assert.equal(hashOf("https://a").length, 16);
});

test("temas online: refresh baixa, cacheia, entra no boot e no broadcast; limpa órfãos", async () => {
  const A = "https://cdn.example/a.css";
  const B = "https://cdn.example/tema/b.css";
  const bodies = { [A]: "/**\n * @name Tema A\n * @author Ana\n * @description Desc\n */\n:root{--a:1}", [B]: "b{}" };
  const fetched = [];
  const fetch = async (url) => (fetched.push(url), bodies[url] ? cssResponse(bodies[url]) : new Response("", { status: 500 }));
  const sent = [];
  const page = { mainFrame: { url: "https://trivo.app.br/" }, send: (c, p) => sent.push([c, p]) };
  const orphan = `cache/links/${"f".repeat(16)}.css`;
  const h = start({
    fetch,
    contents: [page],
    files: { "settings.json": JSON.stringify({ themeLinks: [A, B, "https://cdn.example/falha.css"] }), [orphan]: "velho" },
  });
  await tick(20); // download da abertura (não bloqueia o boot)
  assert.equal(fs.existsSync(path.join(h.dataDir, orphan)), false, "órfão apagado");

  const refresh = h.handlers.handle.get("trivomod:refresh-theme-links");
  assert.deepEqual(await refresh(evil), []);
  sent.length = 0;
  const results = await refresh(trusted);
  assert.deepEqual(results.map((r) => [r.url, r.ok]), [[A, true], [B, true], ["https://cdn.example/falha.css", false]]);
  assert.match(results[2].error, /HTTP 500/);
  assert.ok(fs.existsSync(path.join(h.dataDir, "cache", "links", `${hashOf(A)}.css`)));

  const boot = h.bootData();
  const linkThemes = boot.themes.filter((t) => t.link);
  assert.deepEqual(linkThemes[0], {
    id: `link:${hashOf(A)}`,
    name: "Tema A",
    author: "Ana",
    description: "Desc",
    css: bodies[A],
    builtin: false,
    link: true,
    url: A,
  });
  assert.equal(linkThemes[1].name, "cdn.example/b.css");
  assert.equal(linkThemes.length, 2);
  assert.ok(boot.themes.some((t) => t.id === "builtin:amoled"), "os incluídos continuam");

  await tick(200); // broadcast tem debounce de 150 ms
  const change = sent.find(([c]) => c === "trivomod:themes-changed");
  assert.ok(change, "dispara themes-changed");
  assert.equal(change[1].themes.filter((t) => t.link).length, 2);
  assert.ok(Array.isArray(change[1].layouts));

  // tirou B dos ajustes: o cache de B vira órfão e some no próximo refresh
  fs.writeFileSync(path.join(h.dataDir, "settings.json"), JSON.stringify({ themeLinks: [A] }));
  await refresh(trusted);
  assert.equal(fs.existsSync(path.join(h.dataDir, "cache", "links", `${hashOf(B)}.css`)), false);
  assert.deepEqual(h.bootData().themes.filter((t) => t.link).map((t) => t.url), [A]);
});

test("temas online: sem links não acessa a rede; falha mantém o cache anterior", async () => {
  const A = "https://cdn.example/a.css";
  let calls = 0;
  const h0 = start({ fetch: async () => (calls++, cssResponse("x")) });
  await tick(20);
  assert.equal(calls, 0);

  let fail = false;
  const h = start({
    fetch: async () => (fail ? Promise.reject(new Error("offline")) : cssResponse("a{}")),
    files: { "settings.json": JSON.stringify({ themeLinks: [A] }) },
  });
  await tick(20);
  fail = true;
  const [r] = await h.handlers.handle.get("trivomod:refresh-theme-links")(trusted);
  assert.equal(r.ok, false);
  assert.equal(h.bootData().themes.find((t) => t.link).css, "a{}");
  void h0;
});

// ------------------------------------------------------------ hook de módulos
test("boot: modulesHook traz src/renderer/turbopack.js se existir, senão vazio", () => {
  const file = path.resolve(__dirname, "..", "src", "renderer", "turbopack.js");
  const boot = start().bootData();
  assert.equal(typeof boot.modulesHook, "string");
  assert.equal(boot.modulesHook, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
});

// ------------------------------------------------------------ janela nativa
test("native: sem native.js o boot segue com native null e set-frame devolve false", async () => {
  const h = start();
  assert.equal(h.bootData().info.native, null);
  assert.equal(await h.handlers.handle.get("trivomod:set-frame")(trusted, {}), false);
});

test("native: start fora do modo seguro, info no boot, set-frame só de origem confiável", async () => {
  const mk = () => {
    const calls = [];
    return {
      calls,
      start: () => calls.push("start"),
      info: () => ({ vibrancy: true }),
      setFrame: (wc, payload) => (calls.push(["setFrame", wc, payload]), "ok"),
    };
  };
  const native = mk();
  const h = start({ native, files: { "settings.json": JSON.stringify({ native: { systemAccent: true } }) } });
  assert.deepEqual(native.calls, ["start"]);
  assert.equal(native.options.settings().native.systemAccent, true);
  assert.ok(native.options.allowed.has("https://trivo.app.br"));
  assert.equal(typeof native.options.log, "function");
  assert.ok(native.options.electron.app);
  assert.deepEqual(h.bootData().info.native, { vibrancy: true });
  const sender = { id: 9 };
  assert.equal(await h.handlers.handle.get("trivomod:set-frame")({ ...evil, sender }, { a: 1 }), false);
  assert.equal(await h.handlers.handle.get("trivomod:set-frame")({ ...trusted, sender }, { a: 1 }), "ok");
  assert.deepEqual(native.calls[1], ["setFrame", sender, { a: 1 }]);

  const safe = mk();
  start({ native: safe, env: { TRIVOMOD_SAFE: "1" } });
  assert.deepEqual(safe.calls, []);
});

test("áudio aprimorado: desliga backgroundThrottling na página do Trivo e religa no modo padrão", async () => {
  const calls = [];
  const trivoWc = Object.assign(new EventEmitter(), {
    getURL: () => "https://trivo.app.br/channels/dm",
    isDestroyed: () => false,
    setBackgroundThrottling: (v) => calls.push(["trivo", v]),
  });
  const otherWc = Object.assign(new EventEmitter(), {
    getURL: () => "https://evil.example/",
    isDestroyed: () => false,
    setBackgroundThrottling: (v) => calls.push(["other", v]),
  });
  const h = start({ contents: [trivoWc, otherWc] });
  h.app.emit("web-contents-created", {}, trivoWc);
  h.app.emit("web-contents-created", {}, otherWc);

  trivoWc.emit("did-finish-load");
  otherWc.emit("did-finish-load");
  assert.deepEqual(calls, [["trivo", true]]);

  const save = h.handlers.handle.get("trivomod:save-settings");
  await save(trusted, { plugins: { "builtin:audio-aprimorado": true } });
  assert.deepEqual(calls.at(-1), ["trivo", false]);

  await save(trusted, { plugins: { "builtin:audio-aprimorado": false } });
  assert.deepEqual(calls.at(-1), ["trivo", true]);
  assert.ok(calls.every(([who]) => who === "trivo"));
});

test("ícone padrão dinâmico: boot entrega gerador e set-theme-icon respeita origem e precedência do usuário", async () => {
  const { handlers, dataDir, bootData } = harness();
  assert.match(bootData().defaultIcon, /buildIconSvg/);
  const setTheme = handlers.handle.get("trivomod:set-theme-icon");
  const setCustom = handlers.handle.get("trivomod:set-icon");
  const pngA = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)]);
  const pngB = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 3)]);
  const urlA = `data:image/png;base64,${pngA.toString("base64")}`;
  const urlB = `data:image/png;base64,${pngB.toString("base64")}`;

  assert.equal((await setTheme(evil, urlA)).ok, false);
  const okTheme = await setTheme(trusted, urlA);
  assert.equal(okTheme.ok, true);
  assert.deepEqual(fs.readFileSync(path.join(dataDir, "cache", "default-icon.png")), pngA);

  // Ícone personalizado do usuário sempre vence
  assert.equal((await setCustom(trusted, urlB)).ok, true);
  const skipped = await setTheme(trusted, urlA);
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, "custom");
  assert.deepEqual(fs.readFileSync(path.join(dataDir, "icon.png")), pngB);
});

// ------------------------------------------------------------ atualização automática pelo processo principal
const crypto = require("node:crypto");
const bundleLib = require("../src/main/bundle");
const { copyDir } = require("../installer/patch");

const SRC_DIR = path.resolve(__dirname, "..", "src");
const CUR = bundleLib.versionOf(fs.readFileSync(path.join(SRC_DIR, "version.js"), "utf8"));
const NOVA = "0.98.0";

function installedData() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-inst-"));
  copyDir(SRC_DIR, path.join(dataDir, "dist"));
  return dataDir;
}

function releaseFetch(version) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-rel-"));
  copyDir(SRC_DIR, src);
  fs.writeFileSync(path.join(src, "version.js"), `"use strict";\nmodule.exports = "${version}";\n`);
  const { buffer } = bundleLib.build(src);
  const name = bundleLib.assetName(version);
  const base = `https://github.com/baku01/TrivoMod/releases/download/v${version}`;
  const sums = Buffer.from(`${crypto.createHash("sha256").update(buffer).digest("hex")}  ${name}\n`);
  const body = (b) => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  return async (url) => {
    if (url.endsWith("/releases/latest")) {
      return body(Buffer.from(JSON.stringify({ tag_name: `v${version}`, assets: [{ name, browser_download_url: `${base}/${name}` }, { name: "SHA256SUMS.txt", browser_download_url: `${base}/SHA256SUMS.txt` }] })));
    }
    if (url === `${base}/${name}`) return body(buffer);
    if (url === `${base}/SHA256SUMS.txt`) return body(sums);
    return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
  };
}
const distVer = (dataDir, dir = "dist") => bundleLib.versionOf(fs.readFileSync(path.join(dataDir, dir, "version.js"), "utf8"));

test("atualização: rodando do código-fonte, com TRIVOMOD_NO_UPDATE ou em modo seguro fica indisponível", async () => {
  const fonte = harness();
  assert.equal((await fonte.handlers.handle.get("trivomod:update-status")(trusted)).available, false);
  assert.equal((await fonte.handlers.handle.get("trivomod:check-update")(trusted)).state, "indisponivel");
  assert.equal(await fonte.handlers.handle.get("trivomod:restart-to-update")(trusted), false);

  const desligado = harness({ dataDir: installedData(), installed: true, env: { TRIVOMOD_NO_UPDATE: "1" } });
  assert.equal((await desligado.handlers.handle.get("trivomod:update-status")(trusted)).available, false);

  const seguro = harness({ dataDir: installedData(), installed: true, env: { TRIVOMOD_SAFE: "1" } });
  assert.equal((await seguro.handlers.handle.get("trivomod:update-status")(trusted)).available, false);
  assert.equal((await seguro.handlers.handle.get("trivomod:check-update")(trusted)).state, "indisponivel");
});

test("atualização: cópia instalada baixa, avisa a página, reinicia, troca ao fechar e confirma no boot-ok", async () => {
  const dataDir = installedData();
  const sentTo = [];
  const wc = { mainFrame: { url: "https://trivo.app.br/" }, send: (...a) => sentTo.push(a) };
  const other = { mainFrame: { url: "https://evil.example/" }, send: () => assert.fail("só o Trivo recebe") };
  const h = harness({ dataDir, installed: true, fetch: releaseFetch(NOVA), contents: [wc, other] });
  const evil = { senderFrame: { parent: null, url: "https://evil.example/" } };

  const st0 = await h.handlers.handle.get("trivomod:update-status")(trusted);
  assert.equal(st0.available, true);
  assert.equal(st0.enabled, true);
  assert.equal(st0.current, CUR);
  assert.equal(await h.handlers.handle.get("trivomod:update-status")(evil), null);
  assert.equal((await h.handlers.handle.get("trivomod:check-update")(evil)).state, "indisponivel");
  assert.equal(await h.handlers.handle.get("trivomod:restart-to-update")(trusted), false, "nada baixado ainda");

  const r = await h.handlers.handle.get("trivomod:check-update")(trusted);
  assert.equal(r.state, "pronta");
  assert.deepEqual(sentTo, [["trivomod:update-ready", { version: NOVA }]]);
  assert.equal((await h.handlers.handle.get("trivomod:update-status")(trusted)).staged, NOVA);

  // Desligar nos ajustes some com "enabled", sem perder o que já baixou
  await h.handlers.handle.get("trivomod:save-settings")(trusted, { autoUpdate: false });
  assert.equal((await h.handlers.handle.get("trivomod:update-status")(trusted)).enabled, false);
  await h.handlers.handle.get("trivomod:save-settings")(trusted, { autoUpdate: true });

  assert.equal(await h.handlers.handle.get("trivomod:restart-to-update")(trusted), true);
  await new Promise((res) => setTimeout(res, 150));
  assert.deepEqual(h.lifecycle, ["relaunch", "quit"]);
  h.app.emit("will-quit");
  assert.equal(distVer(dataDir), NOVA, "trocou ao fechar");
  assert.equal(distVer(dataDir, "dist.prev"), CUR);

  // Próxima abertura roda a versão nova; o boot-ok da página confirma
  const nova = harness({ dataDir, installed: true, fetch: releaseFetch(NOVA) });
  assert.deepEqual(nova.lifecycle, []);
  assert.equal(nova.bootData().info.version, NOVA);
  assert.equal(await nova.handlers.handle.get("trivomod:boot-ok")(trusted), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "update.json"), "utf8")).pending, null);
  nova.app.emit("will-quit");
});

test("atualização: versão nova que nunca chega ao boot-ok é desfeita na 3ª abertura e o Trivo reabre", async () => {
  const dataDir = installedData();
  const h = harness({ dataDir, installed: true, fetch: releaseFetch(NOVA) });
  assert.equal((await h.handlers.handle.get("trivomod:check-update")(trusted)).state, "pronta");
  h.app.emit("will-quit");
  assert.equal(distVer(dataDir), NOVA);

  // Cada abertura "fecha" antes da próxima (will-quit solta os fs.watch, que no Windows prendem a pasta).
  for (const n of [1, 2]) {
    const aberta = harness({ dataDir, installed: true });
    assert.deepEqual(aberta.lifecycle, [], `${n}ª abertura sem boot-ok`);
    aberta.app.emit("will-quit");
  }
  const third = harness({ dataDir, installed: true });
  assert.deepEqual(third.lifecycle, ["relaunch", "exit:0"], "3ª: volta e reabre");
  assert.equal(distVer(dataDir), CUR);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8")).failedBoots, 0, "falhas da versão desfeita não levam a anterior ao modo seguro");

  const back = harness({ dataDir, installed: true, fetch: releaseFetch(NOVA) });
  assert.deepEqual(back.lifecycle, []);
  assert.equal((await back.handlers.handle.get("trivomod:check-update")(trusted)).state, "bloqueada");
});
