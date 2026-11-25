"use strict";
// Instalador gráfico do TrivoMod: um servidor HTTP local + uma página (installer/ui/index.html).
//
// Como o servidor controla a modificação de um app na sua máquina, ele só aceita pedidos que:
//   - chegam em 127.0.0.1 com o cabeçalho Host exato (barra DNS rebinding);
//   - trazem o token aleatório desta sessão (barra qualquer outra página aberta no navegador);
//   - vêm da própria origem, quando o navegador informa `Origin`.
// E fecha sozinho quando a página some.
//
// Erros voltam como { ok: false, code, error, hint, detail }: `error` e `hint` são textos curtos para
// a página (o que houve e o que fazer); `detail` é a mensagem técnica original, mostrada só em "Detalhes".

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const patch = require("./patch");
const win = require("./window");
const VERSION = require("../src/version");

const UI = path.join(__dirname, "ui", "index.html");
const LOGO = path.join(__dirname, "ui", "trivo-logo.webp");
const MAX_BODY = 4096;
// Navegadores espaçam os timers de abas em segundo plano (o Chrome chega a 1 por minuto), então a
// folga tem de passar de um minuto para o instalador não fechar sozinho com a aba ainda aberta.
const IDLE_MS = 90_000;
const PLATFORM = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "linux";

function userError(code, error, hint) {
  return Object.assign(new Error(error), { code, error, hint, friendly: true });
}

