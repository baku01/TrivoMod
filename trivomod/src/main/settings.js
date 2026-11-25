"use strict";
const fs = require("node:fs");
const path = require("node:path");

const MAX_QUICK_CSS = 100_000;
const MAX_STRING = 500;
const MAX_LINKS = 20;
const MAX_LINK = 500;
const KEY = /^[\w.:-]{1,80}$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validKey = (k) => KEY.test(k) && !FORBIDDEN.has(k);

function defaults() {
  return {
    version: 1,
    showButton: true,
    autoUpdate: true,
    layout: "",
    themes: {},
    plugins: {},
    pluginSettings: {},
    quickCss: "",
    native: { enabled: true, translucent: true, systemFont: true, systemAccent: false },
    themeLinks: [],
  };
}

/** URL https:// válida, até 500 caracteres; senão null. */
function cleanLink(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_LINK) return null;
  try {
    return new URL(text).protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

/** Aceita só o formato conhecido; o renderer é página web e não é confiável para gravar qualquer coisa. */
function sanitize(input) {
  const out = defaults();
  if (!isObject(input)) return out;
  out.showButton = input.showButton !== false;
  out.autoUpdate = input.autoUpdate !== false;
  if (typeof input.layout === "string" && validKey(input.layout)) out.layout = input.layout;
  for (const field of ["themes", "plugins"]) {
    if (!isObject(input[field])) continue;
    for (const [k, v] of Object.entries(input[field])) if (validKey(k) && typeof v === "boolean") out[field][k] = v;
  }
  if (isObject(input.pluginSettings)) {
    for (const [id, values] of Object.entries(input.pluginSettings)) {
      if (!validKey(id) || !isObject(values)) continue;
      const clean = {};
      for (const [k, v] of Object.entries(values)) {
        if (!validKey(k)) continue;
        if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) clean[k] = v;
        else if (typeof v === "string") clean[k] = v.slice(0, MAX_STRING);
      }
      out.pluginSettings[id] = clean;
    }
  }
  if (typeof input.quickCss === "string") out.quickCss = input.quickCss.slice(0, MAX_QUICK_CSS);
  if (isObject(input.native)) {
    for (const k of Object.keys(out.native)) if (typeof input.native[k] === "boolean") out.native[k] = input.native[k];
  }
  if (Array.isArray(input.themeLinks)) {
    for (const v of input.themeLinks) {
      const link = cleanLink(v);
      if (link && !out.themeLinks.includes(link)) out.themeLinks.push(link);
      if (out.themeLinks.length >= MAX_LINKS) break;
    }
  }
  return out;
}

function load(file) {
  try {
    return sanitize(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return defaults();
  }
}

function save(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sanitize(settings), null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { sanitize, defaults, load, save, cleanLink };
