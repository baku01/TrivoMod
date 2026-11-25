#!/usr/bin/env node
"use strict";
// Gera src/themes/catppuccin-*.css a partir da paleta oficial do Catppuccin (MIT,
// https://github.com/catppuccin/palette). Rode de novo depois de mudar o mapeamento:
//   node tools/gen-catppuccin.js
const fs = require("node:fs");
const path = require("node:path");

const PALETTE = {
  latte: { name: "Latte", dark: false, rosewater: "#dc8a78", flamingo: "#dd7878", pink: "#ea76cb", mauve: "#8839ef", red: "#d20f39", maroon: "#e64553", peach: "#fe640b", yellow: "#df8e1d", green: "#40a02b", teal: "#179299", sky: "#04a5e5", sapphire: "#209fb5", blue: "#1e66f5", lavender: "#7287fd", text: "#4c4f69", subtext1: "#5c5f77", subtext0: "#6c6f85", overlay2: "#7c7f93", overlay1: "#8c8fa1", overlay0: "#9ca0b0", surface2: "#acb0be", surface1: "#bcc0cc", surface0: "#ccd0da", base: "#eff1f5", mantle: "#e6e9ef", crust: "#dce0e8" },
  frappe: { name: "Frappé", dark: true, rosewater: "#f2d5cf", flamingo: "#eebebe", pink: "#f4b8e4", mauve: "#ca9ee6", red: "#e78284", maroon: "#ea999c", peach: "#ef9f76", yellow: "#e5c890", green: "#a6d189", teal: "#81c8be", sky: "#99d1db", sapphire: "#85c1dc", blue: "#8caaee", lavender: "#babbf1", text: "#c6d0f5", subtext1: "#b5bfe2", subtext0: "#a5adce", overlay2: "#949cbb", overlay1: "#838ba7", overlay0: "#737994", surface2: "#626880", surface1: "#51576d", surface0: "#414559", base: "#303446", mantle: "#292c3c", crust: "#232634" },
  macchiato: { name: "Macchiato", dark: true, rosewater: "#f4dbd6", flamingo: "#f0c6c6", pink: "#f5bde6", mauve: "#c6a0f6", red: "#ed8796", maroon: "#ee99a0", peach: "#f5a97f", yellow: "#eed49f", green: "#a6da95", teal: "#8bd5ca", sky: "#91d7e3", sapphire: "#7dc4e4", blue: "#8aadf4", lavender: "#b7bdf8", text: "#cad3f5", subtext1: "#b8c0e0", subtext0: "#a5adcb", overlay2: "#939ab7", overlay1: "#8087a2", overlay0: "#6e738d", surface2: "#5b6078", surface1: "#494d64", surface0: "#363a4f", base: "#24273a", mantle: "#1e2030", crust: "#181926" },
  mocha: { name: "Mocha", dark: true, rosewater: "#f5e0dc", flamingo: "#f2cdcd", pink: "#f5c2e7", mauve: "#cba6f7", red: "#f38ba8", maroon: "#eba0ac", peach: "#fab387", yellow: "#f9e2af", green: "#a6e3a1", teal: "#94e2d5", sky: "#89dceb", sapphire: "#74c7ec", blue: "#89b4fa", lavender: "#b4befe", text: "#cdd6f4", subtext1: "#bac2de", subtext0: "#a6adc8", overlay2: "#9399b2", overlay1: "#7f849c", overlay0: "#6c7086", surface2: "#585b70", surface1: "#45475a", surface0: "#313244", base: "#1e1e2e", mantle: "#181825", crust: "#11111b" },
};
const ACCENTS = ["rosewater", "flamingo", "pink", "mauve", "red", "maroon", "peach", "yellow", "green", "teal", "sky", "sapphire", "blue", "lavender"];
const ALL = [...ACCENTS, "text", "subtext1", "subtext0", "overlay2", "overlay1", "overlay0", "surface2", "surface1", "surface0", "base", "mantle", "crust"];

