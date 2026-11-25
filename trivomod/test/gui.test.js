"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

process.env.TRIVOMOD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-gui-"));
delete process.env.TRIVOMOD_GUI_EXIT;
const gui = require("../installer/gui");
const win = require("../installer/window");
const bump = require("../tools/bump-version");

function call(server, { method = "POST", route, headers = {}, body, host }) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: route, method, headers: { Host: host || `127.0.0.1:${port}`, ...(data ? { "content-type": "application/json" } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

test("gui: página traz token e CSP com nonce, e recusa Host estranho", async () => {
  const { server, token, close } = await gui.start({ open: false });
  try {
    const page = await call(server, { method: "GET", route: "/" });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(token), "token embutido");
    assert.ok(!/__(TOKEN|NONCE|VERSION|PLATFORM)__/.test(page.text), "todos os marcadores trocados");
    assert.match(page.text, /<html lang="pt-BR" data-platform="(mac|win|linux)">/);
    const nonce = /nonce="([^"]+)"/.exec(page.text)[1];
    assert.ok(page.headers["content-security-policy"].includes(`'nonce-${nonce}'`));
    assert.ok(!/unsafe-inline|unsafe-eval/.test(page.headers["content-security-policy"]));

    const logo = await call(server, { method: "GET", route: "/trivo-logo.webp" });
    assert.equal(logo.status, 200);
    assert.equal(logo.headers["content-type"], "image/webp");
    assert.ok(page.text.includes('src="/trivo-logo.webp"') && !page.text.includes(">TM<"));

    const rebinding = await call(server, { method: "GET", route: "/", host: "evil.example" });
    assert.equal(rebinding.status, 421);
  } finally {
    close();
  }
});

test("gui: a API exige POST, token certo e origem própria", async () => {
  const { server, token, close } = await gui.start({ open: false });
  const { port } = server.address();
  try {
    assert.equal((await call(server, { method: "GET", route: "/api/installs" })).status, 405);
    assert.equal((await call(server, { route: "/api/installs", body: {} })).status, 403);
    assert.equal((await call(server, { route: "/api/installs", body: {}, headers: { "x-trivomod-token": "errado" } })).status, 403);
    const crossSite = await call(server, { route: "/api/installs", body: {}, headers: { "x-trivomod-token": token, origin: "https://evil.example" } });
    assert.equal(crossSite.status, 403);

    const ok = await call(server, { route: "/api/installs", body: {}, headers: { "x-trivomod-token": token, origin: `http://127.0.0.1:${port}` } });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).ok, true);
    assert.equal((await call(server, { route: "/api/nao-existe", body: {}, headers: { "x-trivomod-token": token } })).status, 200); // erro vem no corpo
    assert.equal(JSON.parse((await call(server, { route: "/api/nao-existe", body: {}, headers: { "x-trivomod-token": token } })).text).ok, false);
  } finally {
    close();
  }
});

test("gui: não instala em caminho desconhecido nem aceita pasta que não é o Trivo", async () => {
  const { server, token, close } = await gui.start({ open: false });
  const h = { "x-trivomod-token": token };
  try {
    const bad = JSON.parse((await call(server, { route: "/api/install", body: { app: "/tmp" }, headers: h })).text);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "unknown-install");
    assert.ok(bad.error && bad.hint && bad.detail, "erro traz texto curto, próximo passo e detalhe técnico");
    const traversal = JSON.parse((await call(server, { route: "/api/uninstall", body: { app: "/etc/../etc" }, headers: h })).text);
    assert.equal(traversal.ok, false);
    const add = JSON.parse((await call(server, { route: "/api/add", body: { app: os.tmpdir() }, headers: h })).text);
    assert.equal(add.ok, false);
    assert.equal(add.code, "not-trivo");
    assert.ok(!/asar|--app/.test(add.error + add.hint), "sem jargão no texto principal");
    const big = await call(server, { route: "/api/add", body: { app: "x".repeat(10000) }, headers: h }).catch((e) => e);
    assert.ok(big instanceof Error || big.status !== 200, "corpo grande demais é cortado");
  } finally {
    close();
  }
});

test("gui: ciclo real de desinstalar/instalar na cópia de teste (se existir)", async (t) => {
  const shared = path.resolve(__dirname, "..", "..", ".dl", "test", "Trivo.app");
  if (!fs.existsSync(shared)) return t.skip("cópia de teste ausente");
  // Clone próprio (APFS: instantâneo) para não brigar com outra execução da suíte usando a mesma cópia.
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-gui-app-")), "Trivo.app");
  if (process.platform === "darwin") require("node:child_process").execFileSync("/bin/cp", ["-cR", shared, copy]);
  else fs.cpSync(shared, copy, { recursive: true, verbatimSymlinks: true });
  t.after(() => fs.rmSync(path.dirname(copy), { recursive: true, force: true }));
  const { server, token, close } = await gui.start({ open: false });
  const h = { "x-trivomod-token": token };
  const post = async (route, body) => JSON.parse((await call(server, { route, body, headers: h })).text);
  try {
    assert.equal((await post("/api/add", { app: copy })).ok, true);
    const find = async () => (await post("/api/installs")).installs.find((i) => i.app === copy);
    if ((await find()).patched) assert.equal((await post("/api/uninstall", { app: copy })).ok, true);
    assert.equal((await find()).patched, false);
    assert.equal((await post("/api/install", { app: copy })).ok, true);
    const after = await find();
    assert.equal(after.patched, true);
    assert.equal(after.integrityConsistent, true);
  } finally {
    close();
  }
});

