// Janela nativa do instalador do TrivoMod no macOS (Cocoa + WKWebView).
// Abre apenas a URL local http://127.0.0.1:<porta>/ recebida no argumento, sem abrir o navegador.
// Uso: trivomod-window <url> [largura] [altura]
import Cocoa
import WebKit

final class InstallerWindow: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let targetURL: URL
    let allowedOrigin: String
    let width: CGFloat
    let height: CGFloat
    var window: NSWindow!
    var webView: WKWebView!

    init(url: URL, width: CGFloat, height: CGFloat) {
        self.targetURL = url
        self.allowedOrigin = "\(url.scheme ?? "http")://\(url.host ?? "127.0.0.1"):\(url.port ?? 80)"
        self.width = width
        self.height = height
        super.init()
    }

    func buildMenus() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "TrivoMod")
        appMenu.addItem(withTitle: "Sair do Instalador do TrivoMod", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Editar")
        editMenu.addItem(withTitle: "Desfazer", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Refazer", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Recortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Colar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Selecionar tudo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        let winItem = NSMenuItem()
        let winMenu = NSMenu(title: "Janela")
        winMenu.addItem(withTitle: "Fechar", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winMenu.addItem(withTitle: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winItem.submenu = winMenu
        mainMenu.addItem(winItem)

        NSApp.mainMenu = mainMenu
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenus()

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()

        let rect = NSRect(x: 0, y: 0, width: width, height: height)
        let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]
        window = NSWindow(contentRect: rect, styleMask: style, backing: .buffered, defer: false)
        window.title = "Instalador do TrivoMod"
        window.minSize = NSSize(width: 480, height: 520)
        window.isReleasedWhenClosed = false
        window.delegate = self

        webView = WKWebView(frame: rect, configuration: cfg)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView = webView

        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        webView.load(URLRequest(url: targetURL))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func isAllowed(_ url: URL?) -> Bool {
        guard let url = url, let scheme = url.scheme, let host = url.host else { return false }
        let origin = "\(scheme)://\(host):\(url.port ?? (scheme == "https" ? 443 : 80))"
        return origin == allowedOrigin
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(isAllowed(navigationAction.request.url) ? .allow : .cancel)
    }

    func webViewDidClose(_ webView: WKWebView) {
        window.close()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Instalador do TrivoMod"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancelar")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
guard let raw = args.first, let url = URL(string: raw),
      url.scheme == "http", url.host == "127.0.0.1", url.port != nil else {
    FileHandle.standardError.write("uso: trivomod-window http://127.0.0.1:<porta>/ [largura] [altura]\n".data(using: .utf8)!)
    exit(2)
}

let w = args.count > 1 ? (Double(args[1]) ?? 620) : 620
let h = args.count > 2 ? (Double(args[2]) ?? 700) : 700

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = InstallerWindow(url: url, width: CGFloat(w), height: CGFloat(h))
app.delegate = delegate
withExtendedLifetime(delegate) { app.run() }
