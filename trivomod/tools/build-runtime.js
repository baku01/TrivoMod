#!/usr/bin/env node
"use strict";
// Gera o pacote do runtime para a release: node tools/build-runtime.js <pasta-de-saída>
// Grava trivomod-runtime-vX.Y.Z.json.gz (o SHA256SUMS.txt da release cobre o arquivo).
const fs = require("node:fs");
const path = require("node:path");
const bundle = require("../src/main/bundle");

const outDir = path.resolve(process.argv[2] || "out");
const { version, buffer } = bundle.build(path.join(__dirname, "..", "src"));
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, bundle.assetName(version));
fs.writeFileSync(file, buffer);
console.log(`${path.basename(file)} (${buffer.length} bytes)`);
