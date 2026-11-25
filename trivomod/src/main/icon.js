"use strict";
// Ícone do aplicativo. O recorte arredondado é feito no painel (canvas da página); aqui chega um PNG
// pronto (1024 px). Ele vira <dados>/icon.png, icon.icns e icon.ico, e é aplicado em duas camadas:
//
//   1. Na hora, no app aberto: Dock (macOS) ou ícone das janelas (Windows/Linux).
//   2. No ícone ORIGINAL, para o Dock/Finder/barra de tarefas ficarem certos com o Trivo fechado:
//      - macOS: troca Contents/Resources/icon.icns e reassina o pacote (ad-hoc, como o instalador).
//        Reassinar reescreve o executável, então isso só roda DEPOIS que o Trivo fecha: um ajudante
//        (/bin/sh, solto do processo) espera o PID sair, troca, reassina e, se pedido, reabre o app.
//        O original fica em icon.icns.trivomod-original (o desinstalador devolve).
//      - Windows: a barra de tarefas tira o ícone do atalho (.lnk) do Menu Iniciar/Área de Trabalho/
//        fixados. Os atalhos que apontam para este Trivo.exe passam a usar <dados>/icon.ico. O .exe
//        não muda.
//      - Linux: só a camada 1 (o .desktop é do pacote do sistema).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const { ALL_SIZES, buildIcns, buildIco } = require("../iconfiles");

const MAX_BYTES = 6 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ORIGINAL_SUFFIX = ".trivomod-original";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** Aceita só `data:image/png;base64,…` de um PNG de verdade, até 6 MB. */
function decodePngDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_BYTES * 1.4) throw new Error("imagem grande demais");
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("formato inválido: esperado PNG");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > MAX_BYTES || buf.length < 64 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error("PNG inválido");
  return buf;
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const fileSha = (file) => {
  try {
    return sha(fs.readFileSync(file));
  } catch {
    return null;
  }
};

/** Pacote .app a partir do executável (…/Trivo.app/Contents/MacOS/Trivo). */
function macBundleOf(execPath) {
  const root = path.resolve(execPath, "..", "..", "..");
  return root.endsWith(".app") ? root : null;
}

/**
 * Script do ajudante do macOS. Recebe tudo por argumento posicional (nada é interpolado no texto):
 *   $1 PID a esperar   $2 pacote .app   $3 .icns novo ("" = restaurar o original)   $4 log   $5 "1" reabre
 */
const MAC_HELPER = `
pid="$1"; app="$2"; new="$3"; log="$4"; reopen="$5"
res="$app/Contents/Resources"; orig="$res/icon.icns${ORIGINAL_SUFFIX}"
n=0; while kill -0 "$pid" 2>/dev/null; do sleep 0.2; n=$((n+1)); [ "$n" -gt 600 ] && exit 1; done
{
  echo "--- $(date) ícone: \${new:-restaurar original} em $app"
  [ -f "$res/icon.icns" ] || { echo "sem icon.icns"; exit 1; }
  if [ -n "$new" ]; then
    [ -f "$orig" ] || cp -p "$res/icon.icns" "$orig" || exit 1
    cp "$new" "$res/icon.icns.tmp" && mv -f "$res/icon.icns.tmp" "$res/icon.icns" || exit 1
  else
    [ -f "$orig" ] && { mv -f "$orig" "$res/icon.icns" || exit 1; }
  fi
  /usr/bin/codesign --force --sign - --preserve-metadata=identifier,entitlements,requirements,flags,runtime "$app" \\
    && /usr/bin/codesign --verify --deep --strict "$app" && echo "assinatura ok"
  touch "$app"
  [ -x "${LSREGISTER}" ] && "${LSREGISTER}" -f "$app"
  [ "$reopen" = "1" ] && /usr/bin/open "$app"
  echo "concluído"
} >>"$log" 2>&1
`;

/** PowerShell do Windows. Lê os caminhos de variáveis de ambiente (TM_EXE, TM_ICON), sem interpolar. */
const WIN_SHORTCUTS = `
$exe = $env:TM_EXE; $icon = $env:TM_ICON
$dirs = @(
  [Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'),
  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\StartMenu')
)
$shell = New-Object -ComObject WScript.Shell; $n = 0
foreach ($d in $dirs) {
  if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
  Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $l = $shell.CreateShortcut($_.FullName)
      if ($l.TargetPath -and ($l.TargetPath -ieq $exe)) {
        if ($icon) { $l.IconLocation = "$icon,0" } else { $l.IconLocation = "$exe,0" }
        $l.Save(); $n++
      }
    } catch { }
  }
}
try { Start-Process -FilePath 'ie4uinit.exe' -ArgumentList '-show' -WindowStyle Hidden } catch { }
Write-Output $n
`;

