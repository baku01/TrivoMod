// Escolhe a cor de destaque dos temas Catppuccin entre os 14 acentos oficiais.
// Só tem efeito com um tema Catppuccin ligado (ele define as variáveis --ctp-*).
const ACCENTS = [
  ["rosewater", "Rosewater"], ["flamingo", "Flamingo"], ["pink", "Pink"], ["mauve", "Mauve"],
  ["red", "Red"], ["maroon", "Maroon"], ["peach", "Peach"], ["yellow", "Yellow"],
  ["green", "Green"], ["teal", "Teal"], ["sky", "Sky"], ["sapphire", "Sapphire"],
  ["blue", "Blue"], ["lavender", "Lavender"],
];

TrivoMod.definePlugin({
  name: "Catppuccin: destaque",
  description: "Cor de destaque dos temas Catppuccin (os 14 acentos oficiais). Ligue junto com um tema Catppuccin.",
  authors: ["TrivoMod"],
  defaultEnabled: false,
  settings: {
    accent: { type: "select", label: "Acento", default: "mauve", options: ACCENTS.map(([value, label]) => ({ value, label })) },
  },
  styles() {
    const accent = this.options.get("accent");
    if (!ACCENTS.some(([value]) => value === accent)) return "";
    return `html:root[data-tema] { --ctp-accent: var(--ctp-${accent}); }`;
  },
});
