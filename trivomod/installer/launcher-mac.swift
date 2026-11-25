import Cocoa
import Foundation

// Launcher nativo do TrivoMod Installer.app (macOS universal arm64 + x86_64).
// Roda `node Resources/app/bin/trivomod.js gui` usando o Node.js embutido da arquitetura atual
// (sem exigir Node instalado e sem abrir o Terminal).

func showError(_ message: String) {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let alert = NSAlert()
  alert.messageText = "TrivoMod Installer"
  alert.informativeText = message
  alert.alertStyle = .critical
  alert.addButton(withTitle: "OK")
  alert.runModal()
}

func currentArch() -> String {
  #if arch(arm64)
    return "arm64"
  #else
    return "x86_64"
  #endif
}

func findNode(resourcesDir: String) -> String? {
  let fm = FileManager.default
  let candidates = [
    "\(resourcesDir)/node-\(currentArch())",
    "\(resourcesDir)/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ]
  for path in candidates {
    if fm.isExecutableFile(atPath: path) { return path }
  }
  return nil
}

guard let resourcesDir = Bundle.main.resourcePath else {
  showError("Não foi possível localizar os recursos internos do instalador.")
  exit(1)
}

let script = "\(resourcesDir)/app/bin/trivomod.js"
guard FileManager.default.fileExists(atPath: script) else {
  showError("Arquivos do TrivoMod não encontrados dentro do aplicativo.")
  exit(1)
}

guard let nodePath = findNode(resourcesDir: resourcesDir) else {
  showError("Runtime Node.js não encontrado. Baixe o instalador oficial novamente.")
  exit(1)
}

let proc = Process()
proc.executableURL = URL(fileURLWithPath: nodePath)
proc.arguments = [script, "gui"]
proc.currentDirectoryURL = URL(fileURLWithPath: "\(resourcesDir)/app")

var env = ProcessInfo.processInfo.environment
let extraPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
env["PATH"] = (env["PATH"] ?? "").isEmpty ? extraPath : "\(env["PATH"]!):\(extraPath)"
proc.environment = env

let errPipe = Pipe()
proc.standardError = errPipe

do {
  try proc.run()
  proc.waitUntilExit()
  if proc.terminationStatus != 0 {
    let data = errPipe.fileHandleForReading.readDataToEndOfFile()
    let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    showError(text.isEmpty ? "O instalador encerrou com erro (código \(proc.terminationStatus))." : text)
    exit(proc.terminationStatus)
  }
} catch {
  showError("Não foi possível iniciar o instalador: \(error.localizedDescription)")
  exit(1)
}
