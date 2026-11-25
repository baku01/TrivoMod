"use strict";
// Aparência nativa: material por sistema, cores aceitas para a barra do casco, cor de destaque.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createNativeManager, windowsBuild, hexAccent, COLOR } = require("../src/main/native");

function fakeWc(url) {
  const wc = new EventEmitter();
  wc.getURL = () => url;
  wc.isDestroyed = () => false;
  wc.css = [];
  wc.insertCSS = async (css) => (wc.css.push(css), `k${wc.css.length}`);
  wc.removeInsertedCSS = async (key) => { wc.removed = key; };
  wc.sent = [];
  wc.scripts = [];
  wc.executeJavaScript = async (code) => { wc.scripts.push(code); };
  wc.hist = { back: false, forward: false, went: [] };
  wc.navigationHistory = { canGoBack: () => wc.hist.back, canGoForward: () => wc.hist.forward,
    goBack: () => wc.hist.went.push("back"), goForward: () => wc.hist.went.push("forward") };
  wc.send = (...a) => wc.sent.push(a);
  return wc;
}

function setup(platform, release = "10.0.22631", nativeSettings = {}) {
  const page = fakeWc("https://trivo.app.br/channels/dm");
  const bar = fakeWc("trivo-shell://app/barra.html?plataforma=x");
  const calls = [];
  const view = (wc) => ({ webContents: wc, setBackgroundColor: (c) => calls.push(["view", c]) });
  const win = {
    contentView: { children: [view(page), view(bar)] },
    setVibrancy: (v) => calls.push(["vibrancy", v]),
    setBackgroundMaterial: (m) => calls.push(["material", m]),
    setBackgroundColor: (c) => calls.push(["win", c]),
  };
  const app = new EventEmitter();
  const systemPreferences = Object.assign(new EventEmitter(), { getAccentColor: () => "0a84ffff", subscribeNotification: () => 1 });
  const all = [page, bar];
  const electron = { app, systemPreferences, BaseWindow: { getAllWindows: () => [win] }, webContents: { getAllWebContents: () => all } };
  const m = createNativeManager({ electron, platform, release, allowed: new Set(["https://trivo.app.br"]), settings: () => ({ native: nativeSettings }) });
  m.start();
  app.emit("web-contents-created", {}, page);
  return { m, page, bar, calls, systemPreferences, app, all };
}

test("material: translucidez no macOS, Mica só no Windows 11 22H2+, nada no Linux", () => {
  let s = setup("darwin");
  s.page.emit("dom-ready");
  assert.deepEqual(s.calls.filter((c) => c[0] !== "view"), [["vibrancy", "sidebar"], ["win", "#00000000"]]);
  assert.equal(s.calls.filter((c) => c[0] === "view").length, 2);
  s.page.emit("dom-ready");
  assert.equal(s.calls.filter((c) => c[0] === "vibrancy").length, 1, "uma vez por janela");

  s = setup("win32", "10.0.22631");
  s.page.emit("dom-ready");
  assert.ok(s.calls.some((c) => c[0] === "material" && c[1] === "mica"));
  s = setup("win32", "10.0.19045");
  s.page.emit("dom-ready");
  assert.equal(s.calls.length, 0, "Windows 10: sem material");
  s = setup("linux", "6.1");
  s.page.emit("dom-ready");
  assert.equal(s.calls.length, 0);
  s = setup("darwin", undefined, { translucent: false });
  s.page.emit("dom-ready");
  assert.equal(s.calls.length, 0, "translucidez desligada nos ajustes");
});

