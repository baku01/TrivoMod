#!/usr/bin/env node
"use strict";
// Ferramenta de desenvolvimento: réplica da tela logada do Trivo (classes reais dos CSS Modules do
// site) + o runtime do TrivoMod, para conferir layouts e temas sem conta.
//   node test/fixture-shell.js <saida.html> <pasta com os .css do Trivo> [--tema escuro|claro|brasa]
//        [--layout builtin:discord] [--themes id,id] [--plugins id,id] [--accent mauve] [--ajustes]
//   --ajustes: abre também a réplica do diálogo de Ajustes (classes e grupos reais do Trivo 1.0.8).
// Os .css do Trivo não vêm no repositório: baixe-os do site (a página /channels/dm lista os da área logada).
const fs = require("node:fs");
const path = require("node:path");
const library = require("../src/main/library");

const [out, cssDir, ...rest] = process.argv.slice(2);
if (!out || !cssDir) {
  console.error("uso: node test/fixture-shell.js <saida.html> <pasta-css> [opções]");
  process.exit(2);
}
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const list = (name) => (opt(name, "") || "").split(",").filter(Boolean);

const dist = path.resolve(__dirname, "..", "src");
const themes = library.listThemes(dist, "/nao/existe");
const layouts = library.listLayouts(dist, "/nao/existe");
const plugins = library.listPlugins(dist, "/nao/existe");
const runtime = fs.readFileSync(path.join(dist, "renderer", "index.js"), "utf8");
const settings = {
  version: 1,
  showButton: false,
  layout: opt("layout", ""),
  themes: Object.fromEntries(list("themes").map((id) => [id, true])),
  plugins: Object.fromEntries(list("plugins").map((id) => [id, true])),
  pluginSettings: { "builtin:catppuccin-destaque": { accent: opt("accent", "mauve") } },
  quickCss: "",
};
const boot = {
  settings,
  themes,
  layouts,
  plugins: plugins.map((p) => ({ id: p.id, builtin: p.builtin })),
  info: { version: "fixture", dataDir: "-", safeMode: false, platform: "darwin", customIcon: false },
};
const links = fs.readdirSync(cssDir).filter((f) => f.endsWith(".css")).map((f) => `<link rel="stylesheet" href="${path.join(cssDir, f)}">`).join("\n");

const icon = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="${d}"/></svg>`;
const hash = icon("M5 9h14M4 15h14M10 3 8 21M16 3l-2 18");
const servers = ["TR", "MG", "JV", "AR", "+"];
const msgs = [
  ["Ana", "A", "hoje às 08:10", ["Bom dia! Alguém viu o anúncio novo?", "Parece que agora dá pra criar Apps com o SDK."]],
  ["Bruno", "B", "hoje às 08:12", ["Vi sim, a parte de voz é bem completa."]],
  ["Carla", "C", "hoje às 08:15", ["Vou testar um bot de música mais tarde 🎵", "Quem topa entrar na call?"]],
];

// Ícones de traço no estilo dos do Trivo (a réplica não usa os SVGs originais).
const ICONS = {
  "Meu perfil": "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  "Conta e segurança": "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4",
  "Central da Família": "M16 21v-2a4 4 0 0 0-8 0v2M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 21v-2a3 3 0 0 0-3-3M2 21v-2a3 3 0 0 1 3-3",
  Lume: "M12 2l2 7 7 3-7 3-2 7-2-7-7-3 7-3z",
  Impulsos: "M6 3h12l4 6-10 12L2 9zM2 9h20M12 21 8 9l4-6 4 6z",
  Presentes: "M3 8h18v4H3zM5 12v9h14v-9M12 8v13M12 8S10 3 7.5 4 9 8 12 8zM12 8s2-5 4.5-4S15 8 12 8z",
  "Aparência": "M12 21a9 9 0 1 0 0-18v18zM12 3a9 9 0 0 1 0 18",
  "Voz e vídeo": "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  Avisos: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0",
  "Modo streamer": "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 3l18 18",
  Atalhos: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  "Inicialização e atualizações": "M12 3v12M7 10l5 5 5-5M5 21h14",
  Apps: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1",
  "Sobre o Trivo": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
};
const g = (title, items) => `<div class="Jt8rra_grupoDeAjustes" role="group"><p>${title}</p>${items
  .map(([label, cur]) => `<button type="button"${cur ? ' aria-current="true"' : ""}>${icon(ICONS[label] || "M12 8v8M8 12h8").replace("<svg", '<svg class="Jt8rra_iconeDaSecao"')}<span>${label}</span></button>`)
  .join("")}</div>`;
const ajustes = rest.includes("--ajustes")
  ? `<dialog class="Jt8rra_ajustesDialog" aria-labelledby="ajustes-modal-titulo"><div class="Jt8rra_ajustesGrade" data-vista="secao">
  <aside class="Jt8rra_ajustesNavegacao" aria-label="Seções dos ajustes">
    <div class="Jt8rra_cabecalhoDaNavegacao" data-cabecalho="modal"><h2>Ajustes</h2></div>
    <div class="Jt8rra_identidadeCompacta"><span class="Jt8rra_avatarPequeno">V</span><span><strong>Você</strong><small>@voce</small></span></div>
    ${g("Conta", [["Meu perfil"], ["Conta e segurança"], ["Central da Família"]])}
    ${g("Lume", [["Lume"], ["Impulsos"], ["Presentes"]])}
    ${g("Aplicativo", [["Aparência", true], ["Voz e vídeo"], ["Avisos"], ["Modo streamer"], ["Atalhos"], ["Inicialização e atualizações"]])}
    ${g("Desenvolvedor", [["Apps"]])}
    ${g("Sobre", [["Sobre o Trivo"]])}
    <div class="Jt8rra_grupoDeAjustes Jt8rra_signOutGroup"><button type="button" class="Jt8rra_sairNaLista">${icon("M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9").replace("<svg", '<svg class="Jt8rra_iconeDaSecao"')}Sair do Trivo</button></div>
  </aside>
  <div class="Jt8rra_ajustesConteudo">
    <header class="Jt8rra_barraDaSecao"><h2 id="ajustes-modal-titulo">Aparência</h2><button type="button" data-variante="icone" aria-label="Fechar ajustes" onclick="this.closest('dialog').close()">×</button></header>
    <div class="Jt8rra_corpoDaSecao"><p>Conteúdo da seção Aparência do Trivo.</p></div>
  </div></div></dialog>
