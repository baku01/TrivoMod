"use strict";
// Roda no processo principal do Trivo, antes do código do app (ver o loader gerado pelo instalador).
//
// Faz três coisas e nenhuma outra:
//   1. registra o preload do mod em toda sessão que o Electron criar;
//   2. atende o IPC `trivomod:*` desse preload (ajustes, temas, pastas);
//   3. avisa as janelas quando um arquivo de tema muda.
// Ele NÃO lê mensagens e NÃO toca em cookies. A única requisição de rede é baixar os temas online
// que o próprio usuário colocou em `themeLinks` (https, até 1 MB cada).

const fs = require("node:fs");
const path = require("node:path");
const VERSION = require("../version");
const settingsStore = require("./settings");
const library = require("./library");
const { createIconManager } = require("./icon");
const safeState = require("./safemode");
const backup = require("./backup");
const { createThemeLinks } = require("./themelinks");
const { createUpdater } = require("./updater");

const DIST = path.resolve(__dirname, "..");

exports.start = function start({ dataDir, appPath }) {
  const electron = require("electron");
  const { app, ipcMain, shell, webContents, dialog, net, BaseWindow } = electron;

  const files = {
    settings: path.join(dataDir, "settings.json"),
    themes: path.join(dataDir, "themes"),
    layouts: path.join(dataDir, "layouts"),
    icon: {
      png: path.join(dataDir, "icon.png"),
      icns: path.join(dataDir, "icon.icns"),
      ico: path.join(dataDir, "icon.ico"),
      defaultPng: path.join(dataDir, "cache", "default-icon.png"),
      defaultIcns: path.join(dataDir, "cache", "default-icon.icns"),
      defaultIco: path.join(dataDir, "cache", "default-icon.ico"),
      log: path.join(dataDir, "logs", "icon.log"),
    },
    plugins: path.join(dataDir, "plugins"),
    logs: path.join(dataDir, "logs"),
    state: path.join(dataDir, "state.json"),
    linkCache: path.join(dataDir, "cache", "links"),
  };
  for (const dir of [files.themes, files.layouts, files.plugins, files.logs]) fs.mkdirSync(dir, { recursive: true });

  // Desenvolvimento: perfil do Electron isolado (o Trivo de release recusa `--user-data-dir` na linha de comando).
  if (process.env.TRIVOMOD_USER_DATA) app.setPath("userData", path.resolve(process.env.TRIVOMOD_USER_DATA));

  const allowed = new Set(["https://trivo.app.br", ...(process.env.TRIVOMOD_ORIGINS || "").split(",").filter(Boolean)]);
  // Modo seguro: pedido (TRIVOMOD_SAFE=1) ou automático (3 aberturas seguidas sem `boot-ok`).
  const boot = safeState.startBoot(files.state);
  const safeReason = process.env.TRIVOMOD_SAFE === "1" ? "env" : boot.auto ? "auto" : null;
  const safeMode = safeReason !== null;
  const selftest = process.env.TRIVOMOD_SELFTEST === "1";
  const debug = process.env.TRIVOMOD_DEBUG === "1";

  // ------------------------------------------------------------ log
  const logFile = path.join(files.logs, "main.log");
  try {
    if (fs.statSync(logFile).size > 1_000_000) fs.rmSync(logFile);
  } catch {
    /* sem log anterior */
  }
  const log = (...parts) => {
    const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(" ")}\n`;
    try {
      fs.appendFileSync(logFile, line);
    } catch {
      /* log é cortesia */
    }
  };
  log(`TrivoMod ${VERSION} iniciou (app: ${appPath}, seguro: ${safeReason || "não"}, falhas seguidas: ${boot.failedBoots - 1}, depuração: ${debug})`);

  // ------------------------------------------------------------ atualização automática (src/main/updater.js)
  // Só quando o Trivo roda a cópia instalada em <dados>/dist (rodando do código-fonte não mexe em
  // nada) e fora do autoteste. TRIVOMOD_NO_UPDATE=1 desliga de vez.
  let updater = null;
  // realpath: o require resolve links simbólicos (no macOS /var -> /private/var), o dataDir não.
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  if (real(DIST) === real(path.join(dataDir, "dist")) && process.env.TRIVOMOD_NO_UPDATE !== "1" && !selftest) {
    try {
      updater = createUpdater({
        dataDir,
        currentVersion: VERSION,
        fetch: (url, opts) => (net && typeof net.fetch === "function" ? net.fetch(url, opts) : fetch(url, opts)),
        log,
      });
      // Versão recém-aplicada que não chega ao boot-ok: volta para a anterior e reabre o Trivo.
      // Modo seguro pedido à mão não conta (não prova que a versão está quebrada).
      const back = updater.onStartup({ countBoot: safeReason !== "env" });
      if (back.rolledBack) {
        safeState.reset(files.state); // as falhas eram da versão desfeita
        app.relaunch();
        app.exit(0);
        return;
      }
    } catch (error) {
      log("atualizador na abertura:", error);
    }
  }

  // ------------------------------------------------------------ confiança
  /** Só o quadro principal de uma origem do Trivo fala com o mod. */
  const isTrusted = (event) => {
    try {
      const frame = event.senderFrame;
      return Boolean(frame) && frame.parent === null && allowed.has(new URL(frame.url).origin);
    } catch {
      return false;
    }
  };

  /** webContents de uma página do Trivo (origem permitida)? */
  const isTrivoContents = (wc) => {
    try {
      return allowed.has(new URL(wc.getURL()).origin);
    } catch {
      return false;
    }
  };

  const isAudioImproved = () => !safeMode && Boolean(currentSettings().plugins && currentSettings().plugins["builtin:audio-aprimorado"]);
  const applyThrottling = (wc) => {
    try {
      if (!wc || typeof wc.setBackgroundThrottling !== "function") return;
      if (typeof wc.isDestroyed === "function" && wc.isDestroyed()) return;
      if (!isTrivoContents(wc)) return;
      wc.setBackgroundThrottling(!isAudioImproved());
    } catch {
      /* janela já foi destruída ou sem URL */
    }
  };
  const syncThrottling = () => {
    for (const wc of webContents.getAllWebContents()) applyThrottling(wc);
  };

  // Queda do processo da página conta como abertura que falhou.
  app.on("web-contents-created", (_event, wc) => {
    wc.on("did-start-loading", () => applyThrottling(wc));
    wc.on("did-finish-load", () => applyThrottling(wc));
    wc.on("render-process-gone", (_e, details) => {
      const reason = details && details.reason;
      if (reason === "clean-exit" || !isTrivoContents(wc)) return;
      safeState.fail(files.state);
      log(`processo da página caiu (${reason}); falhas seguidas: ${safeState.read(files.state)}`);
    });
  });

  // ------------------------------------------------------------ preload
  const preload = path.join(DIST, "preload", "index.js");
  const seen = new WeakSet();
  app.on("session-created", (ses) => {
    if (seen.has(ses)) return;
    seen.add(ses);
    try {
      // `matches`: o preload nem chega a rodar fora da origem do Trivo (telas do casco, iframes de terceiros).
      if (typeof ses.registerPreloadScript === "function") {
        ses.registerPreloadScript({ type: "frame", filePath: preload, matches: [...allowed].map((origin) => `${origin}/*`) });
      } else {
        ses.setPreloads([...ses.getPreloads(), preload]);
      }
      log("preload registrado em uma sessão");
    } catch (error) {
      log("falha ao registrar o preload:", error);
    }
  });

  if (debug) {
    const rendererLog = path.join(files.logs, "renderer.log");
    app.on("web-contents-created", (_event, wc) => {
      wc.on("console-message", (event, level, message) => {
        const text = typeof event.message === "string" ? event.message : message; // assinatura nova x antiga
        if (typeof text === "string" && text.includes("[TrivoMod]")) {
          try {
            fs.appendFileSync(rendererLog, `${new Date().toISOString()} ${text}\n`);
          } catch {
            /* nada */
          }
        }
      });
    });
  }

  // ------------------------------------------------------------ autoteste (desenvolvimento)
  // TRIVOMOD_SELFTEST=1: na primeira página do Trivo, abre o painel, liga um tema, grava
  // logs/selftest/result.json e panel.png (captura da janela) e encerra o app.
  if (selftest) {
    const out = path.join(files.logs, "selftest");
    fs.mkdirSync(out, { recursive: true });
    const probe = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const bg = () => getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
      const r = { url: location.href, tema: document.documentElement.dataset.tema || null, TrivoMod: typeof window.TrivoMod, TrivoModNative: typeof window.TrivoModNative };
      if (!window.TrivoMod) return r;
      r.version = TrivoMod.version; r.bgAntes = bg();
      TrivoMod.openSettings(); await sleep(300);
      const root = document.getElementById("trivomod-root") && document.getElementById("trivomod-root").shadowRoot;
      r.painelAberto = Boolean(root && root.querySelector(".panel"));
      r.botaoTM = Boolean(root && root.querySelector(".fab"));
      const card = () => [...root.querySelectorAll("main .card")].find((c) => c.textContent.includes("Violeta"));
      r.temas = [...root.querySelectorAll("main .card .name")].map((n) => n.textContent.trim());
      card().querySelector(".switch").click(); await sleep(400);
      r.bgComVioleta = bg(); r.folhasDeEstilo = document.adoptedStyleSheets.length;
      [...root.querySelectorAll("nav button")].find((b) => b.textContent === "Plugins").click(); await sleep(150);
      r.plugins = [...root.querySelectorAll("main .card .name")].map((n) => n.textContent.trim());
      const tab = async (label) => { [...root.querySelectorAll("nav button")].find((b) => b.textContent === label).click(); await sleep(250); };
      // Layout: escolhe "Discord" e mede o que mudou.
      await tab("Layout");
      r.layouts = [...root.querySelectorAll("main .card .name")].map((n) => n.textContent.trim());
      [...root.querySelectorAll("main button.card")].find((c) => c.textContent.includes("Discord")).click(); await sleep(300);
      const cs = getComputedStyle(document.documentElement);
      r.layoutDiscord = { barra: cs.getPropertyValue("--barra-width").trim(), sidebar: cs.getPropertyValue("--sidebar-width").trim(), accent: cs.getPropertyValue("--accent").trim() };
      // Ícone: gera uma imagem, entrega ao campo de arquivo e clica em Aplicar.
      await tab("Ícone");
      const c = document.createElement("canvas"); c.width = c.height = 512;
      const g = c.getContext("2d"); const grad = g.createLinearGradient(0, 0, 512, 512);
      grad.addColorStop(0, "#cba6f7"); grad.addColorStop(1, "#89b4fa"); g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
      g.fillStyle = "#11111b"; g.font = "bold 220px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("TM", 256, 270);
      const blob = await new Promise((res) => c.toBlob(res, "image/png"));
      const input = root.querySelector("main input[type=file]");
      const dt = new DataTransfer(); dt.items.add(new File([blob], "teste.png", { type: "image/png" })); input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true })); await sleep(600);
      [...root.querySelectorAll("main button")].find((b) => b.textContent === "Aplicar").click(); await sleep(900);
      r.iconeStatus = [...root.querySelectorAll("main .hint")].map((x) => x.textContent).filter(Boolean).pop();
      return r;
    })()`;
    const cleanup = `(async () => { TrivoMod.openSettings(); await new Promise((r) => setTimeout(r, 200));
      const root = document.getElementById("trivomod-root").shadowRoot;
      [...root.querySelectorAll("nav button")].find((b) => b.textContent === "Temas").click(); await new Promise((r) => setTimeout(r, 200));
      const c = [...root.querySelectorAll("main .card")].find((x) => x.textContent.includes("Violeta"));
      if (c && c.querySelector(".switch").checked) c.querySelector(".switch").click();
      await new Promise((r) => setTimeout(r, 600)); return true; })()`;
    let done = false;
    app.on("web-contents-created", (_event, wc) => {
      wc.on("did-finish-load", async () => {
        let origin = "";
        try {
          origin = new URL(wc.getURL()).origin;
        } catch {
          return;
        }
        if (done || !allowed.has(origin)) return;
        done = true;
        try {
          await new Promise((r) => setTimeout(r, 2500));
          const result = await wc.executeJavaScript(probe, true);
          fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
          fs.writeFileSync(path.join(out, "panel.png"), (await wc.capturePage()).toPNG());
          await wc.executeJavaScript(`(async () => { TrivoMod.closeSettings(); await new Promise((r) => setTimeout(r, 400)); })()`, true);
          fs.writeFileSync(path.join(out, "layout.png"), (await wc.capturePage()).toPNG());
          result.iconeGravado = fs.existsSync(files.icon.png) && fs.existsSync(files.icon.icns) && fs.existsSync(files.icon.ico);
          result.iconeOriginal = icon.originalState();
          fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
          await wc.executeJavaScript(cleanup, true);
        } catch (error) {
          log("autoteste falhou:", error);
          fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ error: String(error && error.message) }));
        } finally {
          setTimeout(() => app.exit(0), 300);
        }
      });
    });
  }

  // ------------------------------------------------------------ IPC
  const currentSettings = () => (safeMode ? settingsStore.defaults() : settingsStore.load(files.settings));
  const links = createThemeLinks({
    fetch: net && typeof net.fetch === "function" ? (url, opts) => net.fetch(url, opts) : null,
    cacheDir: files.linkCache,
    links: () => currentSettings().themeLinks,
    log,
  });
  const themes = () => [...library.listThemes(DIST, files.themes), ...links.list()];
  const layouts = () => library.listLayouts(DIST, files.layouts);

  // ------------------------------------------------------------ ícone do aplicativo
  const icon = createIconManager({ electron: require("electron"), files: files.icon, log });
  if (!safeMode) {
    app.whenReady().then(() => icon.reapply()).catch((error) => log("ícone na abertura:", error));
    // Janelas novas (a do Trivo é recriada ao reabrir pela bandeja) recebem o ícone também.
    app.on("web-contents-created", () => setTimeout(() => process.platform !== "darwin" && icon.reapply(), 0));
  }

  // ------------------------------------------------------------ janela nativa (src/main/native.js)
  let native = null;
  try {
    native = require("./native").createNativeManager({ electron, log, settings: () => currentSettings(), allowed, paletteFile: path.join(dataDir, "cache", "palette.json") });
  } catch (error) {
    if (!(error && error.code === "MODULE_NOT_FOUND" && String(error.message).includes("native"))) log("native.js falhou:", error);
  }
  if (native && !safeMode) {
    try {
      native.start();
    } catch (error) {
      log("native.start falhou:", error);
    }
  }
  const nativeInfo = () => {
    try {
      return native ? native.info() : null;
    } catch (error) {
      log("native.info falhou:", error);
      return null;
    }
  };

  // Hook de módulos do Turbopack: roda no mundo principal antes dos scripts da página.
  const modulesHook = () => {
    if (safeMode) return "";
    try {
      return fs.readFileSync(path.join(DIST, "renderer", "turbopack.js"), "utf8");
    } catch {
      return "";
    }
  };

  const defaultIconSource = () => {
    try {
      return fs.readFileSync(path.join(DIST, "default-icon.js"), "utf8");
    } catch {
      return "";
    }
  };

  ipcMain.on("trivomod:boot", (event) => {
    if (!isTrusted(event)) {
      event.returnValue = null;
      return;
    }
    try {
      const plugins = library.listPlugins(DIST, files.plugins);
      event.returnValue = {
        runtime: fs.readFileSync(path.join(DIST, "renderer", "index.js"), "utf8"),
        defaultIcon: defaultIconSource(),
        modulesHook: modulesHook(),
        settings: currentSettings(),
        themes: themes(),
        layouts: layouts(),
        plugins: plugins.map((p) => ({ id: p.id, builtin: p.builtin, source: p.source })),
        info: {
          version: VERSION,
          dataDir,
          safeMode,
          safeReason,
          platform: process.platform,
          customIcon: icon.hasCustom(),
          iconState: icon.originalState(),
          native: nativeInfo(),
        },
      };
    } catch (error) {
      log("boot falhou:", error);
      event.returnValue = null;
    }
  });

  ipcMain.handle("trivomod:save-settings", (event, incoming) => {
    if (!isTrusted(event) || safeMode) return false;
    settingsStore.save(files.settings, incoming);
    syncThrottling();
    return true;
  });

  ipcMain.handle("trivomod:set-icon", async (event, dataUrl) => {
    if (!isTrusted(event) || safeMode) return { ok: false, error: "não permitido" };
    try {
      return { ok: true, ...(await icon.set(dataUrl)) };
    } catch (error) {
      log("ícone recusado:", error);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("trivomod:set-theme-icon", async (event, dataUrl) => {
    if (!isTrusted(event) || safeMode) return { ok: false, error: "não permitido" };
    try {
      return { ok: true, ...(await icon.setTheme(dataUrl)) };
    } catch (error) {
      log("ícone padrão recusado:", error);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("trivomod:reset-icon", async (event) => {
    if (!isTrusted(event) || safeMode) return { ok: false, error: "não permitido" };
    return { ok: true, ...(await icon.reset()) };
  });

  ipcMain.handle("trivomod:restart-apply-icon", (event) => {
    if (!isTrusted(event) || safeMode) return false;
    return icon.restartToApply();
  });

  ipcMain.handle("trivomod:open-folder", async (event, kind) => {
    if (!isTrusted(event)) return false;
    const dir = { themes: files.themes, layouts: files.layouts, plugins: files.plugins, data: dataDir }[kind];
    if (!dir) return false;
    return (await shell.openPath(dir)) === ""; // openPath devolve texto de erro, ou "" se deu certo
  });

  ipcMain.handle("trivomod:set-frame", async (event, payload) => {
    if (!isTrusted(event)) return false;
    try {
      return native ? await native.setFrame(event.sender, payload) : false;
    } catch (error) {
      log("set-frame falhou:", error);
      return false;
    }
  });

  // ------------------------------------------------------------ modo seguro
  // A página chama 15 s depois de carregar: esta abertura deu certo. Em modo seguro não conta
  // (uma abertura segura não prova nada); para sair dele existe `leave-safe-mode`.
  ipcMain.handle("trivomod:boot-ok", (event) => {
    if (!isTrusted(event) || safeMode) return false;
    safeState.reset(files.state);
    if (updater) updater.confirm(); // a versão aplicada por último funciona
    return true;
  });

  ipcMain.handle("trivomod:leave-safe-mode", (event) => {
    if (!isTrusted(event)) return false;
    safeState.reset(files.state);
    log("saindo do modo seguro: reiniciando");
    setTimeout(() => {
      if (!selftest) app.relaunch();
      app.exit(0);
    }, 100);
    return true;
  });

  // ------------------------------------------------------------ backup
  const windowOf = (sender) => {
    try {
      return BaseWindow.getAllWindows().find((w) => w.contentView.children.some((v) => v.webContents === sender)) || null;
    } catch {
      return null;
    }
  };
  const withWindow = (sender, fn, opts) => {
    const win = windowOf(sender);
    return win ? fn(win, opts) : fn(opts);
  };
  const userDirs = { settings: files.settings, themes: files.themes, layouts: files.layouts, plugins: files.plugins };

  ipcMain.handle("trivomod:export-backup", async (event) => {
    if (!isTrusted(event)) return { ok: false, error: "não permitido" };
    try {
      const data = backup.build(userDirs);
      const res = await withWindow(event.sender, (...a) => dialog.showSaveDialog(...a), {
        title: "Salvar backup do TrivoMod",
        defaultPath: backup.defaultName(),
        filters: [{ name: "Backup do TrivoMod", extensions: ["json"] }],
      });
      if (!res || res.canceled || !res.filePath) return { ok: false, canceled: true, error: "cancelado" };
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
      log(`backup exportado: ${res.filePath}`);
      return { ok: true, path: res.filePath, counts: backup.count(data) };
    } catch (error) {
      log("exportar backup falhou:", error);
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("trivomod:import-backup", async (event) => {
    if (!isTrusted(event) || safeMode) return { ok: false, error: "não permitido" };
    try {
      const res = await withWindow(event.sender, (...a) => dialog.showOpenDialog(...a), {
        title: "Importar backup do TrivoMod",
        properties: ["openFile"],
        filters: [{ name: "Backup do TrivoMod", extensions: ["json"] }],
      });
      if (!res || res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true, error: "cancelado" };
      const data = backup.parse(res.filePaths[0]);
      const counts = backup.apply(userDirs, data);
      log(`backup importado: ${res.filePaths[0]}`);
      broadcast();
      refreshLinks().catch(() => {});
      return { ok: true, counts };
    } catch (error) {
      log("importar backup falhou:", error);
      return { ok: false, error: error.message };
    }
  });

  // ------------------------------------------------------------ temas online
  const refreshLinks = async () => {
    const results = await links.refresh();
    broadcast();
    return results;
  };
  ipcMain.handle("trivomod:refresh-theme-links", async (event) => {
    if (!isTrusted(event) || safeMode) return [];
    try {
      return await refreshLinks();
    } catch (error) {
      log("atualizar temas online falhou:", error);
      return [];
    }
  });
  if (!safeMode) {
    app
      .whenReady()
      .then(() => (currentSettings().themeLinks.length ? refreshLinks() : links.refresh()))
      .catch((error) => log("temas online na abertura:", error));
  }

  // ------------------------------------------------------------ atualização automática
  const UPDATE_FIRST_CHECK_MS = 30_000;
  const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const updatesOn = () => Boolean(updater) && !safeMode && currentSettings().autoUpdate !== false;
  const updateStatus = () => ({
    available: Boolean(updater) && !safeMode,
    enabled: updatesOn(),
    ...(updater ? updater.status() : { current: VERSION, staged: null, lastCheck: null, lastError: null, blocked: [] }),
  });
  const notifyUpdate = (version) => {
    for (const wc of webContents.getAllWebContents()) {
      try {
        if (allowed.has(new URL(wc.mainFrame.url).origin)) wc.send("trivomod:update-ready", { version });
      } catch {
        /* contents destruído ou sem URL */
      }
    }
  };
  const checkUpdate = async () => {
    const result = await updater.check();
    if (result.state === "pronta" && result.nova) notifyUpdate(result.version);
    return result;
  };
  if (updater && !safeMode) {
    app
      .whenReady()
      .then(() => {
        const tick = () => {
          if (updatesOn()) checkUpdate().catch((error) => log("verificar atualização:", error));
        };
        setTimeout(tick, UPDATE_FIRST_CHECK_MS).unref?.();
        setInterval(tick, UPDATE_INTERVAL_MS).unref?.();
      })
      .catch((error) => log("agendar atualização:", error));
  }
  ipcMain.handle("trivomod:update-status", (event) => (isTrusted(event) ? updateStatus() : null));
  ipcMain.handle("trivomod:check-update", async (event) => {
    if (!isTrusted(event) || !updater || safeMode) return { state: "indisponivel" };
    return checkUpdate();
  });
  ipcMain.handle("trivomod:restart-to-update", (event) => {
    if (!isTrusted(event) || !updater || !updater.status().staged) return false;
    log("reiniciando para aplicar a atualização");
    setTimeout(() => {
      if (!selftest) app.relaunch();
      app.quit(); // "will-quit" aplica a versão baixada
    }, 100);
    return true;
  });

  // ------------------------------------------------------------ temas ao vivo
  let timer = null;
  const broadcast = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const payload = { themes: themes(), layouts: layouts() };
      for (const wc of webContents.getAllWebContents()) {
        try {
          if (allowed.has(new URL(wc.mainFrame.url).origin)) wc.send("trivomod:themes-changed", payload);
        } catch {
          /* contents destruído ou sem URL */
        }
      }
    }, 150);
  };
  const watchers = [];
  for (const dir of [files.themes, files.layouts, path.join(DIST, "themes"), path.join(DIST, "layouts")]) {
    try {
      watchers.push(fs.watch(dir, { persistent: false }, broadcast));
    } catch (error) {
      log(`sem watch em ${dir}:`, error);
    }
  }

  // Ao fechar: troca para a versão baixada. Antes fecha os watches, que no Windows seguram a pasta
  // dist e fariam a troca de nome falhar.
  if (updater) {
    app.on("will-quit", () => {
      for (const w of watchers.splice(0)) {
        try {
          w.close();
        } catch {
          /* já fechado */
        }
      }
      try {
        updater.applyPending();
      } catch (error) {
        log("aplicar atualização ao fechar:", error);
      }
    });
  }
  // ------------------------------------------------------------ sonda de desenvolvimento
  // Só existe se a pasta <dados>/dev existir na abertura (quem cria é o desenvolvedor). Escrever
  // dev/request.js roda o script na página do Trivo e grava dev/response.json + dev/shot.png.
  // Não amplia o acesso: quem escreve na pasta de dados já pode instalar plugins.
  const devDir = path.join(dataDir, "dev");
  if (fs.existsSync(devDir)) {
    log("sonda de desenvolvimento ativa");
    let busy = false;
    const run = async () => {
      const req = path.join(devDir, "request.js");
      if (busy || !fs.existsSync(req)) return;
      busy = true;
      const code = fs.readFileSync(req, "utf8");
      fs.rmSync(req, { force: true });
      const out = [];
      for (const wc of webContents.getAllWebContents()) {
        try {
          if (wc.isDestroyed() || !allowed.has(new URL(wc.mainFrame.url).origin)) continue;
          if (code.trim() === "reload") { wc.reload(); out.push({ url: wc.getURL(), reloaded: true }); continue; }
          const value = await wc.executeJavaScript(`(async () => { ${code}\n })()`, true);
          fs.writeFileSync(path.join(devDir, "shot.png"), (await wc.capturePage()).toPNG());
          out.push({ url: wc.getURL(), value });
        } catch (error) {
          out.push({ error: String(error && error.stack || error) });
        }
      }
      fs.writeFileSync(path.join(devDir, "response.json"), JSON.stringify(out, null, 1));
      busy = false;
    };
    fs.watch(devDir, { persistent: false }, () => setTimeout(run, 50));
  }
};
