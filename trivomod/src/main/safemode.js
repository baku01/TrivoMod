"use strict";
// Modo seguro automático: conta aberturas que não chegaram ao "boot-ok" do renderer (e quedas do
// processo da página). Com 3 falhas seguidas, a próxima abertura entra em modo seguro sozinha.
const fs = require("node:fs");
const path = require("node:path");

const LIMIT = 3;

function read(file) {
  try {
    const n = JSON.parse(fs.readFileSync(file, "utf8")).failedBoots;
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function write(file, failedBoots) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ failedBoots }));
    fs.renameSync(tmp, file);
  } catch {
    /* sem disco: o contador é cortesia */
  }
}

/** Chamado uma vez na abertura. Devolve se esta abertura deve ser em modo seguro. */
function startBoot(file) {
  const before = read(file);
  write(file, before + 1);
  return { failedBoots: before + 1, auto: before >= LIMIT };
}

const fail = (file) => write(file, read(file) + 1);
const reset = (file) => write(file, 0);

module.exports = { LIMIT, read, startBoot, fail, reset };
