"use strict";
// Temas online (como os themeLinks do Vencord): o processo principal baixa o CSS e guarda em cache;
// a página recebe só o texto, então a CSP do Trivo continua intacta.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { parseMeta } = require("./library");

const TIMEOUT = 10_000;
const MAX_CSS = 1024 * 1024;
const MAX_REDIRECTS = 5;

const hashOf = (url) => crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);

function fallbackName(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    let seg = "";
    try {
      seg = last ? decodeURIComponent(last) : "";
    } catch {
      seg = last || "";
    }
    return seg ? `${u.hostname}/${seg}` : u.hostname;
  } catch {
    return url;
  }
}

async function readLimited(res, limit) {
  const declared = Number(res.headers && res.headers.get && res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("arquivo maior que 1 MB");
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        reader.cancel().catch(() => {});
        throw new Error("arquivo maior que 1 MB");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) throw new Error("arquivo maior que 1 MB");
  return buf.toString("utf8");
}

/** Baixa um CSS por https, seguindo redirecionamentos só para https. */
async function download(fetchImpl, url, { timeout = TIMEOUT, limit = MAX_CSS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (new URL(current).protocol !== "https:") throw new Error("só https é permitido");
      let res;
      try {
        res = await fetchImpl(current, { redirect: "manual", signal: controller.signal, headers: { accept: "text/css,*/*;q=0.1" } });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("tempo esgotado (10 s)");
        throw error;
      }
      if (res.type === "opaqueredirect") throw new Error("redirecionamento não suportado");
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`HTTP ${res.status} sem destino`);
        current = new URL(location, current).href;
        continue;
      }
      if (res.url && new URL(res.url).protocol !== "https:") throw new Error("só https é permitido");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      try {
        return await readLimited(res, limit);
      } catch (error) {
        if (controller.signal.aborted) throw new Error("tempo esgotado (10 s)");
        throw error;
      }
    }
    throw new Error("redirecionamentos demais");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * links: () => string[] (as URLs atuais dos ajustes). fetch: net.fetch do Electron.
 * list(): temas do cache para as URLs atuais. refresh(): baixa tudo, limpa órfãos.
 */
function createThemeLinks({ fetch: fetchImpl, cacheDir, links, log = () => {}, timeout = TIMEOUT }) {
  const fileOf = (url) => path.join(cacheDir, `${hashOf(url)}.css`);

  function list() {
    const out = [];
    const seen = new Set();
    for (const url of links()) {
      const hash = hashOf(url);
      if (seen.has(hash)) continue;
      seen.add(hash);
      let css;
      try {
        css = fs.readFileSync(fileOf(url), "utf8");
      } catch {
        continue; // ainda não baixado (ou falhou)
      }
      const meta = parseMeta(css);
      out.push({
        id: `link:${hash}`,
        name: meta.name || fallbackName(url),
        author: meta.author || "",
        description: meta.description || "",
        css,
        builtin: false,
        link: true,
        url,
      });
    }
    return out;
  }

  async function refresh() {
    const urls = [...new Set(links())];
    fs.mkdirSync(cacheDir, { recursive: true });
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          if (typeof fetchImpl !== "function") throw new Error("rede indisponível");
          const css = await download(fetchImpl, url, { timeout });
          const file = fileOf(url);
          fs.writeFileSync(`${file}.tmp`, css);
          fs.renameSync(`${file}.tmp`, file);
          return { url, ok: true };
        } catch (error) {
          log(`tema online falhou (${url}):`, (error && error.message) || error);
          return { url, ok: false, error: String((error && error.message) || error) };
        }
      }),
    );
    const keep = new Set(urls.map((u) => `${hashOf(u)}.css`));
    try {
      for (const name of fs.readdirSync(cacheDir)) if (!keep.has(name)) fs.rmSync(path.join(cacheDir, name), { force: true });
    } catch {
      /* nada a limpar */
    }
    return results;
  }

  return { list, refresh };
}

module.exports = { createThemeLinks, download, hashOf, fallbackName, MAX_CSS, TIMEOUT };
