#!/usr/bin/env node
"use strict";
// Ferramenta de desenvolvimento: gera uma página que imita o que o preload faz no Trivo,
// para abrir o runtime num navegador comum e ver os temas/plugins/painel funcionando.
//
//   node test/fixture.js <saida.html> <globals.css do Trivo> [--tema escuro|claro|brasa] [--tab themes|plugins|css|about]
//        [--themes id,id] [--plugins id,id] [--closed] [--probe]
//   --probe: dirige o painel por cliques e grava o resultado em <pre id="probe"> (use com --dump-dom).
const fs = require("node:fs");
const path = require("node:path");
const library = require("../src/main/library");

const [out, css, ...rest] = process.argv.slice(2);
if (!out || !css) {
  console.error("uso: node test/fixture.js <saida.html> <globals.css> [opções]");
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const tema = opt("tema", "escuro");
const tab = opt("tab", "themes");
const enableThemes = (opt("themes", "") || "").split(",").filter(Boolean);
const enablePlugins = (opt("plugins", "") || "").split(",").filter(Boolean);
const closed = rest.includes("--closed") || rest.includes("--probe");
const probe = rest.includes("--probe");

const dist = path.resolve(__dirname, "..", "src");
const themes = library.listThemes(dist, "/nao/existe");
const plugins = library.listPlugins(dist, "/nao/existe");
const runtime = fs.readFileSync(path.join(dist, "renderer", "index.js"), "utf8");

const settings = {
  version: 1,
  showButton: true,
  themes: Object.fromEntries(enableThemes.map((id) => [id, true])),
  plugins: Object.fromEntries(enablePlugins.map((id) => [id, true])),
  pluginSettings: { "builtin:cor-de-destaque": { color: "#ff8a3d" }, "builtin:escala-da-interface": { percent: 110 } },
  quickCss: "",
};

const native = {
  boot: {
    settings,
    themes,
    plugins: plugins.map((p) => ({ id: p.id, builtin: p.builtin })),
    info: { version: "0.1.0-fixture", dataDir: "~/Library/Application Support/TrivoMod", safeMode: false },
  },
};

const pluginScripts = plugins
  .map((p) => `TrivoMod.__loadPlugin(${JSON.stringify(p.id)}, ${p.builtin}, function () {\n${p.source}\n});`)
  .join("\n");


const probeScript = `
window.__saves = 0;
window.TrivoModNative.saveSettings = async () => { window.__saves += 1; return true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
window.addEventListener("load", async () => {
  const out = { steps: [], errors: [] };
  window.addEventListener("error", (e) => out.errors.push(String(e.message)));
  const cs = () => getComputedStyle(document.documentElement);
  const snap = (label) => out.steps.push({
    label,
    background: cs().getPropertyValue("--background").trim(),
    accent: cs().getPropertyValue("--accent").trim(),
    focusRing: cs().getPropertyValue("--focus-ring").trim(),
    textOnAccent: cs().getPropertyValue("--text-on-accent").trim(),
    fontUi: cs().getPropertyValue("--font-ui").trim().slice(0, 30),
    htmlFontSize: cs().fontSize,
    sheets: document.adoptedStyleSheets.length,
    saves: window.__saves,
  });
  await sleep(800);
  const root = document.getElementById("trivomod-root") && document.getElementById("trivomod-root").shadowRoot;
  out.mounted = Boolean(root);
  out.fab = Boolean(root && root.querySelector(".fab"));
  snap("inicial");
  root.querySelector(".fab").click(); await sleep(50);
  out.panelOpen = Boolean(root.querySelector(".panel"));
  out.tabs = [...root.querySelectorAll("nav button")].map((b) => b.textContent);
  out.themeCards = [...root.querySelectorAll("main .card .name")].map((n) => n.textContent.trim());
  const click = async (el) => { el.click(); await sleep(50); };
  const tab = (i) => click(root.querySelectorAll("nav button")[i]);
  const cards = () => [...root.querySelectorAll("main .card")];
  const find = (name) => cards().find((c) => c.querySelector(".name").textContent.startsWith(name));

  await click(find("Violeta noturno").querySelector(".switch")); snap("tema Violeta ligado");
  await click(find("AMOLED").querySelector(".switch")); snap("AMOLED também ligado (vence o último)");
  await click(find("AMOLED").querySelector(".switch")); await click(find("Violeta noturno").querySelector(".switch")); snap("temas desligados");

  await tab(1);
  out.plugins = cards().map((c) => c.querySelector(".name").textContent.trim());
  await click(find("Cor de destaque").querySelector(".switch")); snap("plugin cor ligado (cor padrão)");
  const color = find("Cor de destaque").querySelector("input[type=color]");
  color.value = "#ff8a3d"; color.dispatchEvent(new Event("input", { bubbles: true })); await sleep(50); snap("cor laranja");
  color.value = "#101010"; color.dispatchEvent(new Event("input", { bubbles: true })); await sleep(50); snap("cor escura (texto deve ficar claro)");
  await click(find("Escala da interface").querySelector(".switch"));
  const range = find("Escala da interface").querySelector("input[type=range]");
  out.rangeInitial = range.value;
  range.value = "125"; range.dispatchEvent(new Event("input", { bubbles: true })); await sleep(50); snap("escala 125%");
  await click(find("Fonte da interface").querySelector(".switch"));
  const sel = find("Fonte da interface").querySelector("select");
  out.selectInitial = sel.value;
  sel.value = "mono"; sel.dispatchEvent(new Event("change", { bubbles: true })); await sleep(50); snap("fonte mono");
  await click(find("Cor de destaque").querySelector(".switch")); snap("plugin cor desligado");

  await tab(2);
  const ta = root.querySelector("textarea");
  ta.value = "html:root{--accent:#00ff00}"; ta.dispatchEvent(new Event("input", { bubbles: true })); await sleep(50); snap("CSS rápido");
  await tab(3);
  out.about = root.querySelector("main").textContent.replace(/\\s+/g, " ").slice(0, 160);

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(50);
  out.closedByEsc = !root.querySelector(".panel");
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyT", ctrlKey: true, altKey: true, bubbles: true })); await sleep(50);
  out.openedByShortcut = Boolean(root.querySelector(".panel"));
  document.body.insertAdjacentHTML("beforeend", "<pre id=probe>" + JSON.stringify(out, null, 1).replace(/</g, "&lt;") + "</pre>");
});`;

const html = `<!doctype html>
<html lang="pt-BR" data-tema="${tema}">
<head><meta charset="utf-8"><title>fixture</title>
<link rel="stylesheet" href="globals.css">
<style>
  body { margin: 0; display: grid; grid-template-columns: 220px 1fr; height: 100vh; background: var(--background); color: var(--text-primary); font-family: var(--font-ui); font-size: 1rem; }
  aside { background: var(--surface-sidebar); border-right: 1px solid var(--line); padding: 16px; }
  aside li { list-style: none; padding: 6px 10px; border-radius: 8px; color: var(--text-secondary); }
  aside li.on { background: var(--surface-active); color: var(--text-primary); }
  main { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .msg { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; }
  button.send { align-self: flex-start; background: var(--accent); color: var(--text-on-accent); border: 0; border-radius: 999px; padding: 8px 18px; }
</style></head>
<body>
<aside><b>Trivo (fixture)</b><ul style="padding:0"><li class="on"># geral</li><li># avisos</li><li># musica</li></ul></aside>
<main><div class="msg"><b>Ana</b><br>Mensagem de exemplo no canal.</div><div class="msg">Outra mensagem, com <span style="color:var(--accent)">destaque</span>.</div><button class="send">Enviar</button></main>
<script>
  const bootData = ${JSON.stringify(native)};
  window.TrivoModNative = { boot: bootData.boot, saveSettings: async () => true, openFolder: async () => true, onThemesChanged() {} };
</script>
<script>${runtime}</script>
<script>
${pluginScripts}
TrivoMod.__ready();
${closed ? "" : `window.addEventListener("load", () => setTimeout(() => {
  TrivoMod.openSettings();
  const tabs = document.getElementById("trivomod-root").shadowRoot.querySelectorAll("nav button");
  const idx = { themes: 0, plugins: 1, css: 2, about: 3 }[${JSON.stringify(tab)}];
  tabs[idx].click();
}, 500));`}
${probe ? probeScript : ""}
</script>
</body></html>`;

fs.writeFileSync(out, html);
console.log(`gerado ${out}`);