function css(id, p) {
  const v = (k) => `var(--ctp-${k})`;
  const lines = [
    `/**`,
    ` * @name Catppuccin ${p.name}`,
    ` * @author TrivoMod (paleta: Catppuccin, MIT)`,
    ` * @description ${p.dark ? "Variação escura" : "Variação clara"} do Catppuccin, em qualquer tema do Trivo. Destaque: mauve (troque no plugin "Catppuccin: destaque").`,
    ` */`,
    `/* Gerado por tools/gen-catppuccin.js — não edite à mão. */`,
    `html:root[data-tema] {`,
    ...ALL.map((k) => `  --ctp-${k}: ${p[k]};`),
    `  --ctp-accent: var(--ctp-mauve);`,
    ``,
    `  color-scheme: ${p.dark ? "dark" : "light"};`,
    `  --background: ${v("base")};`,
    `  --surface-base: ${v("base")};`,
    `  --surface-sidebar: ${v("mantle")};`,
    `  --surface-raised: ${p.dark ? v("surface0") : "#ffffff"};`,
    `  --surface-overlay: color-mix(in srgb, ${v("crust")} 70%, transparent);`,
    `  --surface-input: color-mix(in srgb, ${v("surface0")} 60%, transparent);`,
    `  --surface-hover: color-mix(in srgb, ${v("surface0")} ${p.dark ? 70 : 60}%, transparent);`,
    `  --surface-active: color-mix(in srgb, ${v("accent")} ${p.dark ? 20 : 26}%, ${v("surface0")});`,
    `  --surface-active-line: color-mix(in srgb, ${v("accent")} 55%, transparent);`,
    `  --surface-neutra: color-mix(in srgb, ${v("accent")} 12%, ${v("surface0")});`,
    `  --surface-neutra-line: color-mix(in srgb, ${v("accent")} 30%, transparent);`,
    `  --surface-danger: color-mix(in srgb, ${v("red")} 14%, transparent);`,
    `  --surface-warning: color-mix(in srgb, ${v("yellow")} 14%, transparent);`,
    `  --foreground: ${v("text")};`,
    `  --soft: ${v("subtext1")};`,
    `  --muted: ${v("subtext0")};`,
    `  --dim: ${v("overlay1")};`,
    `  --line: color-mix(in srgb, ${v("surface0")} 80%, transparent);`,
    `  --line-strong: ${v("surface1")};`,
    `  --campo-borda: ${v("overlay0")};`,
    `  --botao-borda: ${v("overlay0")};`,
    `  --blue: ${v("blue")};`,
    `  --blue-light: ${v("sapphire")};`,
    `  --green: ${v("green")};`,
    `  --green-light: ${v("green")};`,
    `  --yellow: ${v("yellow")};`,
    `  --red: ${v("red")};`,
    `  --red-light: ${v("red")};`,
    `  --text-primary: ${v("text")};`,
    `  --text-secondary: ${v("subtext0")};`,
    `  --text-tertiary: ${v("overlay1")};`,
    `  --text-danger: ${v("red")};`,
    `  --accent: ${v("accent")};`,
    `  --accent-strong: color-mix(in srgb, ${v("accent")} 82%, ${p.dark ? "#000" : "#fff"});`,
    `  --text-on-accent: ${p.dark ? v("crust") : v("base")};`,
    `  --sobre-ativo: ${v("text")};`,
    `  --focus-ring: ${v("accent")};`,
    `  --unread: ${v("peach")};`,
    `  --selo-azul: ${v("blue")};`,
    `  --selo-parceiro: ${v("teal")};`,
    `  --selo-app: ${v("lavender")};`,
    `  --mencao-texto: ${v("accent")};`,
    `  --interruptor-trilho: ${v("surface2")};`,
    `  --interruptor-ligado: ${v("accent")};`,
    `  --interruptor-botao: ${p.dark ? v("text") : "#ffffff"};`,
    `  --interruptor-botao-ligado: ${p.dark ? v("crust") : "#ffffff"};`,
    `  --fundo-da-chamada: ${v("crust")};`,
    `  --fundo-da-chamada-forte: ${v("crust")};`,
    `  --brilho-da-chamada: color-mix(in srgb, ${v("accent")} 14%, transparent);`,
    `  --avatar-tone-1: ${v("green")};`,
    `  --avatar-tone-2: ${v("teal")};`,
    `  --avatar-tone-3: ${v("blue")};`,
    `  --avatar-tone-4: ${v("mauve")};`,
    `  --avatar-tone-5: ${v("peach")};`,
    `  --avatar-tone-6: ${v("pink")};`,
    `  --avatar-tone-text: ${v("crust")};`,
    `}`,
    ``,
    `/* O tema Brasa do Trivo pinta gradientes fixos; o Catppuccin usa a cor lisa. */`,
    `html:root[data-tema] .$shell { background: var(--background); }`,
    `html:root[data-tema] .$sidebarFooter { background: var(--surface-sidebar); border-top-color: var(--line); }`,
    `::selection { background: color-mix(in srgb, var(--ctp-accent) 35%, transparent); }`,
    ``,
  ];
  return lines.join("\n");
}

if (require.main === module) {
  const out = path.resolve(__dirname, "..", "src", "themes");
  for (const [id, p] of Object.entries(PALETTE)) {
    const file = path.join(out, `catppuccin-${id}.css`);
    fs.writeFileSync(file, css(id, p));
    console.log(`gerado ${path.relative(process.cwd(), file)}`);
  }
}
module.exports = { PALETTE, ACCENTS };