test("barra do casco: só aceita cores calculadas; nada de url(), var() ou ';'", async () => {
  const s = setup("win32");
  assert.equal(await s.m.setFrame(s.page, { background: "rgb(30, 31, 34)", text: "color(srgb 0.8 0.8 0.9 / 0.5)" }), true);
  const css = s.bar.css.at(-1);
  assert.match(css, /--fundo: rgb\(30, 31, 34\)/);
  assert.match(css, /Segoe UI Variable/);
  assert.match(css, /width: 46px/);
  await s.m.setFrame(s.page, { background: "red; } body { background: url(https://x)", text: "#fff" });
  const evil = s.bar.css.at(-1);
  assert.ok(!evil.includes("url("), "cor maliciosa descartada");
  assert.equal(s.bar.removed, "k1", "troca o CSS anterior");
  for (const ok of ["#1e1f22", "#1e1f2280", "rgba(0, 0, 0, 0.5)", "color(srgb 0.1 0.2 0.3)"]) assert.ok(COLOR.test(ok), ok);
  for (const bad of ["var(--x)", "url(a)", "red;x", "expression(1)"]) assert.ok(!COLOR.test(bad), bad);
});

test("cor de destaque do sistema e versões do Windows", () => {
  assert.equal(hexAccent("0a84ffff"), "#0a84ff");
  assert.equal(hexAccent("nope"), null);
  assert.equal(windowsBuild("10.0.22631"), 22631);
  assert.equal(windowsBuild("6.1.7601"), 0);
  const s = setup("darwin");
  const info = s.m.info();
  assert.equal(info.material, "vibrancy");
  assert.equal(info.systemAccentColor, "#0a84ff");
  assert.equal(info.enabled, true);
});

test("barra do casco: título e botões validados; clique volta para a página", async () => {
  const s = setup("darwin");
  await s.m.setFrame(s.page, {
    background: "#2c2d32", text: "#fff", title: "Amigos", titleIcon: "M4 4h16\" onload=x", nav: [{ id: "voltar", disabled: true }, { id: "rm -rf" }],
    buttons: [
      { id: "avisos", label: "Avisos", icon: "M6 8a6 6 0 0 1 12 0", badge: "3" },
      { id: "x", label: "<img src=x onerror=alert(1)>", icon: "javascript:alert(1)" },
      { id: "Mau Id", label: "a", icon: "M0 0" },
    ],
  });
  const code = s.bar.scripts.at(-1);
  const data = JSON.parse(/const d = (\{.*?\});\n/s.exec(code)[1]);
  assert.equal(data.title, "Amigos");
  assert.deepEqual(data.buttons.map((b) => b.id), ["avisos"]);
  assert.equal(data.titleIcon, "", "ícone com caractere estranho é descartado");
  assert.deepEqual(data.nav, [{ id: "voltar", label: "Voltar", disabled: true }]);
  assert.ok(!code.includes("innerHTML"));
  const ev = { prevented: false, preventDefault() { this.prevented = true; } };
  s.bar.emit("will-navigate", ev, "trivo-casco://trivomod/avisos");
  assert.ok(ev.prevented);
  assert.deepEqual(s.page.sent.at(-1), ["trivomod:frame-action", "avisos"]);
  const other = { prevented: false, preventDefault() { this.prevented = true; } };
  s.bar.emit("will-navigate", other, "trivo-casco://barra/fechar");
  assert.equal(other.prevented, false, "as ações do Trivo seguem para o Trivo");
});

test("setas: estado e navegação pelo histórico da página, no processo principal", async () => {
  const s = setup("darwin");
  s.page.hist.back = true;
  await s.m.setFrame(s.page, { background: "#000", text: "#fff", nav: [{ id: "voltar" }, { id: "avancar" }] });
  const data = JSON.parse(/const d = (\{.*?\});\n/s.exec(s.bar.scripts.at(-1))[1]);
  assert.deepEqual(data.nav.map((b) => b.disabled), [false, true]);
  s.bar.emit("will-navigate", { preventDefault() {} }, "trivo-casco://trivomod/voltar");
  s.bar.emit("will-navigate", { preventDefault() {} }, "trivo-casco://trivomod/avancar");
  assert.deepEqual(s.page.hist.went, ["back"], "avançar sem histórico não faz nada");
});