/** Traduz um erro do patch/sistema em { code, error, hint } curtos, sem jargão. */
function explain(e, platform = PLATFORM) {
  if (e && e.friendly) return { code: e.code, error: e.error, hint: e.hint };
  const msg = String((e && e.message) || e);
  const close = platform === "mac" ? "Feche o Trivo (Cmd+Q) e tente de novo." : platform === "win" ? "Feche o Trivo (inclusive pelo ícone perto do relógio) e tente de novo." : "Feche o Trivo e tente de novo.";
  if (/está aberto/i.test(msg)) return { code: "running", error: "O Trivo está aberto.", hint: close };
  if ((e && e.code === "EBUSY") || /EBUSY|resource busy/i.test(msg)) return { code: "busy", error: "Um arquivo do Trivo está em uso.", hint: close };
  if ((e && (e.code === "EACCES" || e.code === "EPERM")) || /EACCES|EPERM|Operation not permitted|permission denied/i.test(msg))
    return {
      code: "permission",
      error: "O sistema não deixou alterar o Trivo.",
      hint:
        platform === "mac"
          ? "Em Ajustes do Sistema › Privacidade e Segurança › Gerenciamento de Apps, permita o app que abriu o instalador (por exemplo, o Terminal) e tente de novo."
          : platform === "win"
            ? "Feche o Trivo e tente de novo. Se continuar, abra o instalador como administrador."
            : "Confira se você tem permissão de escrita na pasta do Trivo e tente de novo.",
    };
  if (/já está modificado, mas não há backup/i.test(msg))
    return { code: "foreign", error: "Este Trivo já foi alterado por outra ferramenta.", hint: "Baixe e instale o Trivo de novo pelo site oficial e depois tente outra vez." };
  if (/Sem backup/i.test(msg)) return { code: "no-backup", error: "Não há uma cópia do Trivo original para restaurar.", hint: "Baixe e instale o Trivo de novo pelo site oficial." };
  if (/codesign/i.test(msg)) return { code: "sign", error: "O macOS recusou a alteração do Trivo.", hint: "Baixe e instale o Trivo de novo pelo site oficial e tente outra vez." };
  if (/Não achei o Trivo|não é o Trivo|não parece ser o Trivo/i.test(msg))
    return { code: "not-trivo", error: "Não encontrei o Trivo nesse local.", hint: platform === "mac" ? "Escolha o Trivo.app (normalmente em Aplicativos)." : platform === "win" ? "Escolha a pasta onde fica o Trivo.exe." : "Escolha a pasta onde o Trivo está instalado." };
  return { code: "unknown", error: "Algo deu errado.", hint: "Tente de novo. Se continuar, copie os detalhes abaixo e relate o problema." };
}

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    cp.spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    /* o endereço também é impresso no terminal */
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function start({ open = true, browser = false, port = 0, idleMs = IDLE_MS } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  const extra = new Set(); // caminhos que o usuário adicionou nesta sessão
  let lastPing = 0;
  let pinged = false;
  let winHandle = null;
  let closing = false;

  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", ...headers });
      res.end(body);
    };
    const json = (status, value) => send(status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });

    if (req.headers.host !== origin.slice("http://".length)) return send(421, "Host inválido");

    const url = new URL(req.url, origin);
    if (req.method === "GET" && url.pathname === "/") {
      const nonce = crypto.randomBytes(16).toString("base64");
      const html = fs
        .readFileSync(UI, "utf8")
        .replaceAll("__NONCE__", nonce)
        .replaceAll("__TOKEN__", token)
        .replaceAll("__VERSION__", VERSION)
        .replaceAll("__PLATFORM__", PLATFORM);
      return send(200, html, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }

    if (req.method === "GET" && url.pathname === "/trivo-logo.webp") {
      return send(200, fs.readFileSync(LOGO), { "Content-Type": "image/webp", "Cache-Control": "max-age=3600" });
    }

    if (!url.pathname.startsWith("/api/")) return send(404, "não encontrado");
    if (req.method !== "POST") return send(405, "use POST");
    if (!safeEqual(req.headers["x-trivomod-token"] || "", token)) return json(403, { error: "token inválido" });
    if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: "origem recusada" });

    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        return json(400, { error: "JSON inválido" });
      }
      try {
        json(200, handle(url.pathname, body));
      } catch (error) {
        json(200, { ok: false, ...explain(error), detail: String(error.message || error) });
      }
    });
  });

  function known(app) {
    return patch.discover([...extra]).installs.some((i) => i.app === app);
  }

  function handle(route, body) {
    switch (route) {
      case "/api/ping":
        lastPing = Date.now();
        pinged = true;
        return { ok: true };
      case "/api/installs":
        return { ok: true, version: VERSION, platform: PLATFORM, dataDir: patch.dataDir(), ...patch.discover([...extra]) };
      case "/api/add": {
        if (typeof body.app !== "string" || !body.app.trim()) throw userError("empty", "Informe o local do Trivo.", "Cole o caminho do app no campo.");
        const t = patch.resolveTarget(body.app.trim());
        const found = patch.discover([t.root]).installs.find((i) => i.app === t.root);
        if (!found) throw new Error("não parece ser o Trivo");
        extra.add(t.root);
        return { ok: true, app: t.root };
      }
      case "/api/install":
      case "/api/uninstall": {
        if (typeof body.app !== "string" || !known(body.app))
          throw userError("unknown-install", "Essa instalação não está mais na lista.", "A lista foi atualizada. Escolha o Trivo de novo.");
        if (route === "/api/install") {
          const r = patch.install({ app: body.app });
          return { ok: true, message: "TrivoMod instalado.", detail: `Hash do app.asar: ${r.hash}` };
        }
        patch.uninstall({ app: body.app });
        return { ok: true, message: "TrivoMod desinstalado. O Trivo voltou ao original.", detail: "app.asar original restaurado." };
      }
      case "/api/open-data":
        fs.mkdirSync(patch.dataDir(), { recursive: true }); // antes da 1ª instalação a pasta ainda não existe
        cp.spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open", [patch.dataDir()], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
        return { ok: true };
      case "/api/quit":
        setTimeout(() => close(), 50);
        return { ok: true };
      default:
        throw userError("route", "Pedido desconhecido.", "Recarregue a página.");
    }
  }

  let idleTimer;
  function close() {
    if (closing) return;
    closing = true;
    clearInterval(idleTimer);
    if (winHandle) {
      const h = winHandle;
      winHandle = null;
      h.close();
    }
    server.close();
    server.closeAllConnections?.();
    if (require.main === module || process.env.TRIVOMOD_GUI_EXIT === "1") process.exit(0);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  idleTimer = setInterval(() => {
    if (pinged && Date.now() - lastPing > idleMs) close();
  }, 2000);
  idleTimer.unref?.();

  const url = `http://127.0.0.1:${server.address().port}/`;
  let windowKind = null;
  if (open) {
    if (!browser) {
      try {
        winHandle = win.openWindow(url, { onClose: () => close() });
        windowKind = winHandle ? winHandle.kind : null;
      } catch {
        winHandle = null;
      }
    }
    if (!winHandle) openInBrowser(url);
  }
  return { url, token, server, close, windowKind };
}

module.exports = { start, explain };
