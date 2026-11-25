"use strict";
// Windows: o Electron guarda o hash de integridade do app.asar num recurso do executável
// (tipo "INTEGRITY", nome "ELECTRONASAR"), em JSON:
//   [{"file":"resources\\app.asar","alg":"SHA256","value":"<64 hex>"}]
// No Trivo 1.0.8 esse JSON aparece uma única vez no Trivo.exe. Como o hash tem tamanho fixo,
// trocar os 64 caracteres no lugar mantém o PE intacto (mesmo tamanho de recurso, mesmos offsets).
// O Trivo.exe não é assinado (sem Authenticode) e o checksum do cabeçalho PE é 0, então não há
// assinatura nem checksum para refazer.

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const os = require("node:os");

const PREFIX = Buffer.from('"file":"resources\\\\app.asar","alg":"SHA256","value":"', "latin1");
const HEX = /^[0-9a-f]{64}$/;

/** Acha o hash gravado no .exe. Devolve { offset, hash }. */
function findIntegrity(buf) {
  const first = buf.indexOf(PREFIX);
  if (first < 0) throw new Error("Não achei o recurso de integridade do app.asar no executável.");
  if (buf.indexOf(PREFIX, first + 1) >= 0) throw new Error("O recurso de integridade aparece mais de uma vez; versão do Trivo não suportada.");
  const offset = first + PREFIX.length;
  const hash = buf.subarray(offset, offset + 64).toString("latin1");
  if (!HEX.test(hash) || buf[offset + 64] !== 0x22 /* " */) throw new Error("Recurso de integridade em formato inesperado.");
  return { offset, hash };
}

function readIntegrity(exePath) {
  return findIntegrity(fs.readFileSync(exePath));
}

/** Troca o hash no lugar: só 64 bytes do arquivo mudam. */
function writeIntegrity(exePath, newHash) {
  if (!HEX.test(newHash)) throw new Error("hash inválido");
  const { offset, hash } = readIntegrity(exePath);
  if (hash === newHash) return false;
  const fd = fs.openSync(exePath, "r+");
  try {
    fs.writeSync(fd, Buffer.from(newHash, "latin1"), 0, 64, offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (readIntegrity(exePath).hash !== newHash) throw new Error("A escrita do hash no executável não conferiu.");
  return true;
}

// ---------------------------------------------------------------- descoberta e processo (só no Windows)

/** Pastas padrão do instalador NSIS do electron-builder, mais o que o registro de desinstalação disser. */
function candidateDirs() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const dirs = [
    path.join(local, "Programs", "Trivo"),
    path.join(local, "Programs", "trivo"),
    path.join(local, "Programs", "trivo-desktop"),
  ];
  for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) if (pf) dirs.push(path.join(pf, "Trivo"));
  if (process.platform === "win32") {
    for (const hive of ["HKCU", "HKLM"]) {
      try {
        const out = cp.execFileSync(
          "reg",
          ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, "/s", "/f", "InstallLocation", "/v", "InstallLocation"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        );
        for (const m of out.matchAll(/InstallLocation\s+REG_\w+\s+(.+)/g)) {
          const dir = m[1].trim().replace(/^"|"$/g, "");
          if (fs.existsSync(path.join(dir, "Trivo.exe"))) dirs.push(dir);
        }
      } catch {
        /* sem chave ou sem reg.exe */
      }
    }
  }
  return dirs;
}

/** O Trivo desta pasta está aberto? Compara o caminho do executável de cada processo Trivo. */
function isRunning(root) {
  if (process.platform !== "win32") return false;
  const exe = path.join(root, "Trivo.exe").toLowerCase();
  try {
    const out = cp.execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-Process -Name Trivo -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    return out.split(/\r?\n/).some((p) => p.trim().toLowerCase() === exe);
  } catch {
    // Sem PowerShell: qualquer Trivo.exe aberto conta, por precaução.
    try {
      const out = cp.execFileSync("tasklist", ["/FI", "IMAGENAME eq Trivo.exe", "/NH"], { encoding: "utf8", windowsHide: true });
      return /Trivo\.exe/i.test(out);
    } catch {
      return false;
    }
  }
}

module.exports = { findIntegrity, readIntegrity, writeIntegrity, candidateDirs, isRunning };