test("gui: fecha sozinho depois que a página some", async () => {
  const { server, token, close } = await gui.start({ open: false, idleMs: 50 });
  const closed = new Promise((resolve) => server.once("close", resolve));
  await call(server, { route: "/api/ping", body: {}, headers: { "x-trivomod-token": token } });
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error("não fechou")), 6000))]);
  close();
});

test("gui: erros viram texto curto com próximo passo, por sistema", () => {
  const running = gui.explain(new Error("O Trivo está aberto. Feche-o (inclusive na bandeja/barra de menu) e tente de novo."), "mac");
  assert.equal(running.code, "running");
  assert.match(running.hint, /Cmd\+Q/);
  assert.doesNotMatch(gui.explain(new Error("O Trivo está aberto."), "win").hint, /Cmd/);
  const perm = gui.explain(Object.assign(new Error("EPERM: operation not permitted, open 'app.asar'"), { code: "EPERM" }), "mac");
  assert.equal(perm.code, "permission");
  assert.match(perm.hint, /Gerenciamento de Apps/);
  assert.equal(gui.explain(new Error("Sem backup do asar original; nada a restaurar.")).code, "no-backup");
  assert.equal(gui.explain(new Error("Command failed: /usr/bin/codesign --verify")).code, "sign");
  const other = gui.explain(new Error("qualquer coisa"));
  assert.equal(other.code, "unknown");
  const notTrivoLinux = gui.explain(new Error("Não achei o Trivo"), "linux");
  assert.equal(notTrivoLinux.code, "not-trivo");
  for (const e of [running, perm, other, notTrivoLinux]) assert.doesNotMatch(e.error + e.hint, /asar|integridade|hash/i);
});

test("window: aceita só URL loopback, monta argumentos --app e fecha ao encerrar o processo", () => {
  assert.equal(win.isLoopbackUrl("http://127.0.0.1:4321/"), true);
  assert.equal(win.isLoopbackUrl("https://evil.example/"), false);
  assert.equal(win.isLoopbackUrl("file:///etc/passwd"), false);
  assert.throws(() => win.openWindow("https://evil.example/"), /127\.0\.0\.1/);

  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  assert.equal(
    win.findAppHost("win32", { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, (p) => p === edge),
    edge,
  );
  const args = win.appWindowArgs("http://127.0.0.1:5555/", "/tmp/prof", 620, 700);
  assert.ok(args.includes("--app=http://127.0.0.1:5555/"));
  assert.ok(args.includes("--window-size=620,700"));
  assert.ok(args.includes("--user-data-dir=/tmp/prof"));

  let closed = false;
  let spawned = null;
  const fakeChild = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; } });
  const handle = win.openWindow("http://127.0.0.1:5555/", {
    platform: "win32",
    env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    exists: (p) => p === edge,
    spawn: (cmd, a) => ((spawned = { cmd, args: a }), fakeChild),
    onClose: () => { closed = true; },
  });
  assert.equal(handle.kind, "win-app");
  assert.equal(spawned.cmd, edge);
  fakeChild.emit("exit", 0);
  assert.equal(closed, true);
});

test("window (macOS): compila window-mac.swift sem erros (se Xcode CLT estiver presente)", (t) => {
  if (process.platform !== "darwin") return t.skip("somente macOS");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-swift-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const bin = win.ensureMacBinary(cacheDir);
  if (!bin) return t.skip("Xcode CLT indisponível");
  assert.ok(fs.existsSync(bin), "binário Swift compilado");
  assert.ok(win.macJxaScript("http://127.0.0.1:5555/", 620, 700).includes("WKWebView"));
});

test("window: prefere binário pré-compilado entregue na release", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-bin-"));
  try {
    const univ = path.join(dir, "trivomod-window-darwin");
    fs.writeFileSync(univ, "");
    assert.equal(win.findBundledMacBinary(dir, "arm64"), univ);
    const archBin = path.join(dir, "trivomod-window-darwin-arm64");
    fs.writeFileSync(archBin, "");
    assert.equal(win.findBundledMacBinary(dir, "arm64"), archBin);
    assert.equal(win.ensureMacBinary(undefined, { binDir: dir }), win.findBundledMacBinary(dir, process.arch));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bump-version: incrementa patch/minor/major/auto e sincroniza package.json + version.js", () => {
  assert.equal(bump.nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(bump.nextVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(bump.nextVersion("0.1.0", "major"), "1.0.0");
  assert.equal(bump.nextVersion("0.1.0", "auto", "fix: corrige menu"), "0.1.1");
  assert.equal(bump.nextVersion("0.1.0", "auto", "feat: janela nativa"), "0.2.0");
  assert.equal(bump.nextVersion("0.1.0", "auto", "feat!: muda formato"), "1.0.0");
  assert.equal(bump.nextVersion("0.1.0", "v2.3.4"), "2.3.4");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-ver-"));
  try {
    const pkgFile = path.join(dir, "package.json");
    const verFile = path.join(dir, "version.js");
    fs.writeFileSync(pkgFile, JSON.stringify({ name: "trivomod", version: "0.1.0" }, null, 2));
    assert.equal(bump.applyVersion("0.2.0", { pkgFile, verFile }), "0.2.0");
    assert.equal(JSON.parse(fs.readFileSync(pkgFile, "utf8")).version, "0.2.0");
    assert.equal(require(verFile), "0.2.0");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
