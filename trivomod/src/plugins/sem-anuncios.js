// Esconde os anúncios do Trivo ("Do Trivo" / "Patrocinado"). Ligado por padrão.
// O Trivo 1.0.8 tem três espaços (componentes Sponsored* do módulo `…_7mVtHG`):
//   voiceSlot   - cartão acima de "Chamada de voz conectada" (SponsoredVoiceBanner)
//   membersSlot - cartão no fim da lista de membros (SponsoredMembersCard)
//   callTile    - quadro dentro da chamada (SponsoredCallTile)
// Com display:none o cartão não entra na tela, então o Trivo também não conta a impressão.
TrivoMod.definePlugin({
  name: "Sem anúncios",
  description: "Esconde os cartões \"Do Trivo\" e \"Patrocinado\" (canal de voz, lista de membros e chamada).",
  authors: ["TrivoMod"],
  defaultEnabled: true,
  settings: {
    voz: { type: "boolean", label: "Cartão do canal de voz", default: true },
    membros: { type: "boolean", label: "Cartão da lista de membros", default: true },
    chamada: { type: "boolean", label: "Quadro dentro da chamada", default: true },
  },
  styles() {
    const hide = [];
    if (this.options.get("voz") !== false) hide.push(".$voiceSlot", ".$voiceBanner");
    if (this.options.get("membros") !== false) hide.push(".$membersSlot", ".$membersCard");
    if (this.options.get("chamada") !== false) hide.push(".$callTile");
    return hide.length ? `${hide.join(",\n")} { display: none !important; }` : "";
  },
});
