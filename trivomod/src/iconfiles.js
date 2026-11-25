"use strict";
// Formatos de ícone escritos à mão, sem dependências. Os dois aceitam PNG dentro:
//   - .icns (macOS): "icns" + tamanho total (BE) + blocos [tipo(4) tamanho(BE, inclui os 8 do cabeçalho) png].
//   - .ico (Windows Vista+): ICONDIR + ICONDIRENTRY por tamanho, cada imagem é um PNG.

/** Tipo do bloco .icns -> lado do PNG em pixels. */
const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32], // 16@2x
  ["ic12", 64], // 32@2x
  ["ic07", 128],
  ["ic13", 256], // 128@2x
  ["ic08", 256],
  ["ic14", 512], // 256@2x
  ["ic09", 512],
  ["ic10", 1024], // 512@2x
];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** `pngs`: Map ou objeto { tamanho: Buffer PNG }. */
function pick(pngs, size) {
  const buf = pngs instanceof Map ? pngs.get(size) : pngs[size];
  if (!Buffer.isBuffer(buf)) throw new Error(`falta o PNG de ${size}px`);
  return buf;
}

function buildIcns(pngs) {
  const blocks = ICNS_TYPES.map(([type, size]) => {
    const png = pick(pngs, size);
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(blocks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

function parseIcns(buf) {
  if (buf.toString("latin1", 0, 4) !== "icns" || buf.readUInt32BE(4) !== buf.length) throw new Error("icns inválido");
  const out = [];
  for (let i = 8; i < buf.length; ) {
    const type = buf.toString("latin1", i, i + 4);
    const len = buf.readUInt32BE(i + 4);
    if (len < 8 || i + len > buf.length) throw new Error("bloco icns inválido");
    out.push({ type, data: buf.subarray(i + 8, i + len) });
    i += len;
  }
  return out;
}

function buildIco(pngs) {
  const images = ICO_SIZES.map((size) => [size, pick(pngs, size)]);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = ícone
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(([size, png]) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 significa 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // planos
    e.writeUInt16LE(32, 6); // bits por pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map(([, png]) => png)]);
}

/** Todos os lados que os dois formatos usam. */
const ALL_SIZES = [...new Set([...ICNS_TYPES.map(([, s]) => s), ...ICO_SIZES])].sort((a, b) => a - b);

module.exports = { ICNS_TYPES, ICO_SIZES, ALL_SIZES, buildIcns, parseIcns, buildIco };
