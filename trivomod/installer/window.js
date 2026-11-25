"use strict";
// Abre a interface do instalador em uma JANELA nativa própria (sem abrir abas no navegador):
//   - macOS:   janela Cocoa + WKWebView (binário Swift compilado em cache, com fallback JXA/osascript sem Xcode);
//   - Windows: janela dedicada em modo app (--app=) via Edge/Chrome/Brave com perfil temporário;
//   - Linux:   janela dedicada em modo app (--app=) via Chromium/Chrome/Edge/Brave com perfil temporário.
// Quando a janela fecha, o callback `onClose` é chamado na hora para encerrar o servidor local.

const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const patch = require("./patch");

const WIDTH = 620;
const HEIGHT = 700;
const MAC_SWIFT = path.join(__dirname, "window-mac.swift");
const MAC_BIN_DIR = path.join(__dirname, "bin");

function isLoopbackUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && u.hostname === "127.0.0.1" && Boolean(u.port);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ macOS (Cocoa + WKWebView)
function hasXcodeTools() {
  try {
    const r = cp.spawnSync("/usr/bin/xcode-select", ["-p"], { stdio: "ignore", timeout: 3000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Procura binário pré-compilado entregue no pacote da release (sem precisar de Xcode). */
function findBundledMacBinary(binDir = MAC_BIN_DIR, arch = process.arch, exists = fs.existsSync) {
  for (const name of [`trivomod-window-darwin-${arch}`, "trivomod-window-darwin"]) {
    const full = path.join(binDir, name);
    if (exists(full)) return full;
  }
  return null;
}

function ensureMacBinary(cacheDir, opts = {}) {
  const bundled = findBundledMacBinary(opts.binDir);
  if (bundled) return bundled;
  if (!fs.existsSync(MAC_SWIFT)) return null;
  const src = fs.readFileSync(MAC_SWIFT, "utf8");
  const hash = crypto.createHash("sha256").update(src).digest("hex").slice(0, 12);
  const dir = cacheDir || path.join(patch.dataDir(), "cache");
  const bin = path.join(dir, `trivomod-window-${process.arch}-${hash}`);
  if (fs.existsSync(bin)) return bin;
  if (!hasXcodeTools()) return null;
  fs.mkdirSync(dir, { recursive: true });
  const modCache = path.join(dir, "swift-module-cache");
  fs.mkdirSync(modCache, { recursive: true });
  const tmp = `${bin}.${process.pid}.tmp`;
  const r = cp.spawnSync("/usr/bin/swiftc", ["-O", "-module-cache-path", modCache, MAC_SWIFT, "-o", tmp], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.status === 0 && fs.existsSync(tmp)) {
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, bin);
    return bin;
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignora */ }
  return null;
}

// Fallback sem Xcode no macOS: abre NSWindow + WKWebView diretamente via ponte ObjC do JXA (osascript).
function macJxaScript(url, width, height) {
  return `
ObjC.import('Cocoa');
ObjC.import('WebKit');
(function () {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
  var style = $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskMiniaturizable | $.NSWindowStyleMaskResizable;
  var rect = $.NSMakeRect(0, 0, ${Number(width)}, ${Number(height)});
  var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(rect, style, $.NSBackingStoreBuffered, false);
  win.title = $('Instalador do TrivoMod');
  win.minSize = $.NSMakeSize(480, 520);
  win.releasedWhenClosed = false;
  ObjC.registerSubclass({
    name: 'TMWindowDelegate',
    superclass: 'NSObject',
    protocols: ['NSWindowDelegate'],
    methods: {
      'windowWillClose:': { types: ['void', ['id']], implementation: function () { $.NSApp.terminate(null); } }
    }
  });
  var delegate = $.TMWindowDelegate.alloc.init;
  win.delegate = delegate;
  var cfg = $.WKWebViewConfiguration.alloc.init;
  cfg.websiteDataStore = $.WKWebsiteDataStore.nonPersistentDataStore;
  var web = $.WKWebView.alloc.initWithFrameConfiguration(rect, cfg);
  web.autoresizingMask = $.NSViewWidthSizable | $.NSViewHeightSizable;
  win.contentView = web;
  win.center;
  win.makeKeyAndOrderFront(null);
  app.activateIgnoringOtherApps(true);
  web.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(${JSON.stringify(url)})));
  app.run;
})();
`;
}

function launchMac(url, { width = WIDTH, height = HEIGHT, cacheDir, onClose, spawn = cp.spawn } = {}) {
  const bin = ensureMacBinary(cacheDir);
  const child = bin
    ? spawn(bin, [url, String(width), String(height)], { stdio: "ignore" })
    : spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", macJxaScript(url, width, height)], { stdio: "ignore" });
  const kind = bin ? "mac-swift" : "mac-jxa";
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    if (typeof onClose === "function") onClose();
  };
  child.once("exit", finish);
  child.once("error", () => {});
  return {
    kind,
    child,
    close() {
      closed = true;
      try { child.kill("SIGTERM"); } catch { /* já saiu */ }
    },
  };
}

// ------------------------------------------------------------ Windows / Linux (modo janela --app=)
function findAppHost(platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (platform === "win32") {
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const pf = env.ProgramFiles || "C:\\Program Files";
    const local = env.LOCALAPPDATA || "";
    const candidates = [
      path.win32.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.win32.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      local && path.win32.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.win32.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.win32.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      local && path.win32.join(local, "Google", "Chrome", "Application", "chrome.exe"),
      path.win32.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      local && path.win32.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ].filter(Boolean);
    return candidates.find((p) => exists(p)) || null;
  }
  const bins = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge", "brave-browser"];
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const name of bins) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      if (exists(full)) return full;
    }
  }
  return null;
}

function appWindowArgs(url, profileDir, width = WIDTH, height = HEIGHT) {
  return [
    `--app=${url}`,
    `--window-size=${width},${height}`,
    "--new-window",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
  ];
}

function launchChromiumApp(url, { platform = process.platform, width = WIDTH, height = HEIGHT, onClose, spawn = cp.spawn, env = process.env, exists = fs.existsSync } = {}) {
  const host = findAppHost(platform, env, exists);
  if (!host) return null;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-win-"));
  const cleanup = () => {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignora */ }
  };
  const child = spawn(host, appWindowArgs(url, profileDir, width, height), { stdio: "ignore", windowsHide: false });
  let closed = false;
  const finish = () => {
    cleanup();
    if (closed) return;
    closed = true;
    if (typeof onClose === "function") onClose();
  };
  child.once("exit", finish);
  child.once("error", () => cleanup());
  return {
    kind: platform === "win32" ? "win-app" : "linux-app",
    host,
    child,
    close() {
      closed = true;
      try { child.kill(); } catch { /* já saiu */ }
      setTimeout(cleanup, 300).unref?.();
    },
  };
}

function openWindow(url, opts = {}) {
  if (!isLoopbackUrl(url)) throw new Error("A janela do instalador só aceita URL local em 127.0.0.1.");
  const platform = opts.platform || process.platform;
  if (platform === "darwin") return launchMac(url, opts);
  return launchChromiumApp(url, { ...opts, platform });
}

module.exports = { openWindow, findAppHost, appWindowArgs, findBundledMacBinary, ensureMacBinary, macJxaScript, isLoopbackUrl, WIDTH, HEIGHT };
