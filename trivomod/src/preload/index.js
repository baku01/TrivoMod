"use strict";
// Preload do mod. Roda (isolado) em cada página do Trivo, junto do preload do próprio app.
//   - só age na origem do Trivo;
//   - expõe `window.TrivoModNative` (ajustes, pastas, aviso de tema alterado);
//   - injeta o runtime e os plugins no mundo principal via webFrame, que não passa
//     pela CSP da página (a CSP do Trivo proíbe eval e script de fora).

const { contextBridge, ipcRenderer, webFrame } = require("electron");

(function main() {
  if (window.parent !== window) return;
  const origin = location.origin;
  if (!origin || origin === "null") return;
  const arg = process.argv.find((a) => a.startsWith("--trivo-origem="));
  const appOrigin = arg ? arg.slice(arg.indexOf("=") + 1) : "";
  if (origin !== "https://trivo.app.br" && origin !== appOrigin) return;

  const boot = ipcRenderer.sendSync("trivomod:boot"); // null se o processo principal não confiar nesta página
  if (!boot) return;

  // Hook de módulos do Turbopack: primeiro de tudo e sem esperar, para rodar antes dos scripts da página.
  if (boot.modulesHook && !(boot.info && boot.info.safeMode)) {
    try {
      webFrame
        .executeJavaScript(`${boot.modulesHook}\n//# sourceURL=trivomod/turbopack.js`)
        .catch((error) => console.error("[TrivoMod] hook de módulos falhou:", error));
    } catch (error) {
      console.error("[TrivoMod] hook de módulos falhou:", error);
    }
  }

  let onThemes = null;
  ipcRenderer.on("trivomod:themes-changed", (_event, themes) => {
    if (onThemes) onThemes(themes);
  });
  let onFrame = null;
  ipcRenderer.on("trivomod:frame-action", (_event, id) => {
    if (onFrame && typeof id === "string") onFrame(id);
  });
  let onAccent = null;
  ipcRenderer.on("trivomod:system-accent", (_event, accent) => {
    if (onAccent) onAccent(accent);
  });
  // Atualização baixada: guarda o aviso se a página ainda não pediu para ouvir.
  let onUpdate = null;
  let updateReady = null;
  ipcRenderer.on("trivomod:update-ready", (_event, payload) => {
    const version = payload && typeof payload.version === "string" ? payload.version : null;
    if (!version) return;
    updateReady = version;
    if (onUpdate) onUpdate(version);
  });

  contextBridge.exposeInMainWorld("TrivoModNative", {
    boot: {
      settings: boot.settings,
      themes: boot.themes,
      layouts: boot.layouts || [],
      plugins: boot.plugins.map((p) => ({ id: p.id, builtin: p.builtin })),
      info: boot.info,
    },
    saveSettings: (settings) => ipcRenderer.invoke("trivomod:save-settings", settings),
    setIcon: (dataUrl) => ipcRenderer.invoke("trivomod:set-icon", String(dataUrl)),
    setThemeIcon: (dataUrl) => ipcRenderer.invoke("trivomod:set-theme-icon", String(dataUrl)),
    resetIcon: () => ipcRenderer.invoke("trivomod:reset-icon"),
    restartToApplyIcon: () => ipcRenderer.invoke("trivomod:restart-apply-icon"),
    openFolder: (kind) => ipcRenderer.invoke("trivomod:open-folder", String(kind)),
    onThemesChanged: (callback) => {
      onThemes = typeof callback === "function" ? callback : null;
    },
    bootOk: () => ipcRenderer.invoke("trivomod:boot-ok"),
    leaveSafeMode: () => ipcRenderer.invoke("trivomod:leave-safe-mode"),
    exportBackup: () => ipcRenderer.invoke("trivomod:export-backup"),
    importBackup: () => ipcRenderer.invoke("trivomod:import-backup"),
    refreshThemeLinks: () => ipcRenderer.invoke("trivomod:refresh-theme-links"),
    setFrame: (payload) => ipcRenderer.invoke("trivomod:set-frame", payload),
    onFrameAction: (callback) => {
      onFrame = typeof callback === "function" ? callback : null;
    },
    onSystemAccent: (callback) => {
      onAccent = typeof callback === "function" ? callback : null;
    },
    updateStatus: () => ipcRenderer.invoke("trivomod:update-status"),
    checkUpdate: () => ipcRenderer.invoke("trivomod:check-update"),
    restartToUpdate: () => ipcRenderer.invoke("trivomod:restart-to-update"),
    onUpdateReady: (callback) => {
      onUpdate = typeof callback === "function" ? callback : null;
      if (onUpdate && updateReady) onUpdate(updateReady);
    },
  });

  const run = (code, name) => webFrame.executeJavaScript(`${code}\n//# sourceURL=trivomod/${name}`);

  (async () => {
    if (boot.defaultIcon) {
      try {
        await run(boot.defaultIcon, "default-icon.js");
      } catch (error) {
        console.error("[TrivoMod] ícone padrão falhou ao carregar:", error);
      }
    }
    try {
      await run(boot.runtime, "runtime.js");
    } catch (error) {
      console.error("[TrivoMod] runtime falhou:", error);
      return;
    }
    for (const plugin of boot.plugins) {
      // Cada plugin num script próprio: erro de sintaxe derruba só ele.
      const wrapped = `TrivoMod.__loadPlugin(${JSON.stringify(plugin.id)}, ${plugin.builtin}, function () {\n${plugin.source}\n});`;
      try {
        await run(wrapped, `plugins/${plugin.id.replace(/[^\w.-]/g, "_")}.js`);
      } catch (error) {
        console.error(`[TrivoMod] plugin ${plugin.id} falhou ao carregar:`, error);
        run(`TrivoMod.__pluginFailed(${JSON.stringify(plugin.id)}, ${JSON.stringify(String((error && error.message) || error))})`, "fail.js").catch(() => {});
      }
    }
    run("TrivoMod.__ready()", "ready.js").catch((error) => console.error("[TrivoMod]", error));
  })();
})();
