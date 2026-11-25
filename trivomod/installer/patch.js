"use strict";
// Instalador do TrivoMod. Faz o mesmo que o instalador do Vencord faz no Discord:
//   1. troca a entrada do app por um loader minúsculo;
//   2. o loader carrega o mod (de uma pasta do usuário) e SÓ DEPOIS o app original.
//
// O Trivo é Electron com `OnlyLoadAppFromAsar` e `EnableEmbeddedAsarIntegrityValidation`,
// então não dá para trocar `app.asar` por uma pasta. Em vez disso o asar é
// regravado (ver asar.js) e o hash em `Info.plist` é atualizado. No macOS isso
// invalida a assinatura do pacote, e ela é refeita (ad-hoc, preservando as
// entitlements e o hardened runtime).
//
// No Windows o hash fica num recurso do Trivo.exe; ele é trocado no lugar (ver winexe.js).

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const asar = require("./asar");
const winexe = require("./winexe");
const { dataDir } = require("../src/paths");

const BUNDLE_ID = "br.app.trivo.desktop";
const PACKAGE_NAME = "@trivo/desktop";
const LOADER = "trivomod-loader.js";
const BACKUP_SUFFIX = ".original";
const SRC = path.resolve(__dirname, "..", "src");

function run(cmd, args) {
  return cp.execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ---------------------------------------------------------------- alvo

function defaultLocations() {
  if (process.platform === "darwin") return ["/Applications/Trivo.app", path.join(os.homedir(), "Applications", "Trivo.app")];
  if (process.platform === "win32") return winexe.candidateDirs();
  return ["/opt/Trivo", "/usr/lib/trivo", path.join(os.homedir(), "Trivo")];
}

/** O tipo vem do que a pasta contém, não do sistema: assim a pasta do Windows também é testável no macOS/Linux. */
function targetAt(raw) {
  let root = path.resolve(raw);
  if (/\.exe$/i.test(root)) root = path.dirname(root); // aceita o caminho do Trivo.exe
  const macAsar = path.join(root, "Contents", "Resources", "app.asar");
  if (fs.existsSync(macAsar)) return { kind: "mac", root, asar: macAsar, plist: path.join(root, "Contents", "Info.plist") };
  const asarPath = path.join(root, "resources", "app.asar");
  if (!fs.existsSync(asarPath)) return null;
  const exe = path.join(root, "Trivo.exe");
  if (fs.existsSync(exe)) return { kind: "win", root, asar: asarPath, exe };
  return { kind: "unix", root, asar: asarPath };
}

function resolveTarget(appArg) {
  for (const raw of appArg ? [appArg] : defaultLocations()) {
    const t = targetAt(raw);
    if (t) return t;
  }
  throw new Error(
    `Não achei o Trivo${appArg ? ` em ${appArg}` : ""}. Passe o caminho com --app (o .app no macOS; no Windows e no Linux, a pasta que contém resources\\app.asar).`,
  );
}

function assertIsTrivo(t) {
  if (t.kind === "mac") {
    const id = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", t.plist]).trim();
    if (id !== BUNDLE_ID) throw new Error(`${t.root} não é o Trivo (CFBundleIdentifier=${id}).`);
    return;
  }
  const source = fs.existsSync(t.asar + BACKUP_SUFFIX) ? t.asar + BACKUP_SUFFIX : t.asar;
  let name;
  try {
    name = JSON.parse(asar.readFile(fs.readFileSync(source), "package.json").toString("utf8")).name;
  } catch {
    throw new Error(`${t.root} não parece ser o Trivo (app.asar ilegível).`);
  }
  if (name !== PACKAGE_NAME) throw new Error(`${t.root} não é o Trivo (package.json name=${name}).`);
  if (t.kind === "win") winexe.readIntegrity(t.exe); // falha cedo se o .exe não tiver o recurso esperado
}

function isRunning(t) {
  if (t.kind === "win") return winexe.isRunning(t.root);
  if (t.kind !== "mac") return false;
  try {
    return run("/usr/bin/pgrep", ["-f", path.join(t.root, "Contents", "MacOS", "Trivo")]).trim() !== "";
  } catch (e) {
    if (e.status === 1) return false; // pgrep sem resultado
    throw e;
  }
}

function assertNotRunning(t, force) {
  if (!force && isRunning(t)) throw new Error("O Trivo está aberto. Feche-o (inclusive na bandeja/barra de menu) e tente de novo.");
}

// ---------------------------------------------------------------- peças

function loaderSource(originalMain, dir) {
  return `"use strict";
// Gerado pelo instalador do TrivoMod. Não edite; rode "trivomod install" de novo.
// Carrega o mod primeiro (ele precisa registrar os hooks antes de qualquer janela)
// e depois o app original. Se o mod falhar, o Trivo abre normalmente.
const path = require("node:path");
try {
  const dir = process.env.TRIVOMOD_DIR || ${JSON.stringify(dir)};
  require(path.join(dir, "dist", "main", "index.js")).start({ dataDir: dir, appPath: __dirname });
} catch (error) {
  console.error("[TrivoMod] não carregou; seguindo sem o mod:", error);
}
require(${JSON.stringify("./" + originalMain.replace(/^\.\//, ""))});
`;
}

function setPlistHash(t, hash) {
  run("/usr/libexec/PlistBuddy", ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`, t.plist]);
}

// ---------------------------------------------------------------- ícone do app (macOS)
const ICON_ORIGINAL_SUFFIX = ".trivomod-original";
const bundleIcns = (t) => path.join(t.root, "Contents", "Resources", "icon.icns");

/** Põe o ícone ativo no pacote (<dados>/icon.icns vence; senão usa <dados>/cache/default-icon.icns), guardando o original. Antes de reassinar. */
function applyBundleIcon(t, dir = dataDir()) {
  if (t.kind !== "mac") return false;
  const custom = path.join(dir, "icon.icns");
  const fallback = path.join(dir, "cache", "default-icon.icns");
  const chosen = fs.existsSync(custom) ? custom : fs.existsSync(fallback) ? fallback : null;
  const target = bundleIcns(t);
  if (!chosen || !fs.existsSync(target)) return false;
  if (!fs.existsSync(target + ICON_ORIGINAL_SUFFIX)) fs.copyFileSync(target, target + ICON_ORIGINAL_SUFFIX);
  fs.copyFileSync(chosen, `${target}.tmp`);
  fs.renameSync(`${target}.tmp`, target);
  return true;
}

/** Devolve o ícone original ao pacote. Antes de reassinar (o backup também sai do selo). */
function restoreBundleIcon(t) {
  if (t.kind !== "mac") return false;
  const target = bundleIcns(t);
  if (!fs.existsSync(target + ICON_ORIGINAL_SUFFIX)) return false;
  fs.renameSync(target + ICON_ORIGINAL_SUFFIX, target);
  return true;
}

/** Grava o hash esperado do app.asar onde o Electron o procura nesta plataforma. */
function setIntegrity(t, hash) {
  if (t.kind === "mac") {
    setPlistHash(t, hash);
    resign(t);
  } else if (t.kind === "win") {
    winexe.writeIntegrity(t.exe, hash);
  }
}

function getPlistHash(t) {
  return run("/usr/libexec/PlistBuddy", ["-c", "Print :ElectronAsarIntegrity:Resources/app.asar:hash", t.plist]).trim();
}

function resign(t) {
  if (t.kind !== "mac") return;
  // Sem --deep: só o selo do pacote externo muda; os helpers e frameworks continuam com a assinatura própria.
  run("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--preserve-metadata=identifier,entitlements,requirements,flags,runtime",
    t.root,
  ]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", t.root]);
}

function writeAtomic(file, buf) {
  const tmp = `${file}.trivomod-tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

/**
 * Cópia recursiva de pasta. Não usa `fs.cpSync`: no Windows (Node 22) ele corrompe caminhos não-ASCII
 * (`Usuário` vira `UsuÃ¡rio`), e o caminho dos dados inclui o nome do usuário (ex.: C:\Users\João).
 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

/** Copia `src/` para `<dados>/dist`, sem tocar em temas, plugins ou ajustes do usuário. */
function syncDist(dir = dataDir()) {
  const dist = path.join(dir, "dist");
  if (path.basename(dist) !== "dist") throw new Error("caminho de dist inesperado");
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(dist, { recursive: true, force: true });
  copyDir(SRC, dist);
  fs.mkdirSync(path.join(dir, "themes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
  return dist;
}

// ---------------------------------------------------------------- comandos

function status(opts = {}) {
  const t = resolveTarget(opts.app);
  assertIsTrivo(t);
  const buf = fs.readFileSync(t.asar);
  const patched = asar.has(buf, LOADER);
  const { headerString } = asar.parse(buf);
  const info = {
    app: t.root,
    patched,
    backup: fs.existsSync(t.asar + BACKUP_SUFFIX),
    asarHash: asar.integrityHash(headerString),
    dataDir: dataDir(),
    distInstalled: fs.existsSync(path.join(dataDir(), "dist", "main", "index.js")),
  };
  if (t.kind === "mac") {
    info.plistHash = getPlistHash(t);
    info.integrityConsistent = info.plistHash === info.asarHash;
  } else if (t.kind === "win") {
    info.exeHash = winexe.readIntegrity(t.exe).hash;
    info.integrityConsistent = info.exeHash === info.asarHash;
  }
  info.kind = t.kind;
  if (t.kind === "mac") info.customIcon = fs.existsSync(bundleIcns(t) + ICON_ORIGINAL_SUFFIX);
  return info;
}

function appVersion(t) {
  try {
    if (t.kind === "mac") return run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", t.plist]).trim();
    const buf = fs.readFileSync(t.asar + (fs.existsSync(t.asar + BACKUP_SUFFIX) ? BACKUP_SUFFIX : ""));
    return JSON.parse(asar.readFile(buf, "package.json").toString("utf8")).version || "?";
  } catch {
    return "?";
  }
}

/** Instalações do Trivo que dá para modificar: as de sempre mais as `extra` (caminhos escolhidos pelo usuário). */
function discover(extra = []) {
  const defaults = defaultLocations();
  const installs = [];
  const seen = new Set();
  for (const candidate of [...defaults, ...extra]) {
    let t;
    try {
      t = targetAt(candidate);
      if (!t) continue;
      assertIsTrivo(t);
    } catch {
      continue;
    }
    const key = process.platform === "win32" ? t.root.toLowerCase() : t.root; // NTFS não diferencia maiúsculas
    if (seen.has(key)) continue;
    seen.add(key);
    let info;
    try {
      info = status({ app: t.root });
    } catch (error) {
      // Uma instalação com problema não derruba a lista: aparece com o erro.
      installs.push({ app: t.root, version: appVersion(t), patched: false, hasBackup: false, integrityConsistent: false,
        running: isRunning(t), custom: !defaults.includes(candidate), kind: t.kind, error: String((error && error.message) || error) });
      continue;
    }
    installs.push({
      app: t.root,
      version: appVersion(t),
      patched: info.patched,
      hasBackup: info.backup,
      integrityConsistent: info.integrityConsistent !== false,
      running: isRunning(t),
      custom: !defaults.includes(candidate),
      kind: t.kind,
    });
  }
  return { installs };
}

function install(opts = {}) {
  const t = resolveTarget(opts.app);
  assertIsTrivo(t);
  assertNotRunning(t, opts.force);

  const backup = t.asar + BACKUP_SUFFIX;
  let original;
  const current = fs.readFileSync(t.asar);
  if (fs.existsSync(backup) && !asar.has(current, LOADER)) {
    // O app não está modificado, mas sobrou uma cópia do original: o Trivo foi atualizado (ou restaurado)
    // por fora. A cópia é de uma versão velha; o original agora é o app atual.
    original = current;
    fs.copyFileSync(t.asar, backup);
  } else if (fs.existsSync(backup)) {
    original = fs.readFileSync(backup); // reinstalar sempre parte do original
  } else {
    original = current;
    if (asar.has(original, LOADER)) throw new Error("O app já está modificado, mas não há backup do original. Reinstale o Trivo.");
    fs.copyFileSync(t.asar, backup);
  }

  const pkg = JSON.parse(asar.readFile(original, "package.json").toString("utf8"));
  if (!pkg.main) throw new Error("package.json do app sem `main`.");
  // Só `main` muda. O app valida o próprio package.json, então nenhum campo novo entra.
  const newPkg = { ...pkg, main: LOADER };

  const dir = dataDir();
  const result = asar.patch(original, {
    "package.json": Buffer.from(JSON.stringify(newPkg, null, 2)),
    [LOADER]: Buffer.from(loaderSource(pkg.main, dir)),
  });

  const dist = syncDist(dir);
  writeAtomic(t.asar, result.buffer);
  const icon = applyBundleIcon(t, dir);
  setIntegrity(t, result.hash);
  return { app: t.root, dist, hash: result.hash, originalMain: pkg.main, icon };
}

function uninstall(opts = {}) {
  const t = resolveTarget(opts.app);
  assertIsTrivo(t);
  assertNotRunning(t, opts.force);
  const backup = t.asar + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) throw new Error("Sem backup do asar original; nada a restaurar. Reinstale o Trivo para voltar ao original.");
  const original = fs.readFileSync(backup);
  writeAtomic(t.asar, original);
  // O backup mora dentro do pacote e entra no selo da assinatura: tem de sair ANTES de reassinar.
  fs.rmSync(backup);
  const icon = restoreBundleIcon(t);
  setIntegrity(t, asar.integrityHash(asar.parse(original).headerString));
  return { app: t.root, icon };
}

module.exports = { applyBundleIcon, copyDir, restoreBundleIcon, install, uninstall, status, discover, syncDist, resolveTarget, loaderSource, dataDir, LOADER };
