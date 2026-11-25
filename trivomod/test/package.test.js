"use strict";
// Monta o mesmo subconjunto de arquivos que os instaladores de release embutem (ver release.yml)
// numa pasta com espaço e acento, e roda o CLI de lá. Pega arquivo faltando no pacote e caminho
// que só funciona dentro do repositório.
const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function stagePackage() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod pacote-"));
  const app = path.join(base, "Usuário Teste", "TrivoMod");
  fs.mkdirSync(path.join(app, "installer"), { recursive: true });
  for (const item of ["bin", "src", "package.json", "README.md"]) fs.cpSync(path.join(ROOT, item), path.join(app, item), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "installer"))) {
    if (f.endsWith(".js")) fs.copyFileSync(path.join(ROOT, "installer", f), path.join(app, "installer", f));
  }
  fs.cpSync(path.join(ROOT, "installer", "ui"), path.join(app, "installer", "ui"), { recursive: true });
  return { base, app, data: path.join(base, "Dados ç", "TrivoMod") };
}

function runCli(pkg, args) {
  return cp.execFileSync(process.execPath, [path.join(pkg.app, "bin", "trivomod.js"), ...args], {
    cwd: pkg.app,
    encoding: "utf8",
    env: { ...process.env, TRIVOMOD_DIR: pkg.data },
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

test("pacote de release: CLI roda fora do repositório, em caminho com espaço e acento", (t) => {
  const pkg = stagePackage();
  t.after(() => fs.rmSync(pkg.base, { recursive: true, force: true }));

  assert.match(runCli(pkg, ["paths"]), /dados/);
  runCli(pkg, ["update"]);
  assert.ok(fs.existsSync(path.join(pkg.data, "dist", "main", "index.js")));
  assert.ok(fs.existsSync(path.join(pkg.data, "themes")));
  assert.ok(fs.existsSync(path.join(pkg.data, "plugins")));
});

test("pacote de release: instalador gráfico serve a página e o logo", async (t) => {
  const pkg = stagePackage();
  const child = cp.spawn(process.execPath, [path.join(pkg.app, "bin", "trivomod.js"), "gui", "--no-open"], {
    cwd: pkg.app,
    env: { ...process.env, TRIVOMOD_DIR: pkg.data },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill();
    fs.rmSync(pkg.base, { recursive: true, force: true });
  });

  const url = await new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`gui não subiu: ${out}${err}`)), 15_000);
    child.stdout.on("data", (c) => {
      out += c;
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.stderr.on("data", (c) => (err += c));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`gui saiu com ${code}: ${out}${err}`));
    });
  });

  assert.equal(await get(url), 200);
  assert.equal(await get(`${url}trivo-logo.webp`), 200);
});
