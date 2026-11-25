"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const cp = require("node:child_process");

const bundle = require("../src/main/bundle");
const { createUpdater, resetForManualInstall, compare, MAX_UNCONFIRMED } = require("../src/main/updater");
const settingsStore = require("../src/main/settings");
const { copyDir } = require("../installer/patch");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const CURRENT = bundle.versionOf(fs.readFileSync(path.join(SRC, "version.js"), "utf8"));
const REPO = "baku01/TrivoMod";
const versionFile = (v) => `"use strict";\nmodule.exports = "${v}";\n`;

/** Cópia de src/ com outra versão (e um ajuste opcional), empacotada como no CI. */
function makeBundle(version, tweak) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-src-"));
  copyDir(SRC, dir);
  fs.writeFileSync(path.join(dir, "version.js"), versionFile(version));
  if (tweak) tweak(dir);
  return bundle.build(dir).buffer;
}

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-dados-"));
  copyDir(SRC, path.join(dataDir, "dist"));
  return dataDir;
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** GitHub falso: /releases/latest, o pacote e o SHA256SUMS.txt. */
function fakeGithub({ version, buffer, sums, assets, assetUrl }) {
  const name = bundle.assetName(version);
  const url = assetUrl || `https://github.com/${REPO}/releases/download/v${version}/${name}`;
  const sumsUrl = `https://github.com/${REPO}/releases/download/v${version}/SHA256SUMS.txt`;
  const calls = [];
  const respond = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k === "content-length" ? String(body.length) : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
  const fetch = async (u, opts) => {
    calls.push(u);
    assert.ok(opts && opts.headers && opts.headers["User-Agent"].startsWith("TrivoMod/"));
    if (u === `https://api.github.com/repos/${REPO}/releases/latest`) {
      const list = assets || [
        { name, browser_download_url: url },
        { name: "SHA256SUMS.txt", browser_download_url: sumsUrl },
      ];
      return respond(Buffer.from(JSON.stringify({ tag_name: `v${version}`, assets: list })));
    }
    if (u === url) return respond(buffer);
    if (u === sumsUrl) return respond(Buffer.from(sums !== undefined ? sums : `${sha(buffer)}  ${name}\n${"0".repeat(64)}  outro.dmg\n`));
    return respond(Buffer.from("não achou"), 404);
  };
  return { fetch, calls };
}

const NEXT = "0.99.0";

test("updater: compara versões numericamente", () => {
  assert.equal(compare("0.1.10", "0.1.9"), 1);
  assert.equal(compare("1.0.0", "1.0.0"), 0);
  assert.equal(compare("0.2.0", "0.10.0"), -1);
  assert.throws(() => compare("v1", "1.0.0"));
});

test("bundle: o src/ do repositório empacota, valida e todo JS compila (o mesmo que o CI publica)", () => {
  const { version, buffer } = bundle.build(SRC);
  assert.equal(version, CURRENT);
  const files = bundle.validate(bundle.parse(buffer), CURRENT);
  for (const rel of bundle.REQUIRED) assert.ok(files[rel], rel);
  assert.ok(files["main/updater.js"], "o próprio atualizador vai no pacote");
  assert.ok(!Object.keys(files).some((f) => f.split("/").some((p) => p.startsWith("."))), "sem arquivos ocultos");

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "tm-out-"));
  const log = cp.execFileSync(process.execPath, [path.join(ROOT, "tools", "build-runtime.js"), out], { encoding: "utf8" });
  assert.match(log, new RegExp(bundle.assetName(CURRENT).replace(/\./g, "\\.")));
  assert.ok(fs.existsSync(path.join(out, `trivomod-runtime-v${CURRENT}.json.gz`)), "nome que o release.yml confere");
});

test("bundle: recusa caminho para fora, versão trocada, arquivo faltando e JS que não compila", () => {
  const pack = (files, version = NEXT) => ({ format: 1, version, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString("base64")])) });
  const ok = {
    "version.js": versionFile(NEXT),
    "main/index.js": "exports.start = () => {};",
    "preload/index.js": "1;",
    "renderer/index.js": "1;",
  };
  assert.ok(bundle.validate(pack(ok), NEXT));
  for (const bad of ["../fora.js", "/abs.js", "main/../../x.js", "a\\b.js", ".oculto/x.js", "main/./x.js"]) {
    assert.throws(() => bundle.validate(pack({ ...ok, [bad]: "1;" }), NEXT), /caminho recusado/, bad);
  }
  assert.throws(() => bundle.validate(pack(ok), "0.99.1"), /esperava/);
  assert.throws(() => bundle.validate(pack({ ...ok, "version.js": versionFile("0.1.0") }), NEXT), /version\.js não bate/);
  const { "preload/index.js": _omit, ...sem } = ok;
  assert.throws(() => bundle.validate(pack(sem), NEXT), /sem preload\/index\.js/);
  assert.throws(() => bundle.validate(pack({ ...ok, "renderer/index.js": "function (" }), NEXT), /não compila/);
  assert.throws(() => bundle.parse(zlib.gzipSync(Buffer.from(JSON.stringify({ format: 2 })))), /formato/);
  assert.throws(() => bundle.parse(Buffer.alloc(9 * 1024 * 1024)), /grande demais/);
});

