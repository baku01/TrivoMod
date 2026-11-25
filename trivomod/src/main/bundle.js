"use strict";
// Pacote do runtime do TrivoMod (o conteúdo de `src/`, que vira `<dados>/dist`) publicado em cada
// release como `trivomod-runtime-vX.Y.Z.json.gz`. JSON + gzip em vez de tar: o Node lê sem
// dependência nenhuma. O mesmo módulo monta (CI) e confere (atualizador), então os dois lados não
// têm como divergir no formato.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const vm = require("node:vm");

const FORMAT = 1;
const MAX_BYTES = 8 * 1024 * 1024; // compactado e descompactado
const MAX_FILES = 400;
const SAFE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
/** Sem estes o loader nem a página sobem: pacote sem eles é recusado. */
const REQUIRED = ["version.js", "main/index.js", "preload/index.js", "renderer/index.js"];
const VERSION_FILE = /^"use strict";\s*module\.exports = "(\d+\.\d+\.\d+)";\s*$/;

const assetName = (version) => `trivomod-runtime-v${version}.json.gz`;

/** Versão declarada num `version.js` (só o formato que o CI grava). */
function versionOf(source) {
  const m = VERSION_FILE.exec(String(source));
  if (!m) throw new Error("version.js em formato inesperado");
  return m[1];
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue; // .DS_Store e afins
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Monta o pacote de uma pasta `src/`. Devolve { version, buffer }. */
function build(srcDir) {
  const files = {};
  for (const rel of listFiles(srcDir)) files[rel] = fs.readFileSync(path.join(srcDir, rel)).toString("base64");
  const version = versionOf(Buffer.from(files["version.js"] || "", "base64").toString("utf8"));
  const buffer = zlib.gzipSync(Buffer.from(JSON.stringify({ format: FORMAT, version, files })), { level: 9 });
  validate(parse(buffer), version); // o CI não publica o que o atualizador recusaria
  return { version, buffer };
}

/** gzip -> objeto, com limites de tamanho (não confia no que veio da rede). */
function parse(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_BYTES) throw new Error("pacote grande demais");
  const json = zlib.gunzipSync(buffer, { maxOutputLength: MAX_BYTES });
  const data = JSON.parse(json.toString("utf8"));
  if (!data || typeof data !== "object" || data.format !== FORMAT) throw new Error("formato de pacote desconhecido");
  return data;
}

/**
 * Confere o pacote e devolve os arquivos decodificados ({ rel: Buffer }). Recusa caminho que saia
 * da pasta, versão diferente da esperada, arquivo obrigatório faltando e JavaScript que nem
 * compila (pacote truncado ou corrompido). Compilar não executa nada.
 */
function validate(data, expectedVersion) {
  if (typeof data.version !== "string" || data.version !== expectedVersion) {
    throw new Error(`pacote é da versão ${data.version}, esperava ${expectedVersion}`);
  }
  if (!data.files || typeof data.files !== "object" || Array.isArray(data.files)) throw new Error("pacote sem arquivos");
  const names = Object.keys(data.files);
  if (names.length === 0 || names.length > MAX_FILES) throw new Error("quantidade de arquivos inválida");
  const out = {};
  for (const rel of names) {
    if (!SAFE_PATH.test(rel) || rel.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`caminho recusado no pacote: ${rel}`);
    }
    const value = data.files[rel];
    if (typeof value !== "string") throw new Error(`conteúdo inválido: ${rel}`);
    out[rel] = Buffer.from(value, "base64");
  }
  for (const rel of REQUIRED) if (!out[rel]) throw new Error(`pacote sem ${rel}`);
  if (versionOf(out["version.js"].toString("utf8")) !== expectedVersion) throw new Error("version.js não bate com a release");
  for (const rel of names) {
    if (!rel.endsWith(".js")) continue;
    try {
      new vm.Script(out[rel].toString("utf8"), { filename: rel });
    } catch (error) {
      throw new Error(`${rel} não compila: ${error.message}`);
    }
  }
  return out;
}

/** Grava os arquivos numa pasta nova (que não pode existir). */
function writeTo(dir, files) {
  if (fs.existsSync(dir)) throw new Error(`pasta já existe: ${dir}`);
  for (const [rel, content] of Object.entries(files)) {
    const dst = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
  }
}

module.exports = { FORMAT, REQUIRED, assetName, versionOf, build, parse, validate, writeTo, listFiles };
