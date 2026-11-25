// Troca a fonte da interface por uma instalada no seu computador.
// A CSP do Trivo (font-src 'self') impede fontes de fora, então só valem fontes do sistema.
const STACKS = {
  sistema: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`,
  arial: `Arial, sans-serif`,
  trebuchet: `"Trebuchet MS", sans-serif`,
  georgia: `Georgia, "Times New Roman", serif`,
  mono: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`,
};

TrivoMod.definePlugin({
  name: "Fonte da interface",
  description: "Muda a fonte do texto da interface para uma do sistema.",
  authors: ["TrivoMod"],
  defaultEnabled: false,
  settings: {
    fonte: {
      type: "select",
      label: "Fonte",
      default: "sistema",
      options: [
        { label: "Sistema", value: "sistema" },
        { label: "Arial", value: "arial" },
        { label: "Trebuchet MS", value: "trebuchet" },
        { label: "Georgia (serifada)", value: "georgia" },
        { label: "Monoespaçada", value: "mono" },
      ],
    },
  },
  styles() {
    const stack = STACKS[this.options.get("fonte")] || STACKS.sistema;
    return `html:root { --font-ui: ${stack}; }`;
  },
});