<script>{ const d = document.querySelector("dialog");
  // O snapshot do WebKit não desenha a camada superior (showModal); --ajustes-foto abre como não modal, centralizado.
  if (${JSON.stringify(rest.includes("--ajustes-foto"))}) { d.setAttribute("open", ""); d.style.cssText = "position:fixed;inset:0;z-index:50;opacity:1;translate:none;scale:none"; document.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;inset:0;z-index:49;background:var(--surface-overlay)"></div>'); }
  else d.showModal(); }</script>`
  : "";

const html = `<!doctype html>
<html lang="pt-BR" data-tema="${opt("tema", "escuro")}">
<head><meta charset="utf-8"><title>shell</title>
${links}
<style>body{margin:0;height:100vh;display:flex;flex-direction:column;font-family:var(--font-ui)} .TlT3fq_shell{height:100vh} .TlT3fq_serverHeader{display:flex!important}
.OZ1fQW_bar{grid-column:1/-1;display:flex;align-items:flex-end;gap:6px} .OZ1fQW_item{display:flex;align-items:center;gap:8px;padding:0 12px;color:var(--text-primary);font-size:.8rem}
.ZjvRva_alvo{display:grid;place-items:center;position:relative;border-radius:14px} .ZjvRva_alvo:after{content:"";position:absolute}
.wrnr6W_messageMeta{display:flex;align-items:baseline;gap:6px} .TlT3fq_footerUserRow{display:flex;align-items:center;gap:8px;min-height:56px;padding:0 10px}
.TlT3fq_footerAvatar{width:32px;height:32px;border-radius:50%;background:var(--avatar-tone-3);display:block} .TlT3fq_footerNames{display:flex;flex-direction:column}
.TlT3fq_channelGroupRow{padding:12px 8px 4px} .TlT3fq_channelItems{display:flex;flex-direction:column;gap:2px}
.wrnr6W_messageAvatar{background:var(--avatar-tone-1)!important;color:var(--avatar-tone-text)!important}</style>
</head><body>
<div class="TlT3fq_shell">
  <div class="OZ1fQW_bar"><a data-variante="x" class="OZ1fQW_home" aria-current="page"></a><div class="OZ1fQW_item" data-active><span class="OZ1fQW_icon" data-shape="square">TR</span>Trivo Brasil</div></div>
  <nav class="TlT3fq_barraColumn"><div class="ZjvRva_barra"><ul class="ZjvRva_lista">
    ${servers.map((s, i) => `<li class="ZjvRva_item"><a class="ZjvRva_alvo" ${i === 0 ? "data-ativo" : ""} ${i === 2 ? "data-nao-lidas" : ""}><span class="ZjvRva_icone" ${s === "+" ? 'data-acao="sim"' : ""}>${s}</span></a></li>`).join("")}
  </ul></div></nav>
  <aside class="TlT3fq_sidebarColumn"><div class="TlT3fq_sidebar"><div class="TlT3fq_sidebarTopo">
    <div class="TlT3fq_serverHeader"><span class="TlT3fq_serverHeaderName">Trivo Brasil</span></div>
    <div class="TlT3fq_sidebarScroll">
      <div class="TlT3fq_channelGroup"><div class="TlT3fq_channelGroupRow"><h3 class="TlT3fq_channelGroupHeading"><span class="TlT3fq_channelGroupLabel">Canais de texto</span></h3></div>
        <div class="TlT3fq_channelItems">
          <a class="TlT3fq_channelLink TlT3fq_channelLinkActive"><span>${hash}</span><span class="TlT3fq_channelName">geral</span></a>
          <a class="TlT3fq_channelLink TlT3fq_channelLinkUnread"><span>${hash}</span><span class="TlT3fq_channelName">avisos</span></a>
          <a class="TlT3fq_channelLink"><span>${hash}</span><span class="TlT3fq_channelName">memes</span></a>
          <a class="TlT3fq_channelLink"><span>${hash}</span><span class="TlT3fq_channelName">música</span></a>
        </div></div>
      <div class="TlT3fq_channelGroup"><div class="TlT3fq_channelGroupRow"><h3 class="TlT3fq_channelGroupHeading"><span class="TlT3fq_channelGroupLabel">Canais de voz</span></h3></div>
        <div class="TlT3fq_channelItems"><a class="TlT3fq_channelLink"><span>${icon("M11 5 6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6")}</span><span class="TlT3fq_channelName">Sala geral</span></a></div></div>
    </div></div>
    <div class="TlT3fq_sidebarFooter"><div class="TlT3fq_footerUserRow"><span class="TlT3fq_footerAvatar"></span><div class="TlT3fq_footerNames"><span class="TlT3fq_footerDisplayName">Você</span><span class="TlT3fq_footerUsername">voce</span></div></div></div>
  </div></aside>
  <main class="TlT3fq_content"><div class="wrnr6W_chat">
    <header class="wrnr6W_chatHeader">${icon("M5 9h14M4 15h14M10 3 8 21M16 3l-2 18").replace("<svg", '<svg class="wrnr6W_chatHeaderIcone"')}<h1>geral</h1><span class="wrnr6W_chatHeaderTopico" style="display:block">Conversa geral do servidor</span></header>
    <div class="wrnr6W_areaDoCanal"><main style="display:flex;flex-direction:column;min-height:0">
      <ol class="wrnr6W_messageList">
        ${msgs.map(([name, ini, time, lines]) => lines.map((t, i) => i === 0
          ? `<li class="wrnr6W_message"><button class="wrnr6W_messageAvatar">${ini}</button><div class="wrnr6W_messageBody"><div class="wrnr6W_messageMeta"><button class="wrnr6W_messageAuthor">${name}</button><time class="wrnr6W_messageTime">${time}</time></div><div class="wrnr6W_messageContent">${t}</div></div></li>`
          : `<li class="wrnr6W_message" data-continuacao="sim"><time class="wrnr6W_messageTime" data-na-margem="sim" style="visibility:hidden">08:1x</time><div class="wrnr6W_messageBody"><div class="wrnr6W_messageContent">${t}</div></div></li>`).join("")).join("")}
        <li class="wrnr6W_message"><button class="wrnr6W_messageAvatar">D</button><div class="wrnr6W_messageBody"><div class="wrnr6W_messageMeta"><button class="wrnr6W_messageAuthor">Diego</button><time class="wrnr6W_messageTime">hoje às 08:20</time></div><div class="wrnr6W_messageContent">Eu topo, <span class="wrnr6W_mencao">@Carla</span>!</div></div></li>
      </ol>
      <div class="wrnr6W_composerWrap"><div class="wrnr6W_composer"><textarea class="wrnr6W_composerInput" rows="1" placeholder="Conversar em #geral"></textarea></div></div>
    </main></div>
  </div></main>
</div>
${ajustes}
<script>window.TrivoModNative = { boot: ${JSON.stringify(boot)}, saveSettings: async () => true, openFolder: async () => true, setIcon: async () => ({ ok: true }), resetIcon: async () => ({ ok: true }), onThemesChanged() {} };</script>
<script>${runtime}</script>
<script>${plugins.map((p) => `TrivoMod.__loadPlugin(${JSON.stringify(p.id)}, true, function () {\n${p.source}\n});`).join("\n")}
TrivoMod.__ready();</script>
</body></html>`;
fs.writeFileSync(out, html);
console.log(`gerado ${out}`);