test("telas do casco (permissões) recebem as cores do tema", async () => {
  const s = setup("darwin");
  const dlg = fakeWc("trivo-shell://app/dialogo.html?tema=brasa");
  s.page.emit("dom-ready");
  const electronApp = s.app;
  await s.m.setFrame(s.page, { background: "#000", text: "#fff", colors: { fundo: "rgb(1, 2, 3)", cartao: "rgb(43, 45, 49)", forte: "#ffffff", acento: "rgb(88, 101, 242)", borda: "url(x)" } });
  s.all.push(dlg);
  electronApp.emit("web-contents-created", {}, dlg);
  dlg.emit("dom-ready");
  await new Promise((r) => setImmediate(r));
  const css = dlg.css.at(-1) || "";
  assert.match(css, /--cartao: rgb\(43, 45, 49\)/);
  assert.match(css, /--acento: rgb\(88, 101, 242\)/);
  assert.ok(!css.includes("url("));
});

test("telas do casco: seletor de tela e carregamento com as variáveis certas; paleta salva para a próxima abertura", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tm-pal-")), "cache", "palette.json");
  const { app, systemPreferences } = { app: new EventEmitter(), systemPreferences: Object.assign(new EventEmitter(), { getAccentColor: () => null }) };
  const page = fakeWc("https://trivo.app.br/channels/dm");
  const bar = fakeWc("trivo-shell://app/barra.html");
  const win = { contentView: { children: [{ webContents: page, setBackgroundColor() {} }, { webContents: bar, setBackgroundColor() {} }] }, setBackgroundColor() {} };
  const all = [page, bar];
  const electron = { app, systemPreferences, BaseWindow: { getAllWindows: () => [win] }, webContents: { getAllWebContents: () => all } };
  const mk = () => createNativeManager({ electron, platform: "darwin", allowed: new Set(["https://trivo.app.br"]), paletteFile: file, settings: () => ({}) });
  const m = mk();
  m.start();
  await m.setFrame(page, { background: "rgb(44, 45, 50)", text: "#fff", colors: { pagina: "rgb(50, 51, 57)", cartao: "rgb(43, 45, 49)", forte: "#ffffff", acento: "rgb(88, 101, 242)" } });
  assert.ok(fs.existsSync(file), "paleta gravada");

  // Nova abertura: a tela de carregamento e a barra já saem com as cores, antes de a página falar.
  const app2 = new EventEmitter();
  const e2 = { ...electron, app: app2 };
  const m2 = createNativeManager({ electron: e2, platform: "darwin", allowed: new Set(["https://trivo.app.br"]), paletteFile: file, settings: () => ({}) });
  m2.start();
  const boot = fakeWc("trivo-shell://app/inicializacao.html?tema=escuro");
  const picker = fakeWc("trivo-shell://app/picker.html");
  const bar2 = fakeWc("trivo-shell://app/barra.html?plataforma=darwin");
  for (const wc of [boot, picker, bar2]) { app2.emit("web-contents-created", {}, wc); wc.emit("dom-ready"); }
  await new Promise((r) => setImmediate(r));
  assert.match(boot.css.at(-1), /--fundo: rgb\(50, 51, 57\)/);
  assert.match(picker.css.at(-1), /--accent: rgb\(88, 101, 242\)/);
  assert.match(picker.css.at(-1), /--bg: rgb\(43, 45, 49\)/);
  assert.match(bar2.css.at(-1), /--fundo: rgb\(44, 45, 50\)/);
});

test("toHex converte as cores calculadas", () => {
  const { toHex } = require("../src/main/native");
  assert.equal(toHex("rgb(50, 51, 57)"), "#323339");
  assert.equal(toHex("color(srgb 1 0 0.5)"), "#ff0080");
  assert.equal(toHex("#abcdef"), "#abcdef");
  assert.equal(toHex("var(--x)"), null);
});
