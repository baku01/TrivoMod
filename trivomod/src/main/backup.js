"use strict";
// Cópia de segurança: ajustes + temas, layouts e plugins do USUÁRIO (os que vêm com o mod ficam de fora).
const fs = require("node:fs");
const path = require("node:path");
const settingsStore = require("./settings");

const FORMAT = "trivomod-backup";
const VERSION = 1;
const MAX_BACKUP = 5 * 1024 * 1024;
const NAME = /^[\w .-]{1,80}\.(css|js)$/;
const KINDS = { themes: ".css", layouts: ".css", plugins: ".js" };

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const validName = (name, ext) => typeof name === "string" && NAME.test(name) && name.endsWith(ext) && path.basename(name) === name;

function readDir(dir, ext) {
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    if (!validName(name, ext)) continue;
    try {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size <= MAX_BACKUP) out[name] = fs.readFileSync(file, "utf8");
    } catch {
      /* sumiu: ignora */
    }
  }
  return out;
}

/** dirs: { settings, themes, layouts, plugins } (caminhos). */
function build(dirs, now = new Date()) {
  const data = { format: FORMAT, version: VERSION, createdAt: now.toISOString(), settings: settingsStore.load(dirs.settings) };
  for (const [kind, ext] of Object.entries(KINDS)) data[kind] = readDir(dirs[kind], ext);
  return data;
}

const count = (data) => Object.fromEntries(Object.keys(KINDS).map((k) => [k, Object.keys(data[k] || {}).length]));

function defaultName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `trivomod-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/** Lê e valida um arquivo de backup. Lança Error com mensagem para o usuário. */
function parse(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("não é um arquivo");
  if (stat.size > MAX_BACKUP) throw new Error("arquivo maior que 5 MB");
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("o arquivo não é JSON válido");
  }
  if (!isObject(data) || data.format !== FORMAT) throw new Error("não é um backup do TrivoMod");
  if (data.version !== VERSION) throw new Error(`versão de backup não suportada: ${data.version}`);
  if (data.settings !== undefined && !isObject(data.settings)) throw new Error("ajustes inválidos no backup");
  for (const [kind, ext] of Object.entries(KINDS)) {
    if (data[kind] === undefined) continue;
    if (!isObject(data[kind])) throw new Error(`campo "${kind}" inválido`);
    for (const [name, text] of Object.entries(data[kind])) {
      if (!validName(name, ext)) throw new Error(`nome de arquivo recusado em ${kind}: ${String(name).slice(0, 100)}`);
      if (typeof text !== "string") throw new Error(`conteúdo inválido em ${kind}/${name}`);
    }
  }
  return data;
}

/** Grava o backup já validado. Devolve as contagens. */
function apply(dirs, data) {
  for (const kind of Object.keys(KINDS)) {
    fs.mkdirSync(dirs[kind], { recursive: true });
    for (const [name, text] of Object.entries(data[kind] || {})) {
      const target = path.join(dirs[kind], name);
      fs.writeFileSync(`${target}.tmp`, text);
      fs.renameSync(`${target}.tmp`, target);
    }
  }
  if (data.settings) settingsStore.save(dirs.settings, data.settings);
  return count(data);
}

module.exports = { FORMAT, VERSION, MAX_BACKUP, build, parse, apply, count, defaultName };
