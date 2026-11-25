"use strict";
// Suporte a Windows, testável em qualquer sistema: o tipo do alvo vem do conteúdo da pasta.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const asar = require("../installer/asar");
const winexe = require("../installer/winexe");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function fakeExe(hash, { twice = false } = {}) {
  const res = `[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${hash}"}]`;
  const parts = [Buffer.from("MZ" + "\0".repeat(5000)), Buffer.from(res, "latin1"), Buffer.alloc(3000)];
  if (twice) parts.push(Buffer.from(res, "latin1"));
  return Buffer.concat(parts);
}

function fakeInstall(name = "@trivo/desktop") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-win-"));
  const a = asar.pack({
    "package.json": Buffer.from(JSON.stringify({ name, main: "dist/main/principal.js", version: "1.0.8" })),
    "dist/main/principal.js": Buffer.from("// app"),
  });
  fs.mkdirSync(path.join(dir, "Trivo", "resources"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Trivo", "resources", "app.asar"), a);
  fs.writeFileSync(path.join(dir, "Trivo", "Trivo.exe"), fakeExe(asar.integrityHash(asar.parse(a).headerString)));
  return { dir, app: path.join(dir, "Trivo") };
}

function freshPatch(dataDir) {
  process.env.TRIVOMOD_DIR = dataDir;
  for (const m of ["../installer/patch", "../src/paths"]) delete require.cache[require.resolve(m)];
  return require("../installer/patch");
}

test("winexe: lê e troca o hash no lugar, sem mudar o tamanho", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-exe-"));
  const exe = path.join(dir, "Trivo.exe");
  const h1 = sha("a");
  const h2 = sha("b");
  fs.writeFileSync(exe, fakeExe(h1));
  const before = fs.readFileSync(exe);
  assert.equal(winexe.readIntegrity(exe).hash, h1);
  assert.equal(winexe.writeIntegrity(exe, h2), true);
  const after = fs.readFileSync(exe);
  assert.equal(after.length, before.length);
  assert.equal(winexe.readIntegrity(exe).hash, h2);
  let diff = 0;
  for (let i = 0; i < after.length; i += 1) if (after[i] !== before[i]) diff += 1;
  assert.ok(diff > 0 && diff <= 64);
  assert.equal(winexe.writeIntegrity(exe, h2), false, "idempotente");
});

test("winexe: recusa executável sem o recurso, com o recurso repetido ou hash inválido", () => {
  assert.throws(() => winexe.findIntegrity(Buffer.from("MZ nada aqui")), /Não achei/);
  assert.throws(() => winexe.findIntegrity(fakeExe(sha("x"), { twice: true })), /mais de uma vez/);
  assert.throws(() => winexe.findIntegrity(fakeExe("z".repeat(64))), /formato inesperado/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-exe-"));
  fs.writeFileSync(path.join(dir, "T.exe"), fakeExe(sha("a")));
  assert.throws(() => winexe.writeIntegrity(path.join(dir, "T.exe"), "nao-e-hash"));
});

test("windows: install grava o hash novo no .exe e uninstall devolve tudo byte a byte", () => {
  const { dir, app } = fakeInstall();
  const patch = freshPatch(path.join(dir, "data"));
  const exe = path.join(app, "Trivo.exe");
  const asarPath = path.join(app, "resources", "app.asar");
  const exe0 = sha(fs.readFileSync(exe));
  const asar0 = sha(fs.readFileSync(asarPath));

  assert.equal(patch.status({ app }).kind, "win");
  const r = patch.install({ app });
  const st = patch.status({ app });
  assert.equal(st.patched, true);
  assert.equal(st.exeHash, r.hash);
  assert.equal(st.integrityConsistent, true);
  const pkg = JSON.parse(asar.readFile(fs.readFileSync(asarPath), "package.json"));
  assert.equal(pkg.main, patch.LOADER);
  assert.ok(asar.lookup(asar.parse(fs.readFileSync(asarPath)).header, patch.LOADER).integrity, "loader com integrity por arquivo");

  patch.install({ app }); // reparar: parte do backup, mesmo resultado
  assert.equal(patch.status({ app }).exeHash, r.hash);

  patch.uninstall({ app });
  assert.equal(sha(fs.readFileSync(exe)), exe0);
  assert.equal(sha(fs.readFileSync(asarPath)), asar0);
  assert.equal(fs.existsSync(asarPath + ".original"), false);
});

test("windows: aceita o caminho do Trivo.exe e recusa outro app Electron", () => {
  const { dir, app } = fakeInstall();
  const patch = freshPatch(path.join(dir, "data"));
  assert.equal(patch.status({ app: path.join(app, "Trivo.exe") }).app, app);
  assert.equal(patch.discover([app]).installs.length >= 1, true);

  const other = fakeInstall("outro-app");
  assert.throws(() => patch.install({ app: other.app }), /não é o Trivo/);
  assert.equal(patch.discover([other.app]).installs.some((i) => i.app === other.app), false);
});

test("windows: o Trivo.exe real (se baixado) tem o hash do app.asar real", (t) => {
  const app = path.resolve(__dirname, "..", "..", ".dl", "win", "app");
  if (!fs.existsSync(path.join(app, "Trivo.exe"))) return t.skip("instalador do Windows não extraído");
  const { headerString } = asar.parse(fs.readFileSync(path.join(app, "resources", "app.asar")));
  assert.equal(winexe.readIntegrity(path.join(app, "Trivo.exe")).hash, asar.integrityHash(headerString));
});

test("install: com o Trivo atualizado por fora (sobrou cópia velha do original), parte do app atual", () => {
  const { app } = fakeInstall();
  const patch = freshPatch(fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-data-")));
  const file = path.join(app, "resources", "app.asar");
  patch.install({ app, force: true });
  // "Atualização": app.asar novo e sem o mod; a cópia .original da versão anterior ficou para trás.
  const novo = asar.pack({
    "package.json": Buffer.from(JSON.stringify({ name: "@trivo/desktop", main: "dist/main/principal.js", version: "1.0.9" })),
    "dist/main/principal.js": Buffer.from("// app novo"),
  });
  fs.writeFileSync(file, novo);
  winexe.writeIntegrity(path.join(app, "Trivo.exe"), asar.integrityHash(asar.parse(novo).headerString));
  patch.install({ app, force: true });
  assert.deepEqual(fs.readFileSync(file + ".original"), novo, "a cópia do original passa a ser a versão nova");
  assert.equal(asar.readFile(fs.readFileSync(file), "dist/main/principal.js").toString(), "// app novo");
  patch.uninstall({ app, force: true });
  assert.deepEqual(fs.readFileSync(file), novo);
});

test("discover: uma instalação com problema aparece com o erro, sem derrubar a lista", () => {
  const { app } = fakeInstall();
  const patch = freshPatch(fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-data-")));
  const file = path.join(app, "resources", "app.asar");
  fs.copyFileSync(file, file + ".original"); // cópia boa do original...
  fs.writeFileSync(file, Buffer.from("app.asar estragado")); // ...e o app danificado
  const { installs } = patch.discover([app]);
  const mine = installs.find((i) => i.app === app);
  assert.ok(mine, "continua na lista");
  assert.ok(mine.error, "com o erro");
});
