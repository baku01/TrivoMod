// Runtime do TrivoMod. Roda no mundo principal da página, em document-start.
// Estilos entram por `adoptedStyleSheets` (CSSOM): não passam pela regra de <style> da CSP.
(() => {
  "use strict";
  const native = window.TrivoModNative;
  if (!native || window.TrivoMod) return;

  const boot = native.boot;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const settings = clone(boot.settings);
  settings.themes = settings.themes || {};
  settings.plugins = settings.plugins || {};
  settings.pluginSettings = settings.pluginSettings || {};
  settings.quickCss = settings.quickCss || "";
  settings.layout = settings.layout || "";
  settings.native = { enabled: true, translucent: true, systemFont: true, systemAccent: false, ...(settings.native || {}) };
  settings.themeLinks = Array.isArray(settings.themeLinks) ? settings.themeLinks : [];
  let themes = clone(boot.themes);
  let layouts = clone(boot.layouts || []);

  const log = (...a) => console.log("[TrivoMod]", ...a);
  const err = (...a) => console.error("[TrivoMod]", ...a);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const byModule = (name) => `:is([class$="_${name}"],[class*="_${name} "])`;

  // Eventos do mod para plugins: TrivoMod.on("theme" | "layout" | "plugin" | "settings", cb).
  const bus = new Map();
  function emit(type, payload) {
    for (const cb of bus.get(type) || []) {
      try { cb(payload); } catch (e) { err(`ouvinte de ${type} falhou:`, e); }
    }
  }
  function on(type, cb) {
    if (!bus.has(type)) bus.set(type, new Set());
    bus.get(type).add(cb);
    return () => bus.get(type).delete(cb);
  }

  // ------------------------------------------------------------ ajustes
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => native.saveSettings(clone(settings)).catch((e) => err("não salvou os ajustes:", e)), 250);
  }

  // ------------------------------------------------------------ estilos
  // O Trivo usa CSS Modules: a classe real é `<hash>_nome` (ex.: `TlT3fq_shell`) e o hash muda a cada
  // versão. Em temas, layouts, plugins e CSS rápido, `.$nome` vira um seletor que casa só o nome.
  const expandModules = (css) =>
    String(css).replace(/\.\$([A-Za-z][A-Za-z0-9]*)/g, (_m, name) => `:is([class$="_${name}"],[class*="_${name} "])`);

  const sheets = new Map();
  function sheet(key, css) {
    let s = sheets.get(key);
    if (!s) sheets.set(key, (s = new CSSStyleSheet()));
    try {
      s.replaceSync(expandModules(css));
    } catch (e) {
      err(`CSS inválido em ${key}:`, e);
    }
    return s;
  }

  function applyStyles() {
    const wanted = [];
    // Ordem: layout (estrutura e paleta-base) -> temas (cores) -> plugins -> CSS rápido.
    const layout = layouts.find((l) => l.id === settings.layout);
    if (layout) wanted.push(sheet(`layout:${layout.id}`, layout.css));
    const theme = activeTheme();
    if (theme) wanted.push(sheet(`theme:${theme.id}`, theme.css));
    const nat = nativeCss();
    if (nat) wanted.push(sheet("native", nat));
    for (const p of plugins.values()) {
      if (!p.started || !p.def.styles) continue;
      try {
        const css = typeof p.def.styles === "function" ? p.def.styles.call(p.def) : p.def.styles;
        if (css) wanted.push(sheet(`plugin:${p.id}`, String(css)));
      } catch (e) {
        err(`styles de ${p.id} falhou:`, e);
      }
    }
    if (settings.quickCss.trim()) wanted.push(sheet("quick", settings.quickCss));
    // Enquanto uma seção do TrivoMod está aberta nos Ajustes, a seção do Trivo deixa de parecer selecionada.
    wanted.unshift(sheet("core", `[data-trivomod-ativo] button[aria-current]:not([data-trivomod]) { background: transparent !important; color: var(--text-secondary) !important; }
      [data-trivomod-ativo] button[aria-current]:not([data-trivomod]) svg { color: inherit !important; }
      #trivomod-settings-view[hidden] { display: none !important; }`));
    const mine = new Set(sheets.values());
    document.adoptedStyleSheets = [...document.adoptedStyleSheets.filter((s) => !mine.has(s)), ...wanted];
    queueFrame();
    queueThemeIcon();
  }

  // ------------------------------------------------------------ temas: um por vez
  // Dois temas brigam pelas mesmas cores, então a escolha é única (como o layout). O formato salvo
  // continua `{ id: true }`; ao escolher, os outros viram false.
  function activeTheme() {
    return themes.find((t) => settings.themes[t.id] === true) || null;
  }
  function chooseTheme(id) {
    for (const k of Object.keys(settings.themes)) settings.themes[k] = false;
    if (id) settings.themes[id] = true;
    save();
    applyStyles();
    emit("theme", id || "");
  }

  // ------------------------------------------------------------ aparência nativa
  // O processo principal liga o material do sistema (macOS: translucidez; Windows 11: Mica) e deixa
  // a janela transparente. Aqui a página fica translúcida onde um app nativo é: barra do topo,
  // trilho de servidores e canais. A conversa continua opaca.
  const nativeInfo = boot.info.native || null;
  const plat = boot.info.platform === "darwin" ? "mac" : boot.info.platform === "win32" ? "win" : "linux";
  let systemAccent = (nativeInfo && nativeInfo.systemAccentColor) || null;
  const SYSTEM_FONT = plat === "mac"
    ? `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif`
    : plat === "win" ? `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` : `system-ui, "Cantarell", "Ubuntu", sans-serif`;
  const translucentNow = () =>
    Boolean(settings.native.enabled && settings.native.translucent && nativeInfo && nativeInfo.material !== "none" && nativeInfo.enabled && nativeInfo.translucent);

  function nativeCss() {
    const n = settings.native;
    if (!n.enabled) return "";
    const out = [];
    if (n.systemFont) out.push(`html:root { --font-ui: ${SYSTEM_FONT} !important; }`);
    if (n.systemAccent && systemAccent) {
      out.push(`html:root[data-tema], html:root { --accent: ${systemAccent} !important; --accent-strong: color-mix(in srgb, ${systemAccent} 82%, #000) !important;
        --focus-ring: ${systemAccent} !important; --ctp-accent: ${systemAccent} !important; }`);
    }
    if (translucentNow()) {
      const glass = (v, pct) => `color-mix(in srgb, ${v} ${pct}%, transparent) !important`;
      const discord = settings.layout === "builtin:discord";
      // O fundo translúcido fica no próprio .$shell: assim o canto arredondado do .$content não deixa
      // triângulo escuro ("rebarba") atrás dele, e o trilho não empilha transparência duas vezes.
      out.push(`html:root, html:root body { background: transparent !important; }
        html:root .$shell { background: ${glass("var(--surface-sidebar)", 66)}; }
        html:root .$barraColumn > .$barra,
        html:root .$shell > .$sidebarColumn { background: transparent !important; }
        ${discord
          ? `html:root .$shell > .$bar, html:root .$shell > .$barraColumn { background: transparent !important; }
             html:root .$sidebarColumn .$sidebarScroll .$buscaDoInicio { background: transparent !important; backdrop-filter: blur(12px); }`
          : `html:root .$shell > .$bar, html:root .$shell > .$barraColumn { background: ${glass("var(--tm-rail, var(--surface-base))", 58)}; }
             html:root .$shell > .$rodapeDaNavegacao { background: transparent !important; }`}
        html:root .$shell > .$content { background: var(--background) !important; }`);
    }
    return out.join("\n");
  }

  // A barra do casco (título da janela, desenhada pelo Trivo fora da página) recebe as cores da barra
  // de abas, e as duas viram uma faixa só.
  let frameTimer = 0;
  function queueFrame() {
    clearTimeout(frameTimer);
    frameTimer = setTimeout(pushFrame, 150);
  }
  const BELL = "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0";
  const STAR = "M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z";
  const opaque = (c) => c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c);
  /** Layout Discord: a barra de título leva o nome da tela e os botões (Avisos, TrivoMod), como no Discord. */
  const discordFrame = () => settings.layout === "builtin:discord" && document.documentElement && document.documentElement.dataset.barra !== "recolhida";
  function frameData() {
    if (!discordFrame()) return { title: "", buttons: [], nav: [] };
    const h1 = document.querySelector(`${byModule("content")} header h1, ${byModule("chatHeader")} h1`);
    // Ícone do título: o do cabeçalho da tela (amigos, # do canal…), só os traços <path>.
    const head = h1 && h1.closest("header");
    // O ícone visível que vem antes do título (o "≡" do menu de celular fica escondido no desktop).
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const svg = head && ([...head.querySelectorAll('svg[class*="Icone"], svg[class*="icone"]')].find(visible)
      || [...head.querySelectorAll("svg")].find((el) => visible(el) && (el.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING)));
    const titleIcon = svg && (svg.getAttribute("viewBox") || "0 0 24 24") === "0 0 24 24"
      ? [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d") || "").join(" ").trim() : "";
    const nv = window.navigation;
    const nav = [
      { id: "voltar", disabled: nv && "canGoBack" in nv ? !nv.canGoBack : false },
      { id: "avancar", disabled: nv && "canGoForward" in nv ? !nv.canGoForward : false },
    ];
    const bell = document.querySelector(`${byModule("shell")} > ${byModule("bar")} ${byModule("bell")}`);
    const badge = bell && bell.querySelector('[class*="_badge"], [class*="_bellDot"], [class*="_unreadDot"]');
    const buttons = [];
    if (bell) buttons.push({ id: "avisos", label: "Avisos", icon: BELL, badge: badge ? (badge.textContent || "").trim() || "•" : "" });
    if (settings.showButton !== false) buttons.push({ id: "trivomod", label: "TrivoMod", icon: STAR });
    return { title: h1 ? h1.textContent.trim() : "", titleIcon, buttons, nav };
  }
  // Cores do tema já resolvidas pelo navegador (var() e color-mix viram rgb), para as telas do casco.
  function resolvedColors() {
    const probe = document.createElement("i");
    probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
    document.body.append(probe);
    const get = (expr, prop = "color") => { probe.style[prop] = ""; probe.style[prop] = expr; return getComputedStyle(probe)[prop]; };
    const out = {
      pagina: get("var(--background)"),
      fundo: get("var(--surface-overlay, #000)"),
      cartao: get("var(--surface-raised, var(--background))"),
      forte: get("var(--text-primary)"),
      apagado: get("var(--text-secondary)"),
      acento: get("var(--accent)"),
      sobreAcento: get("var(--text-on-accent, #fff)"),
      borda: get("var(--line-strong)"),
    };
    probe.remove();
    // O fundo da tela do diálogo fica atrás da caixa: usa a cor do cartão, opaca.
    out.fundo = out.cartao;
    return out;
  }
  let lastFrameKey = "";
  function pushFrame() {
    if (typeof native.setFrame !== "function" || !document.body) return;
    const bar = document.querySelector(`${byModule("shell")} > ${byModule("bar")}`);
    const rail = document.querySelector(`${byModule("shell")} > ${byModule("barraColumn")}`);
    const shell = document.querySelector(byModule("shell"));
    // A cor vem da faixa que fica logo abaixo do título: a barra de abas, o trilho ou o shell.
    let background = null;
    for (const el of [bar && bar.offsetHeight > 0 ? bar : null, rail, shell, document.body, document.documentElement]) {
      const c = el && getComputedStyle(el).backgroundColor;
      if (opaque(c)) { background = c; break; }
    }
    const text = getComputedStyle(document.body).color;
    const data = frameData();
    lastFrameKey = JSON.stringify(data); // a chave não inclui as cores (senão todo desenho pareceria mudança)
    data.colors = resolvedColors();
    native.setFrame({ background: background || "rgb(0, 0, 0)", text, dim: text, ...data })
      .then((ok) => {
        if (document.documentElement) document.documentElement.toggleAttribute("data-tm-frame", Boolean(ok && data.buttons.length));
      })
      .catch(() => {});
  }


  // ------------------------------------------------------------ plugins
  const plugins = new Map();
  let loadingId = null;
  let loadingBuiltin = false;

  const isEnabled = (p) => (typeof settings.plugins[p.id] === "boolean" ? settings.plugins[p.id] : p.builtin && p.def.defaultEnabled === true);

  function optionGet(p, key) {
    const store = settings.pluginSettings[p.id];
    if (store && has(store, key)) return store[key];
    const spec = p.def.settings && p.def.settings[key];
    return spec ? spec.default : undefined;
  }

  function optionSet(p, key, value) {
    (settings.pluginSettings[p.id] = settings.pluginSettings[p.id] || {})[key] = value;
    save();
    for (const k of [key, "*"]) for (const cb of (p.subs.get(k) || [])) {
      try { cb(value, key); } catch (e) { err(`${p.id}: ouvinte de ${key} falhou:`, e); }
    }
    try {
      if (p.started && typeof p.def.settingsChanged === "function") p.def.settingsChanged(key, value);
    } catch (e) {
      err(`${p.id}.settingsChanged falhou:`, e);
    }
    applyStyles();
  }

  function startPlugin(p) {
    if (p.started) return;
    p.error = null;
    try {
      if (typeof p.def.start === "function") p.def.start();
      p.started = true;
    } catch (e) {
      p.error = String((e && e.message) || e);
      err(`plugin ${p.id} falhou ao iniciar:`, e);
    }
    applyStyles();
  }

  function stopPlugin(p) {
    if (!p.started) return;
    try {
      if (typeof p.def.stop === "function") p.def.stop();
    } catch (e) {
      err(`plugin ${p.id} falhou ao parar:`, e);
    }
    p.started = false;
    applyStyles();
  }

  function setPluginEnabled(p, enabled) {
    settings.plugins[p.id] = enabled;
    save();
    if (enabled) startPlugin(p);
    else stopPlugin(p);
    emit("plugin", { id: p.id, enabled });
  }

  function definePlugin(def) {
    if (!loadingId) throw new Error("definePlugin só pode ser chamado enquanto o arquivo do plugin carrega.");
    if (!def || typeof def.name !== "string") throw new Error("o plugin precisa de `name`.");
    const p = { id: loadingId, builtin: loadingBuiltin, def, started: false, error: null, subs: new Map() };
    def.options = {
      get: (key) => optionGet(p, key),
      set: (key, value) => optionSet(p, key, value),
      /** Avisa quando a opção muda (`"*"` = qualquer uma). Devolve quem cancela. */
      subscribe(key, cb) {
        if (!p.subs.has(key)) p.subs.set(key, new Set());
        p.subs.get(key).add(cb);
        return () => p.subs.get(key).delete(cb);
      },
    };
    // Como o `settings.store` do Vencord: ler devolve o valor (ou o padrão), escrever salva e avisa.
    const keys = () => Object.keys(def.settings || {});
    def.store = new Proxy({}, {
      get: (_t, k) => (typeof k === "string" ? optionGet(p, k) : undefined),
      set: (_t, k, v) => { optionSet(p, String(k), v); return true; },
      has: (_t, k) => keys().includes(k),
      ownKeys: () => keys(),
      getOwnPropertyDescriptor: (_t, k) => (keys().includes(k) ? { enumerable: true, configurable: true, writable: true, value: optionGet(p, k) } : undefined),
    });
    plugins.set(p.id, p);
    return def;
  }

  // ------------------------------------------------------------ utilidades para plugins
  const Utils = {
    /** Resolve com o primeiro elemento que casa com o seletor, esperando o DOM se preciso. */
    waitFor(selector, { timeout = 10000, root = document } = {}) {
      return new Promise((resolve, reject) => {
        const found = root.querySelector(selector);
        if (found) return resolve(found);
        const obs = new MutationObserver(() => {
          const el = root.querySelector(selector);
          if (el) {
            obs.disconnect();
            clearTimeout(timer);
            resolve(el);
          }
        });
        const timer = setTimeout(() => {
          obs.disconnect();
          reject(new Error(`timeout esperando ${selector}`));
        }, timeout);
        obs.observe(document.documentElement, { childList: true, subtree: true });
      });
    },
    /** Escolhe preto ou branco conforme o contraste com a cor de fundo `#rrggbb`. */
    readableOn(hex) {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex);
      if (!m) return "#000";
      const n = parseInt(m[1], 16);
      const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
      return lum > 0.6 ? "#0c110f" : "#fff";
    },
  };

  // ------------------------------------------------------------ interface
  const UI_CSS = `
    :host { all: initial; --tm-font: var(--font-ui, system-ui, sans-serif); --tm-radius: 12px; --tm-ctl-radius: 6px;
      --tm-accent: var(--accent, #7aa2f7); --tm-on-accent: var(--text-on-accent, #fff); }
    :host([data-plat=mac]) { --tm-radius: 12px; --tm-ctl-radius: 6px; }
    :host([data-plat=win]) { --tm-radius: 8px; --tm-ctl-radius: 4px; }
    :host([data-font=system][data-plat=mac]) { --tm-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
    :host([data-font=system][data-plat=win]) { --tm-font: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
    * { box-sizing: border-box; font-family: var(--tm-font); }
    [hidden] { display: none !important; }

    /* Botão flutuante (só fora da tela logada, onde não há barra do topo). */
    .fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; width: 36px; height: 36px; border-radius: 999px;
      border: 1px solid var(--line-strong, #555); background: var(--surface-raised, #222); color: var(--text-primary, #eee);
      cursor: pointer; opacity: .55; padding: 0; display: grid; place-items: center; box-shadow: 0 4px 14px #0005; }
    .fab:hover, .fab:focus-visible { opacity: 1; }
    .fab svg, .nav svg, .pal-item svg { width: 18px; height: 18px; }

    /* Painel: navegação lateral à esquerda, como os Ajustes do macOS / Windows 11 e do próprio Trivo. */
    .overlay { position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center; padding: 24px;
      background: var(--surface-overlay, #0009); animation: tm-fade .12s ease-out; }
    .panel { width: min(920px, 100%); height: min(640px, 100%); display: grid; grid-template-columns: 210px minmax(0, 1fr);
      overflow: hidden; background: var(--surface-raised, #1b1b1b); color: var(--text-primary, #eee);
      border: 1px solid var(--line-strong, #444); border-radius: var(--tm-radius); font-size: 13px;
      box-shadow: 0 0 0 .5px #0006, 0 24px 64px #0008; animation: tm-pop .14s ease-out; }
    @keyframes tm-fade { from { opacity: 0; } }
    @keyframes tm-pop { from { opacity: 0; transform: scale(.98) translateY(4px); } }
    @media (prefers-reduced-motion: reduce) { .overlay, .panel, .toast, .palette { animation: none !important; } }
    .side { display: flex; flex-direction: column; gap: 2px; padding: 14px 8px; background: var(--surface-sidebar, #161616);
      border-right: 1px solid var(--line, #333); overflow: auto; }
    .brand { display: flex; align-items: center; gap: 8px; padding: 2px 8px 12px; }
    .brand svg { width: 20px; height: 20px; flex: none; color: var(--tm-accent); }
    .brand b { font-size: 14px; font-weight: 650; }
    .brand small { color: var(--text-tertiary, #999); font-size: 11px; margin-left: auto; }
    .nav { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 30px; padding: 0 10px; border: 0;
      border-radius: var(--tm-ctl-radius); background: none; color: var(--text-secondary, #bbb); font-size: 13px; text-align: left; cursor: pointer; }
    :host([data-plat=win]) .nav { min-height: 36px; position: relative; }
    .nav:hover { background: var(--surface-hover, #fff1); color: var(--text-primary, #fff); }
    .nav[aria-selected=true] { background: var(--surface-active, #fff2); color: var(--text-primary, #fff); }
    :host([data-plat=mac]) .nav[aria-selected=true] { background: var(--tm-accent); color: var(--tm-on-accent); }
    :host([data-plat=win]) .nav[aria-selected=true]::before { content: ""; position: absolute; left: 0; top: 10px; bottom: 10px; width: 3px; border-radius: 2px; background: var(--tm-accent); }
    .side .spacer { flex: 1; }
    .content { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .content > header { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 0 16px 0 24px; border-bottom: 1px solid var(--line, #333); }
    .content > header h1 { margin: 0; flex: 1; font-size: 17px; font-weight: 650; }
    :host([data-plat=win]) .content > header h1 { font-size: 20px; font-weight: 600; }
    button.close { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: var(--tm-ctl-radius);
      background: none; color: var(--text-secondary, #bbb); font-size: 18px; cursor: pointer; line-height: 1; }
    button.close:hover { background: var(--surface-hover, #fff1); color: var(--text-primary, #fff); }
    main { flex: 1; overflow: auto; padding: 18px 24px 28px; display: flex; flex-direction: column; gap: 10px; outline: none; }
    main > h2 { margin: 10px 0 0; font-size: 11px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--text-tertiary, #999); }
    main > h2:first-child { margin-top: 0; }

    /* Controles. */
    button.btn { min-height: 28px; padding: 0 12px; border-radius: var(--tm-ctl-radius); border: 1px solid var(--line-strong, #555);
      background: var(--surface-input, #fff1); color: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
    :host([data-plat=win]) button.btn { min-height: 32px; }
    button.btn:hover { background: var(--surface-hover, #fff2); }
    button.btn.primary { background: var(--tm-accent); color: var(--tm-on-accent); border-color: transparent; font-weight: 600; }
    button.btn.primary:hover { filter: brightness(1.08); }
    button.btn.danger { color: var(--text-danger, #f88); }
    button.btn:disabled { opacity: .45; cursor: not-allowed; }
    .card { border: 1px solid var(--line, #333); border-radius: calc(var(--tm-radius) - 4px); padding: 12px 14px; display: flex;
      flex-direction: column; gap: 8px; background: color-mix(in srgb, var(--surface-input, #fff) 35%, transparent); }
    .group { border: 1px solid var(--line, #333); border-radius: calc(var(--tm-radius) - 4px); overflow: hidden;
      background: color-mix(in srgb, var(--surface-input, #fff) 35%, transparent); }
    .group > .item { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 8px 14px; }
    .group > .item + .item { border-top: 1px solid var(--line, #333); }
    .item .grow, .row .grow { flex: 1; min-width: 0; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .name { font-weight: 600; font-size: 13px; }
    .desc { color: var(--text-secondary, #bbb); font-size: 12px; line-height: 1.45; margin-top: 2px; }
    .hint { color: var(--text-tertiary, #999); font-size: 12px; line-height: 1.45; }
    .tag { display: inline-block; margin-left: 6px; font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px;
      border: 1px solid var(--line-strong, #555); color: var(--text-tertiary, #999); vertical-align: 1px; }
    .error { color: var(--text-danger, #f88); font-size: 12px; }
    .opts { display: grid; grid-template-columns: minmax(120px, 200px) 1fr; gap: 8px 12px; align-items: center; padding: 10px 14px 12px;
      border-top: 1px solid var(--line, #333); }
    .opts label { color: var(--text-secondary, #bbb); font-size: 12px; }
    input[type=text], input[type=search], input[type=number], select, textarea { background: var(--surface-input, #fff1); color: inherit;
      border: 1px solid var(--campo-borda, #666); border-radius: var(--tm-ctl-radius); padding: 5px 8px; font-size: 13px; width: 100%; min-height: 28px; }
    :host([data-plat=win]) :is(input[type=text], input[type=search], select) { min-height: 32px; border-bottom-width: 2px; }
    textarea { min-height: 120px; resize: vertical; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; tab-size: 2; }
    textarea.code { flex: 1; min-height: 340px; }
    input[type=range] { width: 100%; accent-color: var(--tm-accent); }
    input[type=color] { width: 44px; height: 28px; padding: 0; border: 0; background: none; }
    .search { position: sticky; top: -18px; z-index: 1; padding: 2px 0 6px; background: var(--surface-raised, #1b1b1b); }

    /* Interruptor: no Mac, o do macOS; no Windows, o do Windows 11. */
    .switch { appearance: none; position: relative; flex: none; margin: 0; cursor: pointer; width: 32px; height: 18px; border-radius: 999px;
      background: var(--interruptor-trilho, #6b6b6b); transition: background .15s; }
    .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
      background: #fff; box-shadow: 0 1px 2px #0006; transition: transform .15s; }
    .switch:checked { background: var(--tm-accent); }
    .switch:checked::after { transform: translateX(14px); }
    :host([data-plat=win]) .switch { width: 40px; height: 20px; background: transparent; border: 1px solid var(--text-secondary, #bbb); }
    :host([data-plat=win]) .switch::after { top: 3px; left: 3px; width: 12px; height: 12px; background: var(--text-secondary, #bbb); box-shadow: none; }
    :host([data-plat=win]) .switch:hover::after { transform: scale(1.15); }
    :host([data-plat=win]) .switch:checked { background: var(--tm-accent); border-color: var(--tm-accent); }
    :host([data-plat=win]) .switch:checked::after { background: var(--tm-on-accent); transform: translateX(20px); }
    :host([data-plat=win]) .switch:checked:hover::after { transform: translateX(20px) scale(1.15); }
    :is(.switch, button, input, select, textarea, .nav):focus-visible { outline: 2px solid var(--focus-ring, var(--tm-accent)); outline-offset: 2px; }

    /* Escolha única (temas, layouts). */
    .list { display: flex; flex-direction: column; gap: 6px; }
    button.pick { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 14px; text-align: left; font: inherit; color: inherit;
      border: 1px solid var(--line, #333); border-radius: calc(var(--tm-radius) - 4px); cursor: pointer;
      background: color-mix(in srgb, var(--surface-input, #fff) 35%, transparent); }
    button.pick:hover { border-color: var(--line-strong, #555); }
    button.pick[aria-checked=true] { border-color: var(--tm-accent); box-shadow: 0 0 0 1px var(--tm-accent) inset; }
    .radio { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--line-strong, #777); flex: none; }
    [aria-checked=true] > .radio { border: 5px solid var(--tm-accent); background: #fff; }
    .swatches { display: flex; flex: none; }
    .swatches i { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--surface-raised, #1b1b1b); margin-left: -6px; }
    .swatches i:first-child { margin-left: 0; }

    .iconRow { align-items: flex-start; gap: 16px; flex-wrap: nowrap; }
    .iconPreview { width: 128px; height: 128px; flex: none; border-radius: 12px;
      background: repeating-conic-gradient(var(--surface-input, #fff1) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
    input[type=file] { font-size: 12px; color: inherit; margin-top: 8px; }
    kbd { display: inline-block; min-width: 20px; text-align: center; border: 1px solid var(--line-strong, #555); border-bottom-width: 2px;
      border-radius: 4px; padding: 0 5px; font-size: 11px; font-family: inherit; }
    code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; word-break: break-all; }

    /* Avisos (toasts). */
    .toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483003; display: flex; flex-direction: column;
      align-items: center; gap: 8px; pointer-events: none; }
    .toast { pointer-events: auto; display: flex; align-items: center; gap: 12px; max-width: min(520px, 90vw); padding: 10px 12px 10px 14px;
      border-radius: var(--tm-radius); background: var(--surface-raised, #222); color: var(--text-primary, #eee); font-size: 13px;
      border: 1px solid var(--line-strong, #444); box-shadow: 0 10px 30px #0007; animation: tm-pop .16s ease-out; }
    .toast[data-tipo=erro] { border-color: var(--red, #f55); }
    .toast[data-tipo=sucesso] { border-color: var(--green, #3a6); }
    .toast .btn { min-height: 24px; }

    /* Paleta de comandos. */
    .pal-overlay { position: fixed; inset: 0; z-index: 2147483002; background: #0006; display: flex; justify-content: center; padding-top: 14vh; }
    .palette { width: min(600px, 92vw); max-height: 60vh; display: flex; flex-direction: column; overflow: hidden; align-self: flex-start;
      background: var(--surface-raised, #1b1b1b); color: var(--text-primary, #eee); border: 1px solid var(--line-strong, #444);
      border-radius: var(--tm-radius); box-shadow: 0 24px 64px #0009; animation: tm-pop .12s ease-out; }
    .palette input { border: 0; border-bottom: 1px solid var(--line, #333); border-radius: 0; background: transparent; font-size: 15px; padding: 14px 16px; min-height: 0; }
    .palette input:focus-visible { outline: none; }
    .pal-list { overflow: auto; padding: 6px; }
    .pal-item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 34px; padding: 0 10px; border: 0; border-radius: var(--tm-ctl-radius);
      background: none; color: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    .pal-item small { margin-left: auto; color: var(--text-tertiary, #999); }
    .pal-item[aria-selected=true] { background: var(--tm-accent); color: var(--tm-on-accent); }
    .pal-item[aria-selected=true] small { color: inherit; opacity: .8; }
    .pal-empty { padding: 14px; color: var(--text-tertiary, #999); }
  `;

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    const late = []; // `value` só depois de min/max/step, senão o range é limitado a 0..100
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") el.className = v;
      else if (k === "value" || k === "checked" || k === "disabled") late.push([k, v]);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
    for (const [k, v] of late) el[k] = v;
    return el;
  }

  const ui = { host: null, root: null, body: null, open: false, tab: "themes" };

  function ensureHost() {
    if (ui.host && ui.host.isConnected) return;
    if (!ui.host) {
      ui.host = h("div", { id: "trivomod-root" });
      ui.root = ui.host.attachShadow({ mode: "open" });
      const style = new CSSStyleSheet();
      style.replaceSync(UI_CSS);
      ui.root.adoptedStyleSheets = [style];
      ui.body = h("div");
      ui.toasts = h("div", { class: "toasts", "aria-live": "polite" });
      ui.palette = h("div");
      ui.root.append(ui.body, ui.palette, ui.toasts);
      new MutationObserver(() => {
        if (!ui.host.isConnected && document.documentElement) document.documentElement.append(ui.host);
      }).observe(document.documentElement, { childList: true });
    }
    document.documentElement.append(ui.host);
  }

  const toggle = (checked, onChange, label) =>
    h("input", { type: "checkbox", class: "switch", checked, "aria-label": label, onChange: (e) => onChange(e.target.checked) });

  function optionControl(p, key, spec) {
    const value = optionGet(p, key);
    const set = (v) => optionSet(p, key, v);
    switch (spec.type) {
      case "boolean":
        return toggle(Boolean(value), set, spec.label || key);
      case "number":
        return h("input", { type: "number", value, min: spec.min, max: spec.max, step: spec.step, onChange: (e) => set(Number(e.target.value)) });
      case "range": {
        const out = h("span", { class: "hint" }, String(value));
        const input = h("input", { type: "range", value, min: spec.min, max: spec.max, step: spec.step, onInput: (e) => { out.textContent = e.target.value; set(Number(e.target.value)); } });
        return h("div", { class: "row" }, h("div", { class: "grow" }, input), out);
      }
      case "color":
        return h("input", { type: "color", value, onInput: (e) => set(e.target.value) });
      case "select":
        return h("select", { onChange: (e) => set(e.target.value) }, (spec.options || []).map((o) => {
          const opt = typeof o === "string" ? { label: o, value: o } : o;
          return h("option", { value: opt.value, selected: opt.value === value }, opt.label);
        }));
      default:
        return h("input", { type: "text", value: value == null ? "" : String(value), onChange: (e) => set(e.target.value) });
    }
  }

  /** Até 4 cores do tema para a prévia (fundo, canais, destaque, texto), resolvendo var() simples. */
  function themeSwatches(css) {
    const vars = {};
    for (const m of String(css).matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) if (!has(vars, m[1])) vars[m[1]] = m[2].replace(/!important/, "").trim();
    const resolve = (v, depth = 0) => {
      if (!v || depth > 4) return null;
      const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(v);
      if (ref) return resolve(vars[ref[1]], depth + 1) || resolve(ref[2], depth + 1);
      return /^(#[0-9a-f]{3,8}|rgb|hsl)/i.test(v) ? v : null;
    };
    return ["--background", "--surface-sidebar", "--accent", "--text-primary"].map((k) => resolve(vars[k])).filter(Boolean);
  }

  const pickCard = ({ checked, onPick, name, description, tag, swatches }) =>
    h("button", { class: "pick", type: "button", role: "radio", "aria-checked": String(checked), onClick: onPick },
      h("span", { class: "radio" }),
      h("div", { class: "grow" },
        h("div", { class: "name" }, name, tag ? h("span", { class: "tag" }, tag) : null),
        description ? h("div", { class: "desc" }, description) : null,
      ),
      swatches && swatches.length ? h("span", { class: "swatches", "aria-hidden": "true" }, swatches.map((c) => h("i", { style: `background:${c}` }))) : null,
    );

  const filters = { themes: "", plugins: "" };
  const matches = (q, ...texts) => !q || texts.join(" ").toLocaleLowerCase("pt-BR").includes(q.toLocaleLowerCase("pt-BR"));
  const searchBox = (key, placeholder, rerender) =>
    h("div", { class: "search" }, h("input", { type: "search", placeholder, value: filters[key], "aria-label": placeholder,
      onInput: (e) => { filters[key] = e.target.value; rerender(); } }));

  function renderThemes() {
    const list = h("div", { class: "list", role: "radiogroup", "aria-label": "Tema" });
    const fill = () => {
      const current = activeTheme(); // lido de novo a cada desenho: a escolha muda sem recriar a aba
      const q = filters.themes;
      const items = themes.filter((t) => matches(q, t.name, t.description, t.author));
      list.replaceChildren(
        ...(matches(q, "Nenhum tema original") ? [pickCard({ checked: !current, onPick: () => { chooseTheme(""); rerender(); }, name: "Nenhum", description: "As cores do Trivo (ou do layout escolhido)." })] : []),
        ...items.map((t) => pickCard({
          checked: current && current.id === t.id,
          onPick: () => { chooseTheme(t.id); rerender(); },
          name: t.name,
          description: [t.description, t.author && `por ${t.author}`].filter(Boolean).join(" · "),
          tag: t.link ? "online" : t.builtin ? "incluído" : "seu",
          swatches: themeSwatches(t.css),
        })),
      );
      if (!list.children.length) list.append(h("div", { class: "hint" }, "Nenhum tema com esse nome."));
    };
    const rerender = () => { fill(); };
    fill();

    const links = h("textarea", { spellcheck: "false", placeholder: "https://exemplo.com/meu-tema.css", value: settings.themeLinks.join("\n"), "aria-label": "Links de temas, um por linha" });
    const linkStatus = h("div", { class: "hint", "aria-live": "polite" });
    const refresh = h("button", { class: "btn", onClick: async () => {
      settings.themeLinks = links.value.split(/\s+/).map((x) => x.trim()).filter((x) => /^https:\/\/\S+$/.test(x)).slice(0, 20);
      links.value = settings.themeLinks.join("\n");
      save();
      if (typeof native.refreshThemeLinks !== "function") { linkStatus.textContent = "Atualize o TrivoMod para usar temas online."; return; }
      refresh.disabled = true;
      linkStatus.textContent = "Baixando…";
      await new Promise((r) => setTimeout(r, 300)); // deixa o ajuste chegar ao disco antes
      try {
        const res = (await native.refreshThemeLinks()) || [];
        const bad = res.filter((r) => !r.ok);
        linkStatus.textContent = bad.length
          ? `${res.length - bad.length} de ${res.length} baixados. Falhou: ${bad.map((b) => `${b.url} (${b.error})`).join("; ")}`
          : res.length ? `${res.length} tema(s) online atualizados; eles aparecem na lista acima.` : "Nenhum link.";
        toast(bad.length ? "Alguns temas online falharam." : "Temas online atualizados.", { tipo: bad.length ? "erro" : "sucesso" });
      } catch (e) {
        linkStatus.textContent = `Falhou: ${e && e.message ? e.message : e}`;
      } finally {
        refresh.disabled = false;
      }
    } }, "Salvar e baixar");

    return [
      searchBox("themes", "Buscar temas", fill),
      list,
      h("h2", {}, "Temas online"),
      h("div", { class: "card" },
        h("div", { class: "desc" }, "Cole links de arquivos .css (um por linha). O TrivoMod baixa e guarda uma cópia; imagens e fontes externas dentro do tema não carregam (proteção do Trivo)."),
        links,
        h("div", { class: "row" }, refresh, linkStatus),
      ),
      h("div", { class: "row" },
        h("button", { class: "btn", onClick: () => native.openFolder("themes") }, "Pasta de temas"),
        h("span", { class: "hint" }, "Arquivos .css nessa pasta aparecem aqui na hora."),
      ),
    ];
  }

  function renderPlugins() {
    if (!plugins.size) return [h("div", { class: "hint" }, "Nenhum plugin carregado.")];
    const box = h("div", { class: "list" });
    const fill = () => {
      const items = [...plugins.values()].filter((p) => matches(filters.plugins, p.def.name, p.def.description));
      box.replaceChildren(...items.map((p) => {
        const d = p.def;
        const enabled = isEnabled(p);
        const specs = d.settings ? Object.entries(d.settings) : [];
        return h("div", { class: "group" },
          h("div", { class: "item" },
            h("div", { class: "grow" },
              h("div", { class: "name" }, d.name, h("span", { class: "tag" }, p.builtin ? "incluído" : "seu")),
              h("div", { class: "desc" }, [d.description, d.authors && d.authors.length && `por ${[].concat(d.authors).join(", ")}`].filter(Boolean).join(" · ")),
              p.error && h("div", { class: "error" }, `Erro: ${p.error}`),
            ),
            toggle(enabled, (v) => { setPluginEnabled(p, v); fill(); }, d.name),
          ),
          enabled && specs.length
            ? h("div", { class: "opts" }, specs.map(([key, spec]) => [h("label", {}, spec.label || key), optionControl(p, key, spec)]))
            : null,
        );
      }));
      if (!items.length) box.append(h("div", { class: "hint" }, "Nenhum plugin com esse nome."));
    };
    fill();
    return [
      searchBox("plugins", "Buscar plugins", fill),
      box,
      h("div", { class: "row" },
        h("button", { class: "btn", onClick: () => native.openFolder("plugins") }, "Pasta de plugins"),
        h("span", { class: "hint" }, "Plugins de arquivo são lidos ao abrir o Trivo; depois de editar um, recarregue (Cmd/Ctrl+R)."),
      ),
    ];
  }

  function renderLayouts() {
    const choose = (id) => { settings.layout = id; save(); applyStyles(); emit("layout", id); render(); };
    return [
      h("div", { class: "list", role: "radiogroup", "aria-label": "Layout" },
        pickCard({ checked: !settings.layout, onPick: () => choose(""), name: "Trivo (padrão)", description: "A organização original do Trivo." }),
        layouts.map((l) => pickCard({
          checked: settings.layout === l.id,
          onPick: () => choose(l.id),
          name: l.name,
          description: [l.description, l.author && `por ${l.author}`].filter(Boolean).join(" · "),
          tag: l.builtin ? "incluído" : "seu",
        })),
      ),
      h("div", { class: "hint" }, "Só um layout fica ativo. O tema escolhido vale por cima dele (as cores do tema vencem)."),
      h("div", { class: "row" }, h("button", { class: "btn", onClick: () => native.openFolder("layouts") }, "Pasta de layouts")),
    ];
  }

  // ------------------------------------------------------------ ícone do aplicativo
  const isMac = boot.info.platform === "darwin";
  const defaultIconStatus = "Ícone padrão do TrivoMod (Arara Pirata) ativo — as cores mudam automaticamente com o tema.";
  const customIconStatus = "Ícone personalizado em uso (tem prioridade sobre as cores dos temas).";
  const iconUi = {
    bitmap: null,
    defaultImg: null,
    redrawPreview: null,
    custom: Boolean(boot.info.customIcon),
    radius: 22.5,
    zoom: 100,
    busy: false,
    status: boot.info.customIcon ? customIconStatus : defaultIconStatus,
    state: boot.info.iconState || "",
  };
  const iconMessage = (r, applied) => {
    if (!r || !r.ok) return `Falhou: ${(r && r.error) || "erro"}`;
    if (r.state === "aplicar") return applied
      ? "Aplicado no Dock (ícone personalizado com prioridade). O ícone do app (Dock e Finder com o Trivo fechado) é trocado quando o Trivo fechar; use \"Reiniciar e aplicar\" para fazer agora."
      : "Ícone padrão do TrivoMod de volta no Dock (acompanha o tema). O arquivo do app atualiza quando o Trivo fechar.";
    if (r.state === "restaurar") return "Ícone padrão de volta no Dock. O arquivo do app atualiza quando o Trivo fechar.";
    if (r.state === "atalhos") return applied
      ? `Aplicado (ícone personalizado com prioridade). ${r.shortcuts || 0} atalho(s) do Trivo agora usam o ícone novo.`
      : `Ícone padrão do TrivoMod restaurado em ${r.shortcuts || 0} atalho(s) — acompanha o tema automaticamente.`;
    if (r.state === "original") return applied ? "Aplicado." : `Ícone padrão restaurado${r.shortcuts != null ? ` em ${r.shortcuts} atalho(s)` : ""}.`;
    if (r.state === "aplicado") return applied ? "O app já está com esse ícone." : defaultIconStatus;
    return applied ? "Aplicado nas janelas do Trivo. Neste sistema o ícone do arquivo do app não muda." : defaultIconStatus;
  };

  /** Lê as cores resolvidas do tema atual na página para colorir a Arara Pirata padrão. */
  function readThemeIconInput() {
    if (!document.body) return null;
    const probe = document.createElement("i");
    probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
    document.body.append(probe);
    const pick = (...vars) => {
      for (const expr of vars) {
        probe.style.color = "";
        probe.style.color = expr;
        const val = getComputedStyle(probe).color;
        if (val && opaque(val)) return val;
      }
      return null;
    };
    const out = {
      bg: pick("var(--background)"),
      sidebar: pick("var(--surface-sidebar)", "var(--surface-base)", "var(--background)"),
      accent: pick("var(--accent)"),
      green: pick("var(--green)", "var(--ctp-green)", "var(--color-green)", "var(--status-online)"),
      yellow: pick("var(--yellow)", "var(--ctp-yellow)", "var(--color-yellow)", "var(--status-idle)"),
      red: pick("var(--red)", "var(--ctp-red)", "var(--color-red)", "var(--status-dnd)"),
    };
    probe.remove();
    // Se nenhum tema customizado/acento estiver definido e ainda não houver cores carregadas, usa a paleta padrão Brasil.
    if (!out.accent && !out.bg) return null;
    return out;
  }

  /** Converte o SVG da Arara Pirata em Image + PNG data URL (1024 px) compatível com a CSP (data: URI). */
  function renderDefaultIconSvg(palette, size = 1024) {
    return new Promise((resolve, reject) => {
      const api = window.__trivomodDefaultIcon;
      if (!api || typeof api.buildIconSvg !== "function") return reject(new Error("gerador de ícone indisponível"));
      const svg = api.buildIconSvg(palette);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          drawIcon(canvas, img, { radius: 22.5, zoom: 100 });
          resolve({ img, dataUrl: canvas.toDataURL("image/png") });
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error("falha ao rasterizar SVG do ícone padrão"));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
  }

  let themeIconTimer = 0;
  let lastThemeIconKey = "";
  let themeIconSeq = 0;
  function queueThemeIcon(force = false) {
    if (boot.info.safeMode || !window.__trivomodDefaultIcon) return;
    clearTimeout(themeIconTimer);
    themeIconTimer = setTimeout(() => syncThemeIcon(force), force ? 30 : 260);
  }

  async function syncThemeIcon(force = false) {
    const api = window.__trivomodDefaultIcon;
    if (boot.info.safeMode || !api || !document.body) return;
    const raw = readThemeIconInput();
    // Quando nenhum tema do TrivoMod/layout/acento do sistema está ativo e o tema do Trivo é o padrão,
    // se --accent estiver presente usa paletteFromTheme; se ainda não existir, usa DEFAULT_PALETTE (Brasil).
    const hasCustomTheme = Boolean(activeTheme() || settings.layout || (settings.native.enabled && settings.native.systemAccent && systemAccent) || (document.documentElement && document.documentElement.dataset.tema));
    const palette = raw && (hasCustomTheme || raw.accent) ? api.paletteFromTheme(raw) : { ...api.DEFAULT_PALETTE };
    const key = JSON.stringify(palette);
    if (!force && key === lastThemeIconKey && iconUi.defaultImg) return;
    const seq = ++themeIconSeq;
    try {
      const { img, dataUrl } = await renderDefaultIconSvg(palette, 1024);
      if (seq !== themeIconSeq) return;
      lastThemeIconKey = key;
      iconUi.defaultImg = img;
      if (iconUi.redrawPreview && !iconUi.bitmap) iconUi.redrawPreview();
      // Precedência absoluta: se o usuário definiu um ícone personalizado, NUNCA sobrescreve.
      if (iconUi.custom || typeof native.setThemeIcon !== "function") return;
      const r = await native.setThemeIcon(dataUrl);
      if (r && r.ok && !r.skipped && r.state) iconUi.state = r.state;
    } catch (e) {
      err("ícone padrão do tema falhou:", e);
    }
  }

  /** Desenha a imagem num quadrado de cantos arredondados. No macOS segue a grade de ícones da Apple
   *  (824 px de 1024, com margem e sombra), para o ícone não ficar maior que os outros no Dock. */
  function drawIcon(canvas, bitmap, { radius, zoom }) {
    const size = canvas.width;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    const box = isMac ? size * (824 / 1024) : size;
    const off = (size - box) / 2;
    const r = (box * radius) / 100;
    ctx.save();
    if (isMac) {
      ctx.shadowColor = "rgba(0,0,0,0.30)";
      ctx.shadowBlur = size * 0.027;
      ctx.shadowOffsetY = size * 0.01;
      ctx.beginPath();
      ctx.roundRect(off, off, box, box, r);
      ctx.fillStyle = "#000";
      ctx.fill();
      ctx.shadowColor = "transparent";
    }
    ctx.beginPath();
    ctx.roundRect(off, off, box, box, r);
    ctx.clip();
    if (bitmap) {
      // "cobrir": corta o excesso no meio, como object-fit: cover; o zoom aproxima.
      const scale = Math.max(box / bitmap.width, box / bitmap.height) * (zoom / 100);
      const w = bitmap.width * scale;
      const hgt = bitmap.height * scale;
      ctx.clearRect(off, off, box, box);
      ctx.drawImage(bitmap, off + (box - w) / 2, off + (box - hgt) / 2, w, hgt);
    }
    ctx.restore();
  }

  function renderIcon() {
    const preview = h("canvas", { class: "iconPreview", width: 256, height: 256, "aria-label": "Prévia do ícone" });
    const redraw = () => {
      if (iconUi.bitmap) drawIcon(preview, iconUi.bitmap, iconUi);
      else if (iconUi.defaultImg) drawIcon(preview, iconUi.defaultImg, { radius: 22.5, zoom: 100 });
      else drawIcon(preview, null, iconUi);
    };
    iconUi.redrawPreview = redraw;
    const status = h("div", { class: "hint", "aria-live": "polite" }, iconUi.status);
    const setStatus = (text) => { iconUi.status = text; status.textContent = text; };

    const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", onChange: async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        iconUi.bitmap = await createImageBitmap(f);
        setStatus(`${f.name}: ${iconUi.bitmap.width}×${iconUi.bitmap.height}. Ajuste e clique em Aplicar.`);
        redraw();
        applyBtn.disabled = false;
      } catch {
        setStatus("Não consegui ler essa imagem. Use PNG, JPEG, WebP ou GIF.");
      }
    } });
    const slider = (label, key, min, max) => {
      const out = h("span", { class: "hint" }, `${iconUi[key]}%`);
      return [h("label", {}, label), h("div", { class: "row" },
        h("div", { class: "grow" }, h("input", { type: "range", min, max, step: 0.5, value: iconUi[key], onInput: (e) => { iconUi[key] = Number(e.target.value); out.textContent = `${iconUi[key]}%`; redraw(); } })),
        out)];
    };
    const applyBtn = h("button", { class: "btn primary", disabled: !iconUi.bitmap, onClick: async () => {
      const big = document.createElement("canvas");
      big.width = big.height = 1024;
      drawIcon(big, iconUi.bitmap, iconUi);
      const r = await native.setIcon(big.toDataURL("image/png"));
      if (r && r.ok) iconUi.custom = true;
      iconUi.state = (r && r.state) || iconUi.state;
      setStatus(iconMessage(r, true));
      restartBtn.hidden = !(iconUi.state === "aplicar" || iconUi.state === "restaurar");
    } }, "Aplicar");
    const resetBtn = h("button", { class: "btn", onClick: async () => {
      const r = await native.resetIcon();
      if (r && r.ok) {
        iconUi.custom = false;
        iconUi.bitmap = null;
        applyBtn.disabled = true;
        file.value = "";
      }
      iconUi.state = (r && r.state) || iconUi.state;
      setStatus(iconMessage(r, false));
      restartBtn.hidden = !(iconUi.state === "aplicar" || iconUi.state === "restaurar");
      redraw();
      syncThemeIcon(true);
    } }, "Usar padrão do TrivoMod");
    // macOS: o arquivo do app só pode mudar com o Trivo fechado (reassinar reescreve o executável).
    const restartBtn = h("button", { class: "btn", hidden: !(iconUi.state === "aplicar" || iconUi.state === "restaurar"), onClick: async () => {
      setStatus("Fechando o Trivo para trocar o ícone do app; ele abre de novo sozinho…");
      await native.restartToApplyIcon();
    } }, "Reiniciar e aplicar");
    queueMicrotask(() => {
      redraw();
      if (!iconUi.defaultImg) syncThemeIcon(true);
    });
    return [
      h("div", { class: "card" },
        h("div", { class: "row iconRow" },
          preview,
          h("div", { class: "grow" },
            h("div", { class: "name" }, "Ícone do aplicativo"),
            h("div", { class: "desc" }, "Por padrão, o TrivoMod usa a Arara Pirata com cores que acompanham o tema ativo. Se você aplicar uma imagem própria, ela sempre terá prioridade" + (isMac ? " (recortada na grade do macOS)." : ".")),
            file,
          ),
        ),
        h("div", { class: "opts" }, slider("Arredondamento", "radius", 0, 50), slider("Zoom", "zoom", 100, 200)),
        h("div", { class: "row" }, applyBtn, resetBtn, restartBtn),
        status,
      ),
    ];
  }

  function renderQuickCss() {
    const area = h("textarea", { class: "code", value: settings.quickCss, spellcheck: "false", "aria-label": "CSS rápido",
      placeholder: "/* Ex.: deixar o fundo da conversa preto */\n.$chat { background: #000 !important; }",
      onInput: (e) => { settings.quickCss = e.target.value; save(); applyStyles(); },
      onKeydown: (e) => {
        if (e.key !== "Tab" || e.shiftKey) return;
        e.preventDefault();
        const t = e.target;
        t.setRangeText("  ", t.selectionStart, t.selectionEnd, "end");
        t.dispatchEvent(new Event("input"));
      } });
    return [
      h("div", { class: "hint" }, "Aplicado por último e ao vivo. Use ", h("code", {}, ".$nome"), " para as classes do Trivo (ex.: ", h("code", {}, ".$chatHeader"), "): o código no começo da classe muda a cada versão."),
      area,
    ];
  }

  const restartNote = () => h("div", { class: "hint" }, "A translucidez vale a partir da próxima vez que a página carregar.",
    h("button", { class: "btn", style: "margin-left:8px", onClick: () => location.reload() }, "Recarregar agora"));

  function renderSystem() {
    const n = settings.native;
    const set = (key, value) => { n[key] = value; save(); applyStyles(); render(); };
    const material = nativeInfo ? nativeInfo.material : "none";
    const sys = plat === "mac" ? "macOS" : plat === "win" ? "Windows" : "Linux";
    const translucentDesc = material === "vibrancy" ? "Translucidez do macOS atrás da barra do topo, dos servidores e dos canais."
      : material === "mica" ? "Material Mica do Windows 11 atrás da barra do topo, dos servidores e dos canais."
      : plat === "win" ? "Precisa do Windows 11 (versão 22H2 ou mais nova)." : "Não disponível neste sistema.";
    const item = (name, desc, control) => h("div", { class: "item" }, h("div", { class: "grow" }, h("div", { class: "name" }, name), h("div", { class: "desc" }, desc)), control);
    return [
      h("h2", {}, `Aparência nativa (${sys})`),
      h("div", { class: "group" },
        item("Aparência nativa", "Barra do título do Trivo na mesma cor da barra de abas, botões da janela do sistema e o resto abaixo.",
          toggle(n.enabled, (v) => set("enabled", v), "Aparência nativa")),
        item("Translucidez", translucentDesc, toggle(n.translucent && material !== "none", (v) => set("translucent", v), "Translucidez")),
        item("Fonte do sistema", plat === "mac" ? "SF Pro, a fonte do macOS, em todo o Trivo." : plat === "win" ? "Segoe UI Variable, a fonte do Windows 11, em todo o Trivo." : "A fonte do sistema em todo o Trivo.",
          toggle(n.systemFont, (v) => set("systemFont", v), "Fonte do sistema")),
        item("Cor de destaque do sistema", systemAccent ? `Usa a cor escolhida em ${plat === "mac" ? "Ajustes do Sistema › Aparência" : "Configurações › Personalização › Cores"} (agora: ${systemAccent}).` : "O sistema não informou uma cor de destaque.",
          toggle(n.systemAccent, (v) => set("systemAccent", v), "Cor de destaque do sistema")),
      ),
      n.enabled && n.translucent && material !== "none" && !(nativeInfo && nativeInfo.translucent && nativeInfo.enabled) ? restartNote() : null,
      !nativeInfo ? h("div", { class: "hint" }, "Reinicie o Trivo para o processo principal do mod ligar o material da janela.") : null,
    ];
  }

  async function backup(kind) {
    const fn = kind === "export" ? native.exportBackup : native.importBackup;
    if (typeof fn !== "function") return toast("Atualize o TrivoMod para usar o backup.", { tipo: "erro" });
    const r = await fn().catch((e) => ({ ok: false, error: e && e.message }));
    if (!r || r.canceled) return;
    if (!r.ok) return toast(`Não deu: ${r.error || "erro"}`, { tipo: "erro" });
    if (kind === "export") toast("Backup salvo.", { tipo: "sucesso" });
    else {
      const c = r.counts || {};
      toast(`Backup restaurado (${c.themes || 0} temas, ${c.layouts || 0} layouts, ${c.plugins || 0} plugins).`, {
        tipo: "sucesso", acao: { rotulo: "Recarregar", run: () => location.reload() }, duracao: 0 });
    }
  }

  function renderAudioSection() {
    const audio = plugins.get("builtin:audio-aprimorado");
    if (!audio) return [];
    const enabled = isEnabled(audio);
    const specs = audio.def.settings ? Object.entries(audio.def.settings) : [];
    const onSwitch = (v) => {
      setPluginEnabled(audio, v);
      toast(v ? "Áudio aprimorado ativado. Vale na próxima chamada (ou reconecte para aplicar agora)." : "Modo padrão de áudio do Trivo restaurado.");
      render();
    };
    return [
      h("h2", {}, "Áudio"),
      h("div", { class: "group" },
        h("div", { class: "item" },
          h("div", { class: "grow" },
            h("div", { class: "name" }, "Áudio aprimorado", h("span", { class: "tag" }, enabled ? "Aprimorado" : "Padrão")),
            h("div", { class: "desc" }, enabled
              ? "Modo aprimorado ativo: saída limpa (sem +9 dB / compressão 12:1), 48 kHz nativo, portão com menos cortes, AGC opcional, DTX desligado e sem throttling em segundo plano."
              : "Usando o modo padrão do Trivo. Ligue para ativar o áudio aprimorado nas chamadas de voz."),
            audio.error && h("div", { class: "error" }, `Erro: ${audio.error}`),
          ),
          toggle(enabled, onSwitch, "Áudio aprimorado"),
        ),
        enabled && specs.length
          ? h("div", { class: "opts" }, specs.map(([key, spec]) => [h("label", {}, spec.label || key), optionControl(audio, key, spec)]))
          : null,
      ),
    ];
  }

  function renderAbout() {
    const mac = plat === "mac";
    const k = (...keys) => keys.map((x, i) => [i ? " + " : null, h("kbd", {}, x)]);
    return [
      h("div", { class: "card" },
        h("div", { class: "name" }, `TrivoMod ${boot.info.version}`),
        h("div", { class: "desc" }, "Mod do cliente para o Trivo: temas, layouts, CSS próprio e plugins. Não é afiliado ao Trivo."),
      ),
      boot.info.safeMode ? h("div", { class: "card" },
        h("div", { class: "name" }, "Modo seguro"),
        h("div", { class: "desc" }, boot.info.safeReason === "auto"
          ? "O Trivo falhou ao abrir algumas vezes seguidas com o mod, então temas, layouts e plugins foram desligados nesta sessão."
          : "Ligado por TRIVOMOD_SAFE=1: nada é carregado e nada é salvo."),
        boot.info.safeReason === "auto" && typeof native.leaveSafeMode === "function"
          ? h("div", { class: "row" }, h("button", { class: "btn primary", onClick: () => native.leaveSafeMode() }, "Sair do modo seguro e reiniciar")) : null,
      ) : null,
      ...renderAudioSection(),
      h("h2", {}, "Atalhos"),
      h("div", { class: "group" },
        h("div", { class: "item" }, h("div", { class: "grow" }, "Abrir/fechar este painel"), h("span", {}, k(mac ? "⌘" : "Ctrl", mac ? "⌥" : "Alt", "T"))),
        h("div", { class: "item" }, h("div", { class: "grow" }, "Paleta de comandos"), h("span", {}, k(mac ? "⌘" : "Ctrl", mac ? "⇧" : "Shift", "P"))),
      ),
      h("h2", {}, "Botão"),
      h("div", { class: "group" },
        h("div", { class: "item" },
          h("div", { class: "grow" }, h("div", { class: "name" }, "Botão do TrivoMod"), h("div", { class: "desc" }, "Na barra do topo, ao lado de Avisos (fora da tela logada, no canto da tela). Também fica nos Ajustes do Trivo, no grupo TrivoMod.")),
          toggle(settings.showButton !== false, (v) => { settings.showButton = v; save(); syncToolbarButton(); render(); }, "Mostrar botão"),
        ),
      ),
      h("h2", {}, "Backup"),
      h("div", { class: "card" },
        h("div", { class: "desc" }, "Um arquivo com seus ajustes, temas, layouts e plugins, para guardar ou levar a outro computador."),
        h("div", { class: "row" },
          h("button", { class: "btn", onClick: () => backup("export") }, "Exportar…"),
          h("button", { class: "btn", onClick: () => backup("import") }, "Importar…"),
        ),
      ),
      h("h2", {}, "Dados"),
      h("div", { class: "card" },
        h("code", {}, boot.info.dataDir),
        h("div", { class: "row" },
          h("button", { class: "btn", onClick: () => native.openFolder("data") }, "Abrir pasta"),
          h("button", { class: "btn", onClick: () => native.openFolder("themes") }, "Temas"),
          h("button", { class: "btn", onClick: () => native.openFolder("layouts") }, "Layouts"),
          h("button", { class: "btn", onClick: () => native.openFolder("plugins") }, "Plugins"),
        ),
      ),
    ];
  }

  const TABS = [
    ["themes", "Temas", renderThemes],
    ["layout", "Layout", renderLayouts],
    ["plugins", "Plugins", renderPlugins],
    ["css", "CSS rápido", renderQuickCss],
    ["icon", "Ícone do app", renderIcon],
    ["system", "Janela e sistema", renderSystem],
    ["about", "Sobre", renderAbout],
  ];
  const ICONS = {
    themes: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1.2-1-1.4-1-2.4 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5zM7.5 11.5h0M10 7.5h0M14.5 7.5h0",
    layout: "M4 4h16v16H4zM9 4v16M9 10h11",
    plugins: "M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5",
    css: "M8 6l-5 6 5 6M16 6l5 6-5 6",
    icon: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21",
    system: "M3 5h18v11H3zM8 20h8M12 16v4",
    about: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
    star: "M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z",
  };

  function render() {
    renderFloating();
    renderEmbedded();
  }

  let returnFocus = null;
  function renderFloating() {
    if (!ui.body) return;
    ui.host.dataset.plat = plat;
    ui.host.dataset.font = settings.native.enabled && settings.native.systemFont ? "system" : "app";
    const kids = [];
    if (settings.showButton !== false && !toolbarButton()) {
      kids.push(h("button", { class: "fab", title: "TrivoMod", "aria-label": "Abrir o TrivoMod", onClick: () => (ui.open ? closeSettings() : openSettings()) }, svgIcon(ICONS.star)));
    }
    if (ui.open) {
      const current = TABS.find((t) => t[0] === ui.tab) || TABS[0];
      const main = h("main", { tabIndex: -1 }, current[2]());
      kids.push(
        h("div", { class: "overlay", onMousedown: (e) => { if (e.target === e.currentTarget) closeSettings(); } },
          h("div", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": "TrivoMod", onKeydown: trapFocus },
            h("nav", { class: "side", role: "tablist", "aria-orientation": "vertical", "aria-label": "Seções do TrivoMod" },
              h("div", { class: "brand" }, svgIcon(ICONS.star), h("b", {}, "TrivoMod"), h("small", {}, boot.info.version)),
              TABS.map(([id, label]) => h("button", {
                class: "nav", role: "tab", "aria-selected": String(id === ui.tab), "data-tab": id, tabIndex: id === ui.tab ? 0 : -1,
                onClick: () => { ui.tab = id; render(); focusTab(); },
                onKeydown: (e) => {
                  const i = TABS.findIndex((t) => t[0] === ui.tab);
                  const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : null;
                  if (next == null) return;
                  e.preventDefault();
                  ui.tab = TABS[(next + TABS.length) % TABS.length][0];
                  render(); focusTab();
                },
              }, svgIcon(ICONS[id]), label)),
              h("div", { class: "spacer" }),
              h("div", { class: "hint", style: "padding: 0 10px" }, "Mudanças são salvas sozinhas."),
            ),
            h("section", { class: "content" },
              h("header", {}, h("h1", {}, current[1]), h("button", { class: "close", "aria-label": "Fechar", title: "Fechar (Esc)", onClick: closeSettings }, "×")),
              main,
            ),
          ),
        ),
      );
    }
    ui.body.replaceChildren(...kids);
  }

  function focusTab() {
    const b = ui.root && ui.root.querySelector(`.nav[data-tab="${ui.tab}"]`);
    if (b) b.focus();
  }
  function trapFocus(e) {
    if (e.key !== "Tab") return;
    const items = [...ui.root.querySelectorAll(".panel button, .panel input, .panel select, .panel textarea, .panel [tabindex='0']")]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const active = ui.root.activeElement;
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  function openSettings(tab) {
    if (typeof tab === "string" && TABS.some((t) => t[0] === tab)) ui.tab = tab;
    if (!ui.open) returnFocus = document.activeElement;
    ensureHost(); ui.open = true; render(); focusTab();
  }
  function closeSettings() {
    ui.open = false; render();
    if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === "function") returnFocus.focus();
    returnFocus = null;
  }

  // ------------------------------------------------------------ avisos (toasts)
  function toast(text, { tipo = "info", duracao = 4000, acao = null } = {}) {
    ensureHost();
    const el = h("div", { class: "toast", role: tipo === "erro" ? "alert" : "status", "data-tipo": tipo },
      h("span", {}, String(text)),
      acao ? h("button", { class: "btn primary", onClick: () => { close(); acao.run(); } }, acao.rotulo) : null,
      h("button", { class: "close", "aria-label": "Fechar aviso", onClick: () => close() }, "×"),
    );
    const close = () => el.remove();
    ui.toasts.append(el);
    while (ui.toasts.children.length > 4) ui.toasts.firstChild.remove();
    if (duracao > 0) setTimeout(close, duracao);
    return close;
  }

  // ------------------------------------------------------------ paleta de comandos
  // Cmd/Ctrl + Shift + P. Os comandos vêm do mod (abas, temas, layouts, plugins) e dos plugins
  // (`commands: [{ name, run }]` na definição, ou TrivoMod.registerCommand).
  const extraCommands = new Map();
  function registerCommand(cmd) {
    if (!cmd || typeof cmd.name !== "string" || typeof cmd.run !== "function") throw new Error("comando precisa de name e run");
    const id = cmd.id || cmd.name;
    extraCommands.set(id, cmd);
    return () => extraCommands.delete(id);
  }
  function allCommands() {
    const out = [];
    for (const [id, label] of TABS) out.push({ name: `Abrir: ${label}`, hint: "TrivoMod", icon: ICONS[id], run: () => openSettings(id) });
    out.push({ name: "Tema: nenhum", hint: "tema", icon: ICONS.themes, run: () => chooseTheme("") });
    for (const t of themes) out.push({ name: `Tema: ${t.name}`, hint: activeTheme() && activeTheme().id === t.id ? "ativo" : "tema", icon: ICONS.themes, run: () => chooseTheme(t.id) });
    out.push({ name: "Layout: Trivo (padrão)", hint: "layout", icon: ICONS.layout, run: () => { settings.layout = ""; save(); applyStyles(); } });
    for (const l of layouts) out.push({ name: `Layout: ${l.name}`, hint: settings.layout === l.id ? "ativo" : "layout", icon: ICONS.layout, run: () => { settings.layout = l.id; save(); applyStyles(); } });
    for (const pl of plugins.values()) {
      const enabled = isEnabled(pl);
      out.push({ name: `${enabled ? "Desligar" : "Ligar"} plugin: ${pl.def.name}`, hint: "plugin", icon: ICONS.plugins, run: () => { setPluginEnabled(pl, !enabled); toast(`${pl.def.name} ${enabled ? "desligado" : "ligado"}.`); } });
      if (pl.started) for (const c of [].concat(pl.def.commands || [])) if (c && typeof c.run === "function") out.push({ name: c.name, hint: pl.def.name, icon: ICONS.plugins, run: () => c.run.call(pl.def) });
    }
    for (const c of extraCommands.values()) out.push({ name: c.name, hint: c.hint || "comando", icon: ICONS.star, run: c.run });
    out.push({ name: "Recarregar o Trivo", hint: "página", icon: ICONS.about, run: () => location.reload() });
    if (typeof native.refreshThemeLinks === "function") out.push({ name: "Atualizar temas online", hint: "temas", icon: ICONS.themes, run: async () => { await native.refreshThemeLinks(); toast("Temas online atualizados."); } });
    if (typeof native.exportBackup === "function") out.push({ name: "Exportar backup do TrivoMod", hint: "backup", icon: ICONS.about, run: () => backup("export") });
    return out;
  }
  function score(q, text) {
    if (!q) return 1;
    const t = text.toLocaleLowerCase("pt-BR"), w = q.toLocaleLowerCase("pt-BR");
    const at = t.indexOf(w);
    if (at >= 0) return 100 - at;
    let i = 0;
    for (const ch of t) if (ch === w[i]) i += 1;
    return i === w.length ? 10 : 0;
  }
  const pal = { open: false, sel: 0, list: [] };
  function openPalette() {
    ensureHost();
    if (pal.open) return closePalette();
    pal.open = true;
    pal.prevFocus = document.activeElement;
    const input = h("input", { type: "text", placeholder: "Digite um comando…", "aria-label": "Comando", role: "combobox", "aria-expanded": "true", "aria-controls": "tm-pal-list" });
    const list = h("div", { class: "pal-list", id: "tm-pal-list", role: "listbox" });
    const draw = () => {
      const q = input.value.trim();
      pal.list = allCommands().map((c) => [score(q, c.name), c]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]).map(([, c]) => c).slice(0, 60);
      pal.sel = Math.min(pal.sel, Math.max(0, pal.list.length - 1));
      list.replaceChildren(...(pal.list.length ? pal.list.map((c, i) => h("button", {
        class: "pal-item", role: "option", "aria-selected": String(i === pal.sel), tabIndex: -1,
        onMousemove: () => { if (pal.sel !== i) { pal.sel = i; draw(); } }, onClick: () => runAt(i),
      }, svgIcon(c.icon), h("span", {}, c.name), h("small", {}, c.hint || ""))) : [h("div", { class: "pal-empty" }, "Nenhum comando.")]));
      const cur = list.children[pal.sel];
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
    };
    const runAt = (i) => {
      const c = pal.list[i];
      closePalette();
      if (c) Promise.resolve().then(() => c.run()).catch((e) => toast(`Comando falhou: ${e && e.message ? e.message : e}`, { tipo: "erro" }));
    };
    input.addEventListener("input", () => { pal.sel = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); pal.sel = (pal.sel + (e.key === "ArrowDown" ? 1 : -1) + pal.list.length) % Math.max(1, pal.list.length); draw(); }
      else if (e.key === "Enter") { e.preventDefault(); runAt(pal.sel); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePalette(); }
    });
    ui.palette.replaceChildren(h("div", { class: "pal-overlay", onMousedown: (e) => { if (e.target === e.currentTarget) closePalette(); } },
      h("div", { class: "palette", role: "dialog", "aria-label": "Paleta de comandos" }, input, list)));
    draw();
    input.focus();
  }
  function closePalette() {
    pal.open = false;
    ui.palette.replaceChildren();
    if (pal.prevFocus && pal.prevFocus.isConnected && typeof pal.prevFocus.focus === "function") pal.prevFocus.focus();
  }

  // ------------------------------------------------------------ seção nos Ajustes do Trivo
  // Como o Vencord faz no Discord: um grupo "TrivoMod" entra na lista lateral dos Ajustes do Trivo
  // (diálogo `…_ajustesDialog`), e a página do mod abre na área da direita, por cima da do Trivo.
  // Os botões copiam as classes reais (hash do CSS Module) do próprio diálogo, então herdam o visual.
  const SECTIONS = [
    ["about", "TrivoMod", "M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"],
    ["plugins", "Plugins", "M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"],
    ["themes", "Temas", "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1.2-1-1.4-1-2.4 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5zM7.5 11.5h0M10 7.5h0M14.5 7.5h0"],
    ["layout", "Layout", "M4 4h16v16H4zM9 4v16M9 10h11"],
    ["css", "CSS rápido", "M8 6l-5 6 5 6M16 6l5 6-5 6"],
    ["icon", "Ícone do aplicativo", "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21"],
    ["system", "Janela e sistema", "M3 5h18v11H3zM8 20h8M12 16v4"],
  ];
  const embed = { aside: null, group: null, view: null, root: null, body: null, tab: null };
  const listened = new WeakSet();

  const svgIcon = (d, className) => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
    return svg;
  };

  function injectSettingsGroup(aside) {
    const groups = [...aside.querySelectorAll(`:scope > ${byModule("grupoDeAjustes")}`)];
    if (!groups.length) return;
    const model = groups.find((g) => g.querySelector("button")) || groups[0];
    const iconClass = (model.querySelector("svg") && model.querySelector("svg").getAttribute("class")) || "";
    const group = document.createElement("div");
    group.className = model.className.split(/\s+/).filter((c) => /_grupoDeAjustes$/.test(c)).join(" ") || model.className;
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "TrivoMod");
    group.dataset.trivomod = "grupo";
    const title = document.createElement("p");
    title.textContent = "TrivoMod";
    group.append(title);
    for (const [id, label, d] of SECTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.trivomod = id;
      const span = document.createElement("span");
      span.textContent = label;
      b.append(svgIcon(d, iconClass), span);
      b.addEventListener("click", (e) => { e.stopPropagation(); showEmbedded(id); });
      group.append(b);
    }
    // Antes de "Sobre" (como o Vencord, que fica junto das seções do app); sem ele, antes de "Sair".
    const about = groups.find((g) => /^Sobre$/i.test(((g.querySelector(":scope > p") || {}).textContent || "").trim()));
    const signOut = groups.find((g) => g.querySelector(byModule("sairNaLista")));
    const anchor = about || signOut || null;
    aside.insertBefore(group, anchor);
    // Clique numa seção do próprio Trivo: a página do mod sai da frente.
    if (!listened.has(aside)) listened.add(aside), aside.addEventListener("click", (e) => {
      const el = e.target instanceof Element ? e.target : e.target && e.target.parentElement;
      const target = el ? el.closest("button, a") : null;
      if (target && !target.dataset.trivomod) hideEmbedded();
    }, true);
    const dialog = aside.closest("dialog");
    if (dialog && !listened.has(dialog)) {
      listened.add(dialog);
      dialog.addEventListener("close", hideEmbedded);
    }
    embed.aside = aside;
    embed.group = group;
  }

  function contentArea() {
    const dialog = embed.aside && embed.aside.closest(byModule("ajustesDialog"));
    return dialog ? dialog.querySelector(byModule("ajustesConteudo")) : null;
  }

  function showEmbedded(tab) {
    const area = contentArea();
    // Tela estreita: o Trivo mostra só a lista (a área da direita fica escondida) -> painel flutuante.
    if (!area || getComputedStyle(area).display === "none") return openSettings(tab);
    if (!embed.view || !area.contains(embed.view)) {
      embed.view = document.createElement("div");
      embed.view.id = "trivomod-settings-view";
      embed.view.dataset.plat = plat;
      embed.view.dataset.font = settings.native.enabled && settings.native.systemFont ? "system" : "app";
      embed.view.setAttribute("style", "position:absolute;inset:0;z-index:5;display:none;flex-direction:column;background:color-mix(in srgb, var(--surface-raised) 78%, var(--surface-base));");
      embed.root = embed.view.attachShadow({ mode: "open" });
      const style = new CSSStyleSheet();
      style.replaceSync(UI_CSS + EMBED_CSS);
      embed.root.adoptedStyleSheets = [style];
      embed.body = document.createElement("div");
      embed.body.className = "embed";
      embed.root.append(embed.body);
      area.append(embed.view);
    }
    embed.tab = tab;
    embed.view.hidden = false;
    embed.view.style.display = "flex";
    embed.aside.dataset.trivomodAtivo = "sim";
    for (const b of embed.group.querySelectorAll("button")) {
      if (b.dataset.trivomod === tab) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
    renderEmbedded();
    const main = embed.root.querySelector("main");
    if (main) main.focus({ preventScroll: true });
  }

  function hideEmbedded() {
    embed.tab = null;
    if (embed.view) {
      embed.view.hidden = true;
      embed.view.style.display = "none";
    }
    if (embed.aside) delete embed.aside.dataset.trivomodAtivo;
    if (embed.group) for (const b of embed.group.querySelectorAll("button")) b.removeAttribute("aria-current");
  }

  function closeTrivoSettings() {
    const dialog = embed.aside && embed.aside.closest("dialog");
    const close = dialog && [...dialog.querySelectorAll("button")].find((b) => /Fechar ajustes/i.test(b.getAttribute("aria-label") || b.textContent || ""));
    if (close) close.click();
    else if (dialog) dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  function renderEmbedded() {
    if (!embed.body || !embed.tab) return;
    if (embed.view) embed.view.dataset.font = settings.native.enabled && settings.native.systemFont ? "system" : "app";
    const current = TABS.find((t) => t[0] === embed.tab) || TABS[0];
    const label = (SECTIONS.find((x) => x[0] === embed.tab) || [])[1] || current[1];
    embed.body.replaceChildren(
      h("header", { class: "bar" },
        h("h2", {}, label),
        h("span", { class: "tag" }, `TrivoMod ${boot.info.version}`),
        h("button", { class: "close", "aria-label": "Fechar ajustes", onClick: closeTrivoSettings }, "×"),
      ),
      h("main", { tabIndex: -1 }, current[2]()),
    );
  }

  const EMBED_CSS = `
    .embed { display: flex; flex-direction: column; height: 100%; color: var(--text-primary, #eee); font-size: 14px; }
    .embed .bar { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 0 32px; border-bottom: 1px solid var(--line, #333); flex: none; }
    .embed .bar h2 { margin: 0; flex: 1; font-size: 1.125rem; font-family: var(--font-display, var(--font-ui)); font-weight: 650; letter-spacing: -.01em; }
    .embed main { flex: 1; overflow: auto; padding: 24px 32px 48px; display: flex; flex-direction: column; gap: 10px; outline: none; }
  `;

  // ------------------------------------------------------------ botão na barra do topo
  // Como o Vencord põe o botão dele na barra de ferramentas do Discord: com a tela logada aberta, o
  // botão do TrivoMod entra nas ações da barra do topo (ao lado de "Avisos") com o estilo dos botões
  // de ícone do Trivo. Sem a barra (tela de entrada etc.), fica o botão flutuante.
  const toolbar = { btn: null };
  function toolbarButton() {
    return Boolean(toolbar.btn && toolbar.btn.isConnected);
  }
  function syncToolbarButton() {
    const actions = document.querySelector(`${byModule("shell")} > ${byModule("bar")} > ${byModule("actions")}`);
    if (settings.showButton === false || !actions) {
      if (toolbar.btn) toolbar.btn.remove();
      return false;
    }
    if (!toolbar.btn) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.variante = "icone";
      b.dataset.trivomod = "botao";
      b.title = "TrivoMod (Cmd/Ctrl + Alt + T)";
      b.setAttribute("aria-label", "Abrir o TrivoMod");
      b.append(svgIcon(SECTIONS[0][2]));
      b.addEventListener("click", (e) => { e.stopPropagation(); if (ui.open) closeSettings(); else openSettings(); });
      toolbar.btn = b;
    }
    if (toolbar.btn.parentNode !== actions) actions.prepend(toolbar.btn);
    return true;
  }

  let scanQueued = false;
  function scanForSettings() {
    scanQueued = false;
    const hadButton = toolbarButton();
    if (syncToolbarButton() !== hadButton) renderFloating();
    const aside = document.querySelector(`dialog ${byModule("ajustesNavegacao")}`);
    if (!aside) {
      if (embed.aside) { embed.aside = null; embed.group = null; embed.view = null; embed.tab = null; }
      return;
    }
    if (aside !== embed.aside || !embed.group || !aside.contains(embed.group)) injectSettingsGroup(aside);
  }
  new MutationObserver(() => {
    if (!scanQueued) { scanQueued = true; requestAnimationFrame(scanForSettings); }
  }).observe(document, { childList: true, subtree: true }); // em document-start o <html> pode ainda não existir
  scanForSettings(); // os Ajustes podem já estar abertos quando o mod carrega

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && e.code === "KeyT") {
      e.preventDefault();
      if (ui.open) closeSettings(); else openSettings();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyP") {
      e.preventDefault();
      e.stopPropagation();
      openPalette();
    } else if (e.key === "Escape" && pal.open) {
      e.preventDefault();
      closePalette();
    } else if (e.key === "Escape" && ui.open) closeSettings();
  }, true);

  // A barra do topo pode surgir depois (login -> tela logada) e o tema do Trivo pode mudar:
  // nos dois casos a barra do casco precisa das cores novas.
  let lastBar = null;
  let frameCheck = 0;
  new MutationObserver(() => {
    const bar = document.querySelector(`${byModule("shell")} > ${byModule("bar")}`);
    if (bar !== lastBar) { lastBar = bar; queueFrame(); }
    else if (discordFrame() && !frameCheck) {
      frameCheck = requestAnimationFrame(() => { frameCheck = 0; if (JSON.stringify(frameData()) !== lastFrameKey) queueFrame(); });
    }
  }).observe(document, { childList: true, subtree: true });
  const watchTheme = () => {
    if (!document.documentElement) return setTimeout(watchTheme, 50);
    new MutationObserver(() => { queueFrame(); queueThemeIcon(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-tema", "data-barra", "class", "style"] });
  };
  watchTheme();
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { queueFrame(); queueThemeIcon(); });
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("navigatesuccess", () => { if (discordFrame()) queueFrame(); });
  }
  if (typeof native.onFrameAction === "function") {
    native.onFrameAction((id) => {
      if (id === "trivomod") { if (ui.open) closeSettings(); else openSettings(); }
      else if (id === "voltar") history.back();
      else if (id === "avancar") history.forward();
      else if (id === "avisos") {
        const bell = document.querySelector(`${byModule("shell")} > ${byModule("bar")} ${byModule("bell")}`);
        if (bell) bell.click();
      }
    });
  }
  if (typeof native.onSystemAccent === "function") {
    native.onSystemAccent((color) => {
      systemAccent = typeof color === "string" ? color : null;
      if (settings.native.systemAccent) applyStyles();
      if (ui.open) render();
    });
  }

  // ------------------------------------------------------------ API pública
  window.TrivoMod = {
    version: boot.info.version,
    definePlugin,
    openSettings,
    closeSettings,
    openPalette,
    registerCommand,
    toast,
    on,
    Utils,
    /** Módulos do site (Turbopack): find, findByProps, findByCode, waitFor… (null se o gancho não carregou). */
    get modules() { return window.__trivomodModules || null; },
    /** Ajustes atuais (cópia, só leitura). */
    get settings() { return clone(settings); },
    __loadPlugin(id, builtin, body) {
      loadingId = id;
      loadingBuiltin = builtin;
      try {
        body();
      } finally {
        loadingId = null;
      }
    },
    __pluginFailed(id, message) {
      log(`plugin ${id}: ${message}`);
    },
    __ready() {
      for (const p of plugins.values()) if (isEnabled(p)) startPlugin(p);
      applyStyles();
      // Boot estável: zera o contador do modo seguro automático.
      if (!boot.info.safeMode && typeof native.bootOk === "function") setTimeout(() => native.bootOk().catch(() => {}), 15000);
      if (boot.info.safeMode) {
        setTimeout(() => toast(boot.info.safeReason === "auto"
          ? "TrivoMod em modo seguro: o Trivo falhou ao abrir algumas vezes seguidas, então temas e plugins foram desligados."
          : "TrivoMod em modo seguro (TRIVOMOD_SAFE=1).", {
          tipo: "erro", duracao: 0,
          acao: boot.info.safeReason === "auto" && typeof native.leaveSafeMode === "function" ? { rotulo: "Sair do modo seguro", run: () => native.leaveSafeMode() } : null,
        }), 1500);
      }
      const mount = () => { ensureHost(); render(); queueThemeIcon(true); };
      if (document.readyState === "complete") mount();
      else window.addEventListener("load", () => setTimeout(mount, 300), { once: true });
      log(`pronto: ${themes.filter((t) => settings.themes[t.id]).length}/${themes.length} temas, ${[...plugins.values()].filter((p) => p.started).length}/${plugins.size} plugins ativos`);
    },
  };

  native.onThemesChanged((payload) => {
    if (Array.isArray(payload)) themes = clone(payload);
    else if (payload) {
      themes = clone(payload.themes || themes);
      layouts = clone(payload.layouts || layouts);
    }
    applyStyles();
    if (ui.open) render();
  });

  applyStyles();
  log(`runtime ${boot.info.version} carregado`);
})();
