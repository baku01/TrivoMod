// Troca a cor de destaque (botões, seleção, foco) nos três temas do Trivo.
TrivoMod.definePlugin({
  name: "Cor de destaque",
  description: "Escolha a cor de destaque da interface, em qualquer tema.",
  authors: ["TrivoMod"],
  defaultEnabled: false,
  settings: {
    color: { type: "color", label: "Cor", default: "#b79cff" },
  },
  styles() {
    const c = this.options.get("color");
    if (!/^#[0-9a-f]{6}$/i.test(c)) return "";
    return `html:root[data-tema] {
      --accent: ${c};
      --accent-strong: color-mix(in srgb, ${c} 78%, #000);
      --focus-ring: ${c};
      --text-on-accent: ${TrivoMod.Utils.readableOn(c)};
    }`;
  },
});