test("updater: baixa, confere o SHA-256, valida e deixa pronta em dist.next; segunda checagem não baixa de novo", async () => {
  const dataDir = setup();
  const buffer = makeBundle(NEXT);
  const gh = fakeGithub({ version: NEXT, buffer });
  const logs = [];
  const up = createUpdater({ dataDir, currentVersion: CURRENT, fetch: gh.fetch, log: (...a) => logs.push(a.join(" ")) });

  const [r, same] = await Promise.all([up.check(), up.check()]);
  assert.equal(r, same, "verificações simultâneas viram uma só");
  assert.deepEqual({ ...r }, { state: "pronta", version: NEXT, nova: true });
  assert.equal(bundle.versionOf(fs.readFileSync(path.join(dataDir, "dist.next", "version.js"), "utf8")), NEXT);
  assert.equal(bundle.versionOf(fs.readFileSync(path.join(dataDir, "dist", "version.js"), "utf8")), CURRENT, "dist atual intacto");
  assert.ok(!fs.existsSync(path.join(dataDir, "dist.next.tmp")));
  assert.equal(up.status().staged, NEXT);
  assert.equal(gh.calls.length, 3);

  const again = await up.check();
  assert.equal(again.state, "pronta");
  assert.equal(again.nova, undefined);
  assert.equal(gh.calls.length, 4, "só consultou a release");
});

test("updater: em dia, release sem pacote e endereço fora do repositório", async () => {
  const dataDir = setup();
  const buffer = makeBundle(NEXT);

  const emDia = createUpdater({ dataDir, currentVersion: NEXT, fetch: fakeGithub({ version: NEXT, buffer }).fetch });
  assert.equal((await emDia.check()).state, "em-dia");

  const semPacote = createUpdater({ dataDir, currentVersion: CURRENT, fetch: fakeGithub({ version: NEXT, buffer, assets: [] }).fetch });
  assert.equal((await semPacote.check()).state, "sem-pacote");

  const fora = createUpdater({
    dataDir,
    currentVersion: CURRENT,
    fetch: fakeGithub({ version: NEXT, buffer, assetUrl: "https://evil.example/pacote.json.gz" }).fetch,
  });
  const r = await fora.check();
  assert.equal(r.state, "erro");
  assert.match(r.error, /fora do repositório/);
  assert.ok(!fs.existsSync(path.join(dataDir, "dist.next")));
});

test("updater: SHA-256 que não confere, pacote ausente do SHA256SUMS e erro de rede não deixam nada pronto", async () => {
  const dataDir = setup();
  const buffer = makeBundle(NEXT);
  const name = bundle.assetName(NEXT);

  const errado = createUpdater({ dataDir, currentVersion: CURRENT, fetch: fakeGithub({ version: NEXT, buffer, sums: `${"a".repeat(64)}  ${name}\n` }).fetch });
  const r1 = await errado.check();
  assert.equal(r1.state, "erro");
  assert.match(r1.error, /não confere/);

  const ausente = createUpdater({ dataDir, currentVersion: CURRENT, fetch: fakeGithub({ version: NEXT, buffer, sums: `${sha(buffer)}  outro.gz\n` }).fetch });
  assert.match((await ausente.check()).error, /não está no SHA256SUMS/);

  const offline = createUpdater({ dataDir, currentVersion: CURRENT, fetch: async () => { throw new Error("sem internet"); } });
  const r3 = await offline.check();
  assert.equal(r3.state, "erro");
  assert.equal(offline.status().lastError, "sem internet");
  assert.ok(!fs.existsSync(path.join(dataDir, "dist.next")));
});

test("updater: versão cujo processo principal não carrega é recusada antes de virar a oficial", async () => {
  const dataDir = setup();
  const buffer = makeBundle(NEXT, (dir) => {
    fs.appendFileSync(path.join(dir, "main", "settings.js"), '\nrequire("./nao-existe");\n');
  });
  const up = createUpdater({ dataDir, currentVersion: CURRENT, fetch: fakeGithub({ version: NEXT, buffer }).fetch });
  const r = await up.check();
  assert.equal(r.state, "erro");
  assert.match(r.error, /não carrega/);
  assert.ok(!fs.existsSync(path.join(dataDir, "dist.next")));
  assert.ok(!fs.existsSync(path.join(dataDir, "dist.next.tmp")));
  assert.ok(!Object.keys(require.cache).some((k) => k.includes("dist.next")), "não deixa módulos da tentativa no cache");
});

