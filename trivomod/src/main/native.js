"use strict";
// Aparência nativa da janela.
//
// A janela do Trivo é uma BaseWindow com duas vistas: a "barra do casco" (trivo-shell://app/barra.html,
// 32 px, semáforos nativos no macOS e botões próprios no Windows/Linux) e a página do site. O mod:
//   - macOS: liga a translucidez do sistema (vibrancy "sidebar") atrás da janela;
//   - Windows 11 (build 22621+): liga o material Mica;
//   - deixa as duas vistas transparentes, para o material aparecer onde a página for translúcida
//     (o runtime pinta a página: trilho, barra do topo e canais translúcidos; conversa opaca);
//   - pinta a barra do casco com as cores que o runtime manda (`setFrame`), para ela e a barra de abas
//     do Trivo virarem uma faixa só, e dá aos botões do Windows o tamanho do Windows 11 (46 × 32);
//   - lê a cor de destaque do sistema e avisa a página quando ela muda.
// Linux e Windows 10: só cores e fonte (sem material).

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const BAR_URL = /^trivo-shell:\/\/app\/barra\.html/;
// Só cores calculadas pelo navegador: #hex, rgb()/rgba(), color(srgb …). Nada de url(), var() ou ";".
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?(\s*,\s*[\d.]+%?){2,3}\s*\)|rgba?\([\d.\s%/]+\)|color\(srgb(\s+[\d.]+%?){3}(\s*\/\s*[\d.]+%?)?\))$/i;
const color = (v) => (typeof v === "string" && v.length < 80 && COLOR.test(v.trim()) ? v.trim() : null);

function windowsBuild(release = os.release()) {
  const m = /^10\.0\.(\d+)/.exec(release);
  return m ? Number(m[1]) : 0;
}

/** rgb()/rgba()/#hex/color(srgb …) -> #rrggbb, para setBackgroundColor. */
function toHex(v) {
  if (typeof v !== "string") return null;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  let m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  if (m) return "#" + m.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec(v);
  if (m) return "#" + m.slice(1, 4).map((n) => Math.round(Math.min(1, Number(n)) * 255).toString(16).padStart(2, "0")).join("");
  return null;
}

/** Cor do sistema (RRGGBBAA do Electron) em #rrggbb. */
function hexAccent(raw) {
  return typeof raw === "string" && /^[0-9a-f]{6,8}$/i.test(raw) ? `#${raw.slice(0, 6).toLowerCase()}` : null;
}

