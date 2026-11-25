"use strict";
// Leitor/escritor mínimo de arquivos .asar, sem dependências.
//
// Formato: [u32=4][u32 tamanhoDoHeader][u32 payload][u32 tamanhoDoJson][json, alinhado a 4][dados...]
// Os `offset` do header são relativos ao início da região de dados.
//
// O patch NÃO reempacota o app: ele escreve um header novo e copia a região de
// dados original byte a byte, acrescentando os arquivos novos no fim. Assim nada
// do que o Trivo empacotou muda de lugar.

const crypto = require("node:crypto");

const align4 = (n) => (n + 3) & ~3;

function serializeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = align4(json.length);
  const out = Buffer.alloc(16 + padded);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(8 + padded, 4);
  out.writeUInt32LE(4 + padded, 8);
  out.writeUInt32LE(json.length, 12);
  json.copy(out, 16);
  return { buffer: out, headerString: json.toString("utf8") };
}

function parse(buf) {
  if (buf.length < 16 || buf.readUInt32LE(0) !== 4) throw new Error("Não é um arquivo asar (assinatura inválida).");
  const headerSize = buf.readUInt32LE(4);
  const jsonLength = buf.readUInt32LE(12);
  const headerString = buf.subarray(16, 16 + jsonLength).toString("utf8");
  const dataStart = 8 + headerSize;
  if (dataStart > buf.length) throw new Error("asar truncado.");
  return { header: JSON.parse(headerString), headerString, dataStart, data: buf.subarray(dataStart) };
}

/** O que o Electron grava em `ElectronAsarIntegrity`: SHA-256 do JSON do header. */
function integrityHash(headerString) {
  return crypto.createHash("sha256").update(headerString, "utf8").digest("hex");
}

const BLOCK_SIZE = 4 * 1024 * 1024;
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** O Electron exige este campo em TODA entrada quando a validação de integridade está ligada. */
function fileIntegrity(content) {
  const blocks = [];
  for (let i = 0; i < content.length; i += BLOCK_SIZE) blocks.push(sha256(content.subarray(i, i + BLOCK_SIZE)));
  if (!blocks.length) blocks.push(sha256(content));
  return { algorithm: "SHA256", hash: sha256(content), blockSize: BLOCK_SIZE, blocks };
}

function lookup(header, filePath) {
  let node = header;
  for (const part of filePath.split("/").filter(Boolean)) {
    node = node && node.files && Object.prototype.hasOwnProperty.call(node.files, part) ? node.files[part] : undefined;
    if (!node) return undefined;
  }
  return node;
}

function readFile(buf, filePath) {
  const { header, data } = parse(buf);
  const node = lookup(header, filePath);
  if (!node || node.files) throw new Error(`${filePath} não existe no asar.`);
  if (node.unpacked) throw new Error(`${filePath} está fora do asar (unpacked).`);
  const start = Number(node.offset);
  return data.subarray(start, start + node.size);
}

function has(buf, filePath) {
  const node = lookup(parse(buf).header, filePath);
  return Boolean(node && !node.files);
}

/**
 * `files`: { "caminho/no/asar": Buffer }. Cria ou substitui. Devolve
 * `{ buffer, headerString, hash }`.
 */
function patch(buf, files) {
  const { header, data } = parse(buf);
  const added = [];
  let cursor = data.length;
  for (const [filePath, content] of Object.entries(files)) {
    const parts = filePath.split("/").filter(Boolean);
    const name = parts.pop();
    let dir = header;
    for (const part of parts) {
      dir.files = dir.files || {};
      if (!Object.prototype.hasOwnProperty.call(dir.files, part)) dir.files[part] = { files: {} };
      dir = dir.files[part];
    }
    dir.files = dir.files || {};
    // Com `EnableEmbeddedAsarIntegrityValidation` o Electron confere o header (hash no Info.plist) E cada
    // arquivo lido; entrada sem `integrity` derruba o app com "Failed to read integrity for file".
    dir.files[name] = { size: content.length, offset: String(cursor), integrity: fileIntegrity(content) };
    added.push(content);
    cursor += content.length;
  }
  const { buffer: head, headerString } = serializeHeader(header);
  return { buffer: Buffer.concat([head, data, ...added]), headerString, hash: integrityHash(headerString) };
}

/** Empacota `{ caminho: Buffer }` num asar novo (usado nos testes). */
function pack(files) {
  const header = { files: {} };
  const chunks = [];
  let cursor = 0;
  for (const [filePath, content] of Object.entries(files)) {
    const parts = filePath.split("/");
    const name = parts.pop();
    let dir = header;
    for (const part of parts) {
      dir.files[part] = dir.files[part] || { files: {} };
      dir = dir.files[part];
    }
    dir.files[name] = { size: content.length, offset: String(cursor) };
    chunks.push(content);
    cursor += content.length;
  }
  return Buffer.concat([serializeHeader(header).buffer, ...chunks]);
}

module.exports = { fileIntegrity, parse, serializeHeader, integrityHash, readFile, has, patch, pack, lookup };