test("updater: aplica ao fechar, confirma no boot-ok e não troca para versão igual ou mais velha", async () => {
  const dataDir = setup();
  const buffer = makeBundle(NEXT);
  const up = createUpdater({ dataDir, currentVersion: CURRENT, fetch: fakeGithub({ version: NEXT, buffer }).fetch });
  assert.deepEqual({ ...up.applyPending() }, { applied: false }, "nada baixado, nada a fazer");
  await up.check();

  const applied = up.applyPending();
  assert.deepEqual({ ...applied }, { applied: true, version: NEXT, from: CURRENT });
  assert.equal(bundle.versionOf(fs.readFileSync(path.join(dataDir, "dist", "version.js"), "utf8")), NEXT);
  assert.equal(bundle.versionOf(fs.readFileSync(path.join(dataDir, "dist.prev", "version.js"), "utf8")), CURRENT);
  assert.ok(!fs.existsSync(path.join(dataDir, "dist.next")));
  assert.equal(up.status().staged, null);

  const next = createUpdater({ dataDir, currentVersion: NEXT, fetch: async () => { throw new Error("offline"); } });
  assert.equal(next.onStartup().rolledBack, false);
  assert.equal(next.confirm(), true);
  assert.equal(next.confirm(), false, "sem pendência depois de confirmar");

  // Instalador gravou uma versão mais nova enquanto havia download esperando: não volta atrás
  const old = makeBundle("0.50.0");
  const up2 = createUpdater({ dataDir, currentVersion: CURRENT, fetch: fakeGithub({ version: "0.50.0", buffer: old }).fetch });
  assert.equal((await up2.check()).state, "pronta");
  assert.equal(up2.applyPending().applied, false);
  assert.equal(bundle.versionOf(fs.readFileSync(path.join(dataDir, "dist", "version.js"), "utf8")), NEXT);
  assert.ok(!fs.existsSync(path.join(dataDir, "dist.next")), "download velho descartado");
});

test("updater: versão que não chega ao boot-ok volta sozinha para a anterior e fica bloqueada", async () => {
  const dataDir = setup();
  const buffer = makeBundle(NEXT);
  const gh = fakeGithub({ version: NEXT, buffer });
  await createUpdater({ dataDir, currentVersion: CURRENT, fetch: gh.fetch }).check();
  createUpdater({ dataDir, currentVersion: CURRENT, fetch: gh.fetch }).applyPending();

  const nova = createUpdater({ dataDir, currentVersion: NEXT, fetch: gh.fetch });
  assert.equal(nova.onStartup({ countBoot: false }).rolledBack, false, "modo seguro pedido à mão não conta");
  for (let i = 1; i < MAX_UNCONFIRMED; i++) assert.equal(nova.onStartup().rolledBack, false, `abertura ${i}`);
  const back = nova.onStartup();
  assert.deepEqual({ ...back }, { rolledBack: true, version: NEXT });
  assert.equal(bundle.versionOf(fs.readFileSync(path.join(dataDir, "dist", "version.js"), "utf8")), CURRENT, "voltou");
  assert.ok(fs.existsSync(path.join(dataDir, "dist.bad")));
  assert.deepEqual([...nova.status().blocked], [NEXT]);
  assert.match(nova.status().lastError, /voltou para a anterior/);

  // A versão velha, de volta, não baixa a bloqueada de novo
  const velha = createUpdater({ dataDir, currentVersion: CURRENT, fetch: gh.fetch });
  assert.equal(velha.onStartup().rolledBack, false);
  assert.equal((await velha.check()).state, "bloqueada");
  assert.ok(!fs.existsSync(path.join(dataDir, "dist.next")));

  // Instalação à mão limpa pendências, mas lembra o bloqueio
  fs.mkdirSync(path.join(dataDir, "dist.next"));
  resetForManualInstall(dataDir);
  assert.ok(!fs.existsSync(path.join(dataDir, "dist.next")));
  assert.deepEqual([...velha.status().blocked], [NEXT]);
});

test("updater: estado corrompido no disco vira estado vazio", () => {
  const dataDir = setup();
  fs.writeFileSync(path.join(dataDir, "update.json"), "{ quebrado");
  const up = createUpdater({ dataDir, currentVersion: CURRENT, fetch: async () => { throw new Error("x"); } });
  assert.equal(up.onStartup().rolledBack, false);
  assert.deepEqual({ ...up.status(), blocked: [...up.status().blocked] }, { current: CURRENT, staged: null, lastCheck: null, lastError: null, blocked: [] });
  fs.writeFileSync(path.join(dataDir, "update.json"), JSON.stringify({ pending: { version: "x" }, blocked: ["1.0.0", 3, "../"] }));
  assert.deepEqual([...up.status().blocked], ["1.0.0"]);
});

test("settings: atualização automática nasce ligada e respeita quem desligou", () => {
  assert.equal(settingsStore.defaults().autoUpdate, true);
  assert.equal(settingsStore.sanitize({}).autoUpdate, true);
  assert.equal(settingsStore.sanitize({ autoUpdate: false }).autoUpdate, false);
  assert.equal(settingsStore.sanitize({ autoUpdate: "não" }).autoUpdate, true);
});