function createNativeManager({ electron, log = () => {}, settings = () => ({}), allowed = new Set(), platform = process.platform, release = os.release(), paletteFile = null }) {
  const { app, systemPreferences, webContents } = electron;
  const BaseWindow = electron.BaseWindow || electron.BrowserWindow;
  const prefs = () => ({ enabled: true, translucent: true, systemFont: true, systemAccent: false, ...((settings() || {}).native || {}) });
  const material = platform === "darwin" ? "vibrancy" : platform === "win32" && windowsBuild(release) >= 22621 ? "mica" : "none";
  const done = new WeakSet();
  const hooked = new WeakSet();
  const barCss = new WeakMap(); // webContents da barra -> chave do insertCSS
  const barPage = new WeakMap(); // webContents da barra -> página que a pinta (para devolver os cliques)

  const isTrivo = (wc) => {
    try {
      return allowed.has(new URL(wc.getURL()).origin);
    } catch {
      return false;
    }
  };

  function accent() {
    try {
      return typeof systemPreferences.getAccentColor === "function" ? hexAccent(systemPreferences.getAccentColor()) : null;
    } catch {
      return null;
    }
  }

  function windowOf(wc) {
    for (const win of BaseWindow.getAllWindows()) {
      const views = (win.contentView && win.contentView.children) || [];
      if (views.some((v) => v.webContents === wc)) return { win, views };
    }
    return null;
  }

  /** Material + vistas transparentes, uma vez por janela. Sem translucidez, a janela pinta a cor do tema
   *  (o Trivo usa a cor dele antes de cada carregamento, o que pisca em outro tom). */
  function decorate(wc) {
    const p = prefs();
    if (p.enabled && palette && palette.pagina && !(p.translucent && material !== "none")) {
      const found = windowOf(wc);
      const hex = toHex(palette.pagina);
      if (found && hex) {
        try {
          found.win.setBackgroundColor(hex);
          const page = found.views.find((v) => v.webContents === wc);
          if (page && typeof page.setBackgroundColor === "function") page.setBackgroundColor(hex);
        } catch (error) {
          log("cor da janela:", error);
        }
      }
    }
    if (!p.enabled || !p.translucent || material === "none") return;
    const found = windowOf(wc);
    if (!found || done.has(found.win)) return;
    const { win, views } = found;
    try {
      if (material === "vibrancy") win.setVibrancy("sidebar");
      else win.setBackgroundMaterial("mica");
      win.setBackgroundColor("#00000000");
      for (const v of views) if (typeof v.setBackgroundColor === "function") v.setBackgroundColor("#00000000");
      done.add(win);
      log(`aparência nativa: ${material}`);
    } catch (error) {
      log("aparência nativa falhou:", error);
    }
  }

  function barOf(wc) {
    const found = windowOf(wc);
    if (!found) return null;
    const v = found.views.find((x) => x.webContents && x.webContents !== wc && BAR_URL.test(x.webContents.getURL()));
    return v ? v.webContents : null;
  }

  /** A página manda as cores da barra do topo dela; a barra do casco passa a usá-las. */
  async function setFrame(wc, payload) {
    const p = prefs();
    const early = paletteFrom(payload);
    const barBg = color(payload && payload.background);
    if (early) {
      if (barBg) early.barra = barBg;
      if (JSON.stringify(early) !== JSON.stringify(palette)) { palette = early; savePalette(); rethemeShellScreens(); }
    }
    const bar = barOf(wc);
    if (!bar || bar.isDestroyed()) return false;
    const bg = color(payload && payload.background);
    const fg = color(payload && payload.text);
    const dim = color(payload && payload.dim) || fg;
    const rules = [];
    if (p.enabled && bg && fg) {
      rules.push(`:root, :root[data-tema] { --fundo: ${bg} !important; --forte: ${fg} !important; --apagado: ${dim} !important; }`);
      rules.push(`body { background: ${bg} !important; }`);
    }
    if (p.enabled && p.systemFont) {
      rules.push(platform === "win32"
        ? `body { font: 400 12px/1 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif !important; }`
        : `body { font: 600 13px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif !important; -webkit-font-smoothing: antialiased; }
           @media (max-resolution: 1.5dppx) { body { -webkit-font-smoothing: subpixel-antialiased; } }`);
    }
    if (p.enabled && platform === "win32") {
      // Botões de legenda do Windows 11: 46 × 32, fechar vermelho #c42b1c.
      rules.push(`.controles button { width: 46px !important; } .controles svg { width: 10px; height: 10px; }`);
      rules.push(`.titulo { left: 12px !important; right: auto !important; text-align: left !important; font-weight: 400 !important; }`);
    }
    // Botões do mod na barra (como a caixa de entrada e a ajuda do Discord, no canto direito do título).
    rules.push(`#tm-acoes { display: flex !important; align-self: stretch !important; align-items: center !important; gap: 2px !important; margin-left: auto !important; padding: 0 8px !important;
        -webkit-app-region: no-drag !important; app-region: no-drag !important; }
      #tm-acoes:empty { display: none !important; }
      #tm-acoes + .controles { margin-left: 0 !important; }
      #tm-acoes button { position: relative !important; width: 28px !important; height: 24px !important; border-radius: 4px !important; color: var(--apagado) !important; }
      #tm-acoes button:hover { background: var(--realce) !important; color: var(--forte) !important; }
      #tm-acoes svg { width: 18px !important; height: 18px !important; stroke-width: 1.7 !important; stroke-linecap: round !important; stroke-linejoin: round !important; }
      #tm-acoes .tm-badge { position: absolute !important; right: 0 !important; top: 1px !important; min-width: 14px !important; height: 14px !important; padding: 0 3px !important; border-radius: 7px !important;
        background: #f23f43 !important; color: #fff !important; font: 700 9px/14px system-ui, sans-serif !important; }`);
    // Título com ícone e setas de voltar/avançar (Discord). No macOS as setas ficam depois dos semáforos.
    rules.push(`.titulo { display: flex !important; align-items: center !important; justify-content: center !important; gap: 6px !important; }
      .titulo svg { width: 16px !important; height: 16px !important; flex: none !important; fill: none !important; stroke: currentColor !important;
        stroke-width: 1.8 !important; stroke-linecap: round !important; stroke-linejoin: round !important; }
      #tm-nav { position: absolute !important; top: 0 !important; bottom: 0 !important; left: ${platform === "darwin" ? 76 : 8}px !important;
        display: flex !important; align-items: center !important; gap: 2px !important; -webkit-app-region: no-drag !important; app-region: no-drag !important; }
      #tm-nav:empty { display: none !important; }
      #tm-nav button { width: 24px !important; height: 24px !important; border-radius: 4px !important; color: var(--forte) !important; opacity: .8 !important; }
      #tm-nav button:hover:not(:disabled) { background: var(--realce) !important; opacity: 1 !important; }
      #tm-nav button:disabled { opacity: .3 !important; }
      #tm-nav svg { width: 16px !important; height: 16px !important; stroke-width: 2 !important; stroke-linecap: round !important; stroke-linejoin: round !important; }`);
    const css = rules.join("\n");
    try {
      const old = barCss.get(bar);
      if (old) await bar.removeInsertedCSS(old);
      barCss.delete(bar);
      if (css) barCss.set(bar, await bar.insertCSS(css, { cssOrigin: "user" }));
      await paintBar(bar, wc, payload || {});
      return true;
    } catch (error) {
      log("barra do casco:", error);
      return false;
    }
  }

  // Voltar/avançar pelo histórico da própria página (inclui as trocas de tela do site, pushState).
  const hist = (page) => page.navigationHistory || {
    canGoBack: () => page.canGoBack(), canGoForward: () => page.canGoForward(), goBack: () => page.goBack(), goForward: () => page.goForward(),
  };
  const lastPayload = new WeakMap(); // barra -> último payload
  const pagesHooked = new WeakSet();

  /** Título e botões. Tudo validado aqui e montado com textContent/DOM na barra (nada vira HTML). */
  function cleanButtons(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 4).filter((b) => b && /^[a-z-]{1,20}$/.test(b.id) && typeof b.label === "string" && b.label.length <= 40
      && typeof b.icon === "string" && /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,800}$/.test(b.icon))
      .map((b) => ({ id: b.id, label: b.label, icon: b.icon, badge: typeof b.badge === "string" ? b.badge.slice(0, 4) : "" }));
  }

  async function paintBar(bar, page, payload) {
    barPage.set(bar, page);
    if (!hooked.has(bar)) {
      hooked.add(bar);
      // A barra pede ações navegando; o Trivo ignora os endereços que não conhece, então o nosso passa direto.
      bar.on("will-navigate", (event, url) => {
        const m = /^trivo-casco:\/\/trivomod\/([a-z-]{1,20})$/.exec(String(url));
        if (!m) return;
        event.preventDefault();
        const target = barPage.get(bar);
        if (!target || target.isDestroyed()) return;
        try {
          if (m[1] === "voltar") { if (hist(target).canGoBack()) hist(target).goBack(); return; }
          if (m[1] === "avancar") { if (hist(target).canGoForward()) hist(target).goForward(); return; }
        } catch (error) {
          log("histórico:", error);
          return;
        }
        target.send("trivomod:frame-action", m[1]);
      });
    }
    lastPayload.set(bar, payload);
    if (!pagesHooked.has(page)) {
      pagesHooked.add(page);
      // Depois de cada troca de tela, as setas mudam de estado (o título chega pelo runtime).
      const repaint = () => setTimeout(() => {
        if (bar.isDestroyed() || page.isDestroyed()) return;
        paintBar(bar, page, lastPayload.get(bar) || {}).catch(() => {});
      }, 50);
      page.on("did-navigate-in-page", repaint);
      page.on("did-navigate", repaint);
    }
    let canBack = false;
    let canForward = false;
    try {
      canBack = hist(page).canGoBack();
      canForward = hist(page).canGoForward();
    } catch {
      /* sem histórico */
    }
    const icon = (v) => (typeof v === "string" && /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]{1,1600}$/.test(v) ? v : "");
    const data = {
      title: typeof payload.title === "string" && payload.title.trim() ? payload.title.trim().slice(0, 80) : "Trivo",
      titleIcon: icon(payload.titleIcon),
      buttons: cleanButtons(payload.buttons),
      nav: Array.isArray(payload.nav)
        ? payload.nav.filter((b) => b && (b.id === "voltar" || b.id === "avancar"))
          .map((b) => ({ id: b.id, label: b.id === "voltar" ? "Voltar" : "Avançar", disabled: b.id === "voltar" ? !canBack : !canForward }))
        : [],
    };
    await bar.executeJavaScript(`(() => {
      const d = ${JSON.stringify(data)};
      const ns = "http://www.w3.org/2000/svg";
      const svgOf = (dPath) => {
        const svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(ns, "path"); path.setAttribute("d", dPath); svg.append(path); return svg;
      };
      const t = document.querySelector(".titulo");
      if (t) {
        const label = document.createElement("span"); label.textContent = d.title;
        t.replaceChildren(...(d.titleIcon ? [svgOf(d.titleIcon)] : []), label);
      }
      let nav = document.getElementById("tm-nav");
      if (!nav) { nav = document.createElement("div"); nav.id = "tm-nav"; document.body.prepend(nav); }
      nav.replaceChildren(...d.nav.map((b) => {
        const el = document.createElement("button");
        el.type = "button"; el.title = b.label; el.setAttribute("aria-label", b.label); el.disabled = b.disabled;
        el.append(svgOf(b.id === "voltar" ? "M19 12H5M11 6l-6 6 6 6" : "M5 12h14M13 6l6 6-6 6"));
        el.addEventListener("click", () => { location.href = "trivo-casco://trivomod/" + b.id; });
        return el;
      }));
      let box = document.getElementById("tm-acoes");
      if (!box) {
        box = document.createElement("div");
        box.id = "tm-acoes";
        const c = document.getElementById("controles");
        document.body.insertBefore(box, c && c.isConnected ? c : null);
      }
      box.replaceChildren(...d.buttons.map((b) => {
        const el = document.createElement("button");
        el.type = "button"; el.title = b.label; el.setAttribute("aria-label", b.label);
        const svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(ns, "path"); path.setAttribute("d", b.icon); svg.append(path); el.append(svg);
        if (b.badge) { const s = document.createElement("span"); s.className = "tm-badge"; s.textContent = b.badge; el.append(s); }
        el.addEventListener("click", () => { location.href = "trivo-casco://trivomod/" + b.id; });
        return el;
      }));
    })()`, false);
  }

  // ------------------------------------------------------------ telas do casco (permissões, avisos…)
  // O Trivo desenha perguntas como "pode usar o microfone?" numa tela própria (trivo-shell://app/dialogo.html),
  // fora da página: os temas não chegam lá. Elas recebem as cores que a página mandou por último.
  // Todas as telas próprias do Trivo, menos a barra (que tem tratamento à parte): carregamento, chamada
  // recebida, seletor de tela, aviso de tela cheia, teste de som, pendência e diálogos.
  const SHELL_SCREEN = /^trivo-shell:\/\/app\/(dialogo|picker|pendencia|fullscreen-notice|bootstrap|inicializacao|chamada|teste-de-som)\.html/;
  const KEYS = ["barra", "pagina", "fundo", "cartao", "forte", "apagado", "acento", "sobreAcento", "borda"];
  function paletteFrom(payload) {
    const c = (payload && payload.colors) || payload || {};
    const out = {};
    for (const k of KEYS) {
      const v = color(c[k]);
      if (v) out[k] = v;
    }
    if (!out.pagina) out.pagina = out.cartao;
    return out.cartao && out.forte && out.acento ? out : null;
  }
  // A última paleta fica no disco: a tela de carregamento abre antes de a página mandar as cores.
  let palette = null;
  try {
    if (paletteFile) palette = paletteFrom(JSON.parse(fs.readFileSync(paletteFile, "utf8")));
  } catch {
    palette = null;
  }
  function savePalette() {
    if (!paletteFile || !palette) return;
    try {
      fs.mkdirSync(path.dirname(paletteFile), { recursive: true });
      fs.writeFileSync(paletteFile, JSON.stringify(palette));
    } catch (error) {
      log("paleta:", error);
    }
  }
  const shellCss = new WeakMap();

  /** CSS de uma tela do casco: cada tela usa os seus nomes de variável. */
  function shellScreenCss(screen, p) {
    const font = platform === "win32" ? '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' : "-apple-system, BlinkMacSystemFont, system-ui, sans-serif";
    const mix = (a, b, pct) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
    const apagado = p.apagado || p.forte;
    const borda = p.borda || mix(p.forte, "transparent", 12);
    const radius = platform === "win32" ? 4 : 6;
    const rules = [`body { font-family: ${font} !important; -webkit-font-smoothing: antialiased; font-optical-sizing: auto; }
      @media (max-resolution: 1.5dppx) { body { -webkit-font-smoothing: subpixel-antialiased; } }`];
    if (screen === "picker" || screen === "fullscreen-notice") {
      rules.unshift(`:root { --bg: ${p.cartao} !important; --field: ${mix(p.forte, "transparent", 5)} !important; --line: ${borda} !important;
        --line-strong: ${borda} !important; --strong: ${p.forte} !important; --muted: ${apagado} !important; --faint: ${mix(apagado, "transparent", 75)} !important;
        --accent: ${p.acento} !important; --on-accent: ${p.sobreAcento || "#fff"} !important; --focus: ${p.acento} !important;
        --switch-on: ${p.acento} !important; --switch-knob-on: #fff !important; }`);
      if (screen === "picker") {
        // Seletor de tela no jeito do Discord: segmentos transparentes, o escolhido com o destaque; cartões com borda
        // do destaque quando escolhidos; Cancelar neutro e Transmitir com o destaque. Tudo com prioridade, para nenhum
        // estilo de botão genérico esconder o estado escolhido.
        const hover = mix(p.forte, "transparent", 8);
        rules.push(`.dialog { border-radius: 12px !important; border-color: ${borda} !important; }
          :is(.kind, .segmented) { border: 0 !important; border-radius: 8px !important; background: ${mix(p.forte, "transparent", 6)} !important; }
          :is(.kind, .segmented) button { background: transparent !important; color: ${apagado} !important; border-radius: 6px !important; }
          :is(.kind, .segmented) button:hover:not(:disabled) { background: ${hover} !important; color: ${p.forte} !important; }
          :is(.kind, .segmented) button[aria-pressed="true"] { background: ${p.acento} !important; color: ${p.sobreAcento || "#fff"} !important; }
          .segmented button:disabled { background: transparent !important; }
          .card { border-radius: 8px !important; border-color: transparent !important; background: ${mix(p.forte, "transparent", 5)} !important; }
          .card:hover { background: ${hover} !important; }
          .card[aria-pressed="true"] { border-color: ${p.acento} !important; box-shadow: inset 0 0 0 2px ${p.acento} !important;
            background: ${mix(p.acento, "transparent", 14)} !important; }
          .frame { border-radius: 6px !important; }
          footer button { height: 38px !important; border-radius: ${radius}px !important; }
          footer .secondary { border: 0 !important; background: ${mix(p.forte, "transparent", 10)} !important; color: ${p.forte} !important; }
          footer .secondary:hover { background: ${mix(p.forte, "transparent", 16)} !important; }
          footer .primary { background: ${p.acento} !important; color: ${p.sobreAcento || "#fff"} !important; }`);
      } else {
        rules.push(`button { border-radius: ${radius}px !important; }`);
      }
    } else {
      // Diálogo e teste de som são uma caixa sobre a janela: o fundo é o cartão. As outras ocupam a janela: fundo da página.
      const fundo = screen === "dialogo" || screen === "teste-de-som" ? p.cartao : p.pagina;
      rules.unshift(`:root, :root[data-tema] { --fundo: ${fundo} !important; --cartao: ${p.cartao} !important; --forte: ${p.forte} !important;
        --apagado: ${apagado} !important; --tenue: ${mix(apagado, "transparent", 80)} !important; --acento: ${p.acento} !important;
        --acento-forte: ${mix(p.acento, "#fff", 85)} !important; --focus: ${p.acento} !important;
        --sobre-acento: ${p.sobreAcento || "#ffffff"} !important; --borda: ${borda} !important; }`);
      if (screen === "pendencia") rules.push(`body { background: var(--fundo) !important; }`);
      if (screen === "dialogo") {
        rules.push(`.caixa { border-radius: 8px !important; border-color: ${borda} !important; }`);
        rules.push(`.botoes button { border-radius: ${radius}px !important; }`);
        rules.push(`.botoes button:not([data-acao]) { background: ${mix(p.forte, "transparent", 10)} !important; border-color: transparent !important; }`);
      }
    }
    return rules.join("\n");
  }

  async function themeShellScreen(wc) {
    if (!palette || !prefs().enabled || wc.isDestroyed()) return;
    const m = SHELL_SCREEN.exec(wc.getURL());
    if (!m) return;
    try {
      const old = shellCss.get(wc);
      if (old) await wc.removeInsertedCSS(old);
      shellCss.set(wc, await wc.insertCSS(shellScreenCss(m[1], palette), { cssOrigin: "user" }));
    } catch (error) {
      log("tela do casco:", error);
    }
  }
  const isShellScreen = (wc) => {
    try {
      return SHELL_SCREEN.test(wc.getURL());
    } catch {
      return false;
    }
  };
  function rethemeShellScreens() {
    for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && isShellScreen(wc)) themeShellScreen(wc);
  }
  const isBar = (wc) => {
    try {
      return BAR_URL.test(wc.getURL());
    } catch {
      return false;
    }
  };
  /** Na abertura (durante o carregamento), pinta a barra com a última paleta salva antes de a página responder. */
  async function prethemeBar(wc) {
    if (!palette || !prefs().enabled || wc.isDestroyed() || barCss.has(wc)) return;
    const bg = palette.barra || palette.pagina;
    if (!bg || !palette.forte) return;
    const dim = palette.apagado || palette.forte;
    const css = `:root, :root[data-tema] { --fundo: ${bg} !important; --forte: ${palette.forte} !important; --apagado: ${dim} !important; }
      body { background: ${bg} !important; }`;
    try {
      barCss.set(wc, await wc.insertCSS(css, { cssOrigin: "user" }));
    } catch (error) {
      log("barra inicial:", error);
    }
  }

  function broadcastAccent() {
    const value = accent();
    for (const wc of webContents.getAllWebContents()) {
      try {
        if (!wc.isDestroyed() && isTrivo(wc)) wc.send("trivomod:system-accent", value);
      } catch {
        /* contents sumiu */
      }
    }
  }

  function start() {
    app.on("web-contents-created", (_event, wc) => {
      const check = () => {
        if (!wc.isDestroyed() && isTrivo(wc)) decorate(wc);
      };
      wc.on("dom-ready", check);
      wc.on("did-navigate", check);
      wc.on("dom-ready", () => {
        if (wc.isDestroyed()) return;
        if (isShellScreen(wc)) themeShellScreen(wc);
        else if (isBar(wc)) prethemeBar(wc);
      });
    });
    try {
      if (platform === "win32" && typeof systemPreferences.on === "function") systemPreferences.on("accent-color-changed", broadcastAccent);
      if (platform === "darwin" && typeof systemPreferences.subscribeNotification === "function") {
        systemPreferences.subscribeNotification("AppleColorPreferencesChangedNotification", () => setTimeout(broadcastAccent, 200));
      }
    } catch (error) {
      log("cor do sistema:", error);
    }
  }

  function info() {
    const p = prefs();
    return { ...p, platform, material, systemAccentColor: accent(), windows11: platform === "win32" && windowsBuild(release) >= 22000 };
  }

  return { start, info, setFrame, decorate };
}

module.exports = { createNativeManager, windowsBuild, hexAccent, toHex, COLOR };