function createIconManager({ electron, files, log = () => {}, platform = process.platform, execPath = process.execPath, spawn = cp.spawn }) {
  const { app, nativeImage } = electron;
  const BaseWindow = electron.BaseWindow || electron.BrowserWindow;
  const bundle = platform === "darwin" ? macBundleOf(execPath) : null;
  const bundleIcns = bundle ? path.join(bundle, "Contents", "Resources", "icon.icns") : null;
  let reopenAfterQuit = false;
  let helperSpawned = false;
  let themeAppliedLive = false;

  function windows() {
    try {
      return BaseWindow && typeof BaseWindow.getAllWindows === "function" ? BaseWindow.getAllWindows() : [];
    } catch {
      return [];
    }
  }

  function applyLive(image) {
    if (platform === "darwin") {
      if (app.dock && typeof app.dock.setIcon === "function") app.dock.setIcon(image);
      return;
    }
    for (const win of windows()) {
      try {
        if (!win.isDestroyed || !win.isDestroyed()) win.setIcon(image);
      } catch (error) {
        log("setIcon falhou:", error);
      }
    }
  }

  const hasCustom = () => fs.existsSync(files.png);
  const hasDefault = () => Boolean(files.defaultPng && fs.existsSync(files.defaultPng));
  const activePng = () => (hasCustom() ? files.png : hasDefault() ? files.defaultPng : null);
  const activeIcns = () => (hasCustom() ? files.icns : files.defaultIcns && fs.existsSync(files.defaultIcns) ? files.defaultIcns : null);
  const activeIco = () => (hasCustom() ? files.ico : files.defaultIco && fs.existsSync(files.defaultIco) ? files.defaultIco : null);

  /** Estado do ícone original no disco. "aplicar" / "restaurar" = falta o ajudante rodar. */
  function originalState() {
    if (platform === "darwin") {
      if (!bundleIcns || !fs.existsSync(bundleIcns)) return "indisponivel";
      const backup = fs.existsSync(bundleIcns + ORIGINAL_SUFFIX);
      const icns = activeIcns();
      if (icns) return fileSha(bundleIcns) === fileSha(icns) ? "aplicado" : "aplicar";
      return backup ? "restaurar" : "original";
    }
    if (platform === "win32") return activeIco() ? "atalhos" : "original";
    return "indisponivel";
  }

  // ------------------------------------------------------------ geração dos arquivos
  function writeAtomic(file, buf) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, buf);
    fs.renameSync(`${file}.tmp`, file);
  }

  function renderSizes(image) {
    const out = new Map();
    for (const size of ALL_SIZES) out.set(size, image.resize({ width: size, height: size, quality: "best" }).toPNG());
    return out;
  }

  // ------------------------------------------------------------ Windows: atalhos
  function updateWindowsShortcuts(icoPath) {
    return new Promise((resolve) => {
      let out = "";
      try {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_SHORTCUTS], {
          env: { ...process.env, TM_EXE: execPath, TM_ICON: icoPath || "" },
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        child.stdout.on("data", (c) => (out += c));
        child.on("error", (error) => (log("atalhos:", error), resolve(0)));
        child.on("close", () => resolve(Number.parseInt(out.trim(), 10) || 0));
      } catch (error) {
        log("atalhos:", error);
        resolve(0);
      }
    });
  }

  // ------------------------------------------------------------ macOS: ajudante na saída
  function spawnMacHelper() {
    if (helperSpawned || platform !== "darwin" || !bundle) return false;
    const state = originalState();
    if (state !== "aplicar" && state !== "restaurar") return false;
    const icns = state === "aplicar" ? activeIcns() : "";
    if (state === "aplicar" && !icns) return false;
    helperSpawned = true;
    try {
      const child = spawn(
        "/bin/sh",
        ["-c", MAC_HELPER, "trivomod-icon", String(process.pid), bundle, icns, files.log, reopenAfterQuit ? "1" : "0"],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      log(`ajudante do ícone (${state}) aguardando o Trivo fechar`);
      return true;
    } catch (error) {
      log("ajudante do ícone falhou:", error);
      return false;
    }
  }

  // ------------------------------------------------------------ API
  /** Na abertura: reaplica no app aberto (personalizado vence o padrão) e garante os atalhos no Windows. */
  function reapply() {
    const png = activePng();
    if (!png) return false;
    const image = nativeImage.createFromPath(png);
    if (!image || image.isEmpty()) return false;
    applyLive(image);
    if (!hasCustom()) themeAppliedLive = true;
    const ico = activeIco();
    if (platform === "win32" && ico && fs.existsSync(ico)) updateWindowsShortcuts(ico);
    return true;
  }

  async function set(dataUrl) {
    const buf = decodePngDataUrl(dataUrl);
    const image = nativeImage.createFromBuffer(buf);
    if (!image || image.isEmpty()) throw new Error("o Electron não conseguiu ler a imagem");
    const sizes = renderSizes(image);
    writeAtomic(files.icns, buildIcns(sizes));
    writeAtomic(files.ico, buildIco(sizes));
    writeAtomic(files.png, buf);
    themeAppliedLive = false;
    applyLive(image);
    const shortcuts = platform === "win32" ? await updateWindowsShortcuts(files.ico) : null;
    return { state: originalState(), shortcuts };
  }

  /**
   * Atualiza o ícone padrão temático (Arara Pirata).
   * REGRA DE PRECEDÊNCIA: se o usuário definiu um ícone personalizado (<dados>/icon.png),
   * este método não faz absolutamente nada — o ícone do usuário sempre vale.
   */
  async function setTheme(dataUrl) {
    if (hasCustom()) return { skipped: "custom", state: originalState(), shortcuts: null };
    if (!files.defaultPng || !files.defaultIcns || !files.defaultIco) {
      return { skipped: "unsupported", state: originalState(), shortcuts: null };
    }
    const buf = decodePngDataUrl(dataUrl);
    const unchanged =
      fileSha(files.defaultPng) === sha(buf) &&
      fs.existsSync(files.defaultIcns) &&
      fs.existsSync(files.defaultIco);
    const image = nativeImage.createFromBuffer(buf);
    if (!image || image.isEmpty()) throw new Error("o Electron não conseguiu ler a imagem");
    if (!unchanged) {
      const sizes = renderSizes(image);
      writeAtomic(files.defaultIcns, buildIcns(sizes));
      writeAtomic(files.defaultIco, buildIco(sizes));
      writeAtomic(files.defaultPng, buf);
    }
    if (!unchanged || !themeAppliedLive) {
      applyLive(image);
      themeAppliedLive = true;
    }
    const shortcuts = !unchanged && platform === "win32" ? await updateWindowsShortcuts(files.defaultIco) : null;
    return { unchanged, state: originalState(), shortcuts };
  }

  async function reset() {
    for (const f of [files.png, files.icns, files.ico]) fs.rmSync(f, { force: true });
    themeAppliedLive = false;
    let image = null;
    try {
      if (hasDefault()) {
        image = nativeImage.createFromPath(files.defaultPng);
        if (image && !image.isEmpty()) themeAppliedLive = true;
      } else if (platform === "darwin") {
        const original = bundleIcns && fs.existsSync(bundleIcns + ORIGINAL_SUFFIX) ? bundleIcns + ORIGINAL_SUFFIX : bundleIcns;
        if (original) image = nativeImage.createFromPath(original);
      } else if (typeof app.getFileIcon === "function") {
        image = await app.getFileIcon(execPath, { size: "large" });
      }
    } catch (error) {
      log("não achei o ícone original:", error);
    }
    if (image && !image.isEmpty()) applyLive(image);
    const ico = activeIco();
    const shortcuts = platform === "win32" ? await updateWindowsShortcuts(ico || "") : null;
    return { state: originalState(), shortcuts };
  }

  /** macOS: fecha o Trivo; o ajudante troca o ícone e reabre. */
  function restartToApply() {
    if (platform !== "darwin") return false;
    reopenAfterQuit = true;
    setImmediate(() => app.quit());
    return true;
  }

  // O ajudante sai na saída normal (will-quit) e também em app.exit() (que pula o will-quit).
  if (platform === "darwin") {
    app.on("will-quit", spawnMacHelper);
    process.on("exit", spawnMacHelper);
  }

  return { set, setTheme, reset, reapply, restartToApply, hasCustom, hasDefault, originalState, spawnMacHelper };
}

module.exports = { createIconManager, decodePngDataUrl, macBundleOf, MAC_HELPER, WIN_SHORTCUTS, ORIGINAL_SUFFIX, MAX_BYTES };
