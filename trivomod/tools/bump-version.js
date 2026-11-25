#!/usr/bin/env node
"use strict";
// Atualiza a versão do TrivoMod em `package.json` e `src/version.js` mantendo ambos sincronizados.
// Uso:
//   node tools/bump-version.js [patch|minor|major|auto|X.Y.Z] [--dry-run] [--message "<commit>"]
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PKG_FILE = path.join(ROOT, "package.json");
const VER_FILE = path.join(ROOT, "src", "version.js");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(raw) {
  const m = SEMVER.exec(String(raw || "").trim().replace(/^v/, ""));
  if (!m) throw new Error(`Versão inválida: ${raw}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function detectBump(message) {
  const text = String(message || "");
  if (/BREAKING CHANGE|^[a-z]+(\([^)]+\))?!:/m.test(text)) return "major";
  if (/^feat(\([^)]+\))?:/m.test(text)) return "minor";
  return "patch";
}

function nextVersion(current, mode = "patch", message = "") {
  if (SEMVER.test(String(mode || "").replace(/^v/, ""))) {
    return parseSemver(mode).join(".");
  }
  const [maj, min, pat] = parseSemver(current);
  const kind = mode === "auto" ? detectBump(message) : mode;
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  if (kind === "patch") return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Modo de versão desconhecido: ${mode} (use patch, minor, major, auto ou X.Y.Z)`);
}

function applyVersion(version, { pkgFile = PKG_FILE, verFile = VER_FILE } = {}) {
  const clean = parseSemver(version).join(".");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  pkg.version = clean;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  fs.writeFileSync(verFile, `"use strict";\nmodule.exports = ${JSON.stringify(clean)};\n`, "utf8");
  return clean;
}

function lastCommitMessage() {
  try {
    return cp.execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const msgIdx = args.indexOf("--message");
  const msg = msgIdx >= 0 ? args[msgIdx + 1] || "" : lastCommitMessage();
  const mode = args.find((a, i) => !a.startsWith("--") && i !== msgIdx + 1) || "patch";
  const current = JSON.parse(fs.readFileSync(PKG_FILE, "utf8")).version;
  const next = nextVersion(current, mode, msg);
  if (!dryRun) applyVersion(next);
  process.stdout.write(`${next}\n`);
}

module.exports = { parseSemver, detectBump, nextVersion, applyVersion };
