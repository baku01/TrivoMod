// Ferramenta de desenvolvimento (macOS): abre uma página (arquivo ou http://127.0.0.1…) num WKWebView sem janela.
//   webkit-probe <arquivo.html|url>                    imprime o texto de #probe quando ele aparecer
//   webkit-probe <alvo> [--size 1280x800] --eval '<js>' [--snapshot a.png]   espera 1,5 s, executa o JS (async), imprime o resultado
//                                                          e salva um PNG da página
// Erros e console.* da página vão para o stderr.
//   swiftc -module-cache-path /tmp/swiftmod test/webkit-probe.swift -o /tmp/webkit-probe
import Cocoa
import WebKit

final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let web: WKWebView
    let evalJS: String?
    let snapshotPath: String?
    var tries = 0

    init(target: String, evalJS: String?, snapshotPath: String?, width: CGFloat, height: CGFloat) {
        self.evalJS = evalJS
        self.snapshotPath = snapshotPath
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent() // nada de gravar em ~/Library
        let hook = """
        (() => {
          const send = (kind, args) => { try { window.webkit.messageHandlers.log.postMessage(kind + ": " + args.map(String).join(" ")); } catch (e) {} };
          for (const k of ["log", "warn", "error"]) { const o = console[k]; console[k] = (...a) => { send(k, a); o.apply(console, a); }; }
          window.addEventListener("error", (e) => send("uncaught", [e.message, "@" + e.lineno + ":" + e.colno]));
          window.addEventListener("unhandledrejection", (e) => send("rejection", [e.reason]));
        })();
        """
        cfg.userContentController.addUserScript(WKUserScript(source: hook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: cfg)
        super.init()
        cfg.userContentController.add(self, name: "log")
        web.navigationDelegate = self
        if target.hasPrefix("http") {
            web.load(URLRequest(url: URL(string: target)!))
        } else {
            let file = URL(fileURLWithPath: target)
            web.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
        }
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        FileHandle.standardError.write("[page] \(m.body)\n".data(using: .utf8)!)
    }

    func finish(_ output: String?) {
        guard let path = snapshotPath else {
            if let o = output { print(o) }
            exit(0)
        }
        web.takeSnapshot(with: nil) { image, error in
            if let image = image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
            } else {
                FileHandle.standardError.write("snapshot falhou: \(String(describing: error))\n".data(using: .utf8)!)
            }
            if let o = output { print(o) }
            exit(0)
        }
    }

    func runEval() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            guard let js = self.evalJS else { return self.finish(nil) }
            self.web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
                var out: String? = nil
                switch result {
                case .success(let v): out = "\(v)"
                case .failure(let e): FileHandle.standardError.write("eval falhou: \(e)\n".data(using: .utf8)!)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.finish(out) }
            }
        }
    }

    func poll() {
        tries += 1
        web.evaluateJavaScript("document.getElementById('probe') ? document.getElementById('probe').textContent : null") { result, _ in
            if let text = result as? String { print(text); exit(0) }
            if self.tries > 40 {
                FileHandle.standardError.write("timeout: #probe não apareceu\n".data(using: .utf8)!)
                exit(1)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.poll() }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if evalJS != nil || snapshotPath != nil { runEval() } else { poll() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("falha de navegação: \(error)\n".data(using: .utf8)!)
        exit(3)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("falha de navegação: \(error)\n".data(using: .utf8)!)
        exit(3)
    }
}

var args = Array(CommandLine.arguments.dropFirst())
guard let target = args.first else {
    FileHandle.standardError.write("uso: webkit-probe <arquivo|url> [--eval js] [--snapshot png]\n".data(using: .utf8)!)
    exit(2)
}
func option(_ name: String) -> String? {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return nil
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let size = (option("--size") ?? "760x900").split(separator: "x").compactMap { Double($0) }
let probe = Probe(target: target, evalJS: option("--eval"), snapshotPath: option("--snapshot"),
                  width: CGFloat(size.count == 2 ? size[0] : 760), height: CGFloat(size.count == 2 ? size[1] : 900))
withExtendedLifetime(probe) { app.run() }
