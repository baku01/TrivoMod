"use strict";
// Lê temas (.css) e plugins (.js) das duas pastas: a que vem com o mod e a do usuário.
const fs = require("node:fs");
const path = require("node:path");

const MAX_FILE = 2 * 1024 * 1024;

/** Cabeçalho do arquivo: um comentário de bloco no topo com linhas "@name", "@author" e "@description". */
function parseMeta(text) {
  const block = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(text);
  const meta = {};
  if (!block) return meta;
  for (const line of block[1].split("\n")) {
    const m = /^\s*\*?\s*@(\w+)\s+(.+?)\s*$/.exec(line);
    if (m) meta[m[1]] = m[2];
  }
  return meta;
}

function listFiles(dir, ext, scope, builtin) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith(ext) || name.startsWith(".") || name.startsWith("_")) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE) continue;
      const source = fs.readFileSync(file, "utf8");
      const base = name.slice(0, -ext.length);
      out.push({ id: `${scope}:${base}`, file: name, builtin, source, meta: parseMeta(source) });
    } catch {
      /* arquivo sumiu no meio: ignora */
    }
  }
  return out;
}

function listThemes(distDir, userDir) {
  return [...listFiles(path.join(distDir, "themes"), ".css", "builtin", true), ...listFiles(userDir, ".css", "user", false)].map(
    (t) => ({
      id: t.id,
      builtin: t.builtin,
      name: t.meta.name || t.file.replace(/\.css$/, ""),
      author: t.meta.author || "",
      description: t.meta.description || "",
      css: t.source,
    }),
  );
}

/** Layouts: CSS que mexe na estrutura da tela. Só um fica ativo por vez (ajuste `layout`). */
function listLayouts(distDir, userDir) {
  return [...listFiles(path.join(distDir, "layouts"), ".css", "builtin", true), ...listFiles(userDir, ".css", "user", false)].map((t) => ({
    id: t.id,
    builtin: t.builtin,
    name: t.meta.name || t.file.replace(/\.css$/, ""),
    author: t.meta.author || "",
    description: t.meta.description || "",
    css: t.source,
  }));
}

function listPlugins(distDir, userDir) {
  return [...listFiles(path.join(distDir, "plugins"), ".js", "builtin", true), ...listFiles(userDir, ".js", "user", false)];
}

module.exports = { parseMeta, listThemes, listLayouts, listPlugins };
