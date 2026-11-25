// Escala toda a interface. O Trivo mede em rem, então mudar o tamanho-base da página escala tudo junto.
TrivoMod.definePlugin({
  name: "Escala da interface",
  description: "Aumenta ou diminui a interface inteira.",
  authors: ["TrivoMod"],
  defaultEnabled: false,
  settings: {
    percent: { type: "range", label: "Escala (%)", default: 100, min: 75, max: 150, step: 5 },
  },
  styles() {
    return `html:root { font-size: ${Number(this.options.get("percent")) || 100}% !important; }`;
  },
});
