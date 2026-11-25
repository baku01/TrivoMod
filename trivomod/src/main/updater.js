"use strict";
// Atualização automática do runtime do mod (`<dados>/dist`).
//
// Fonte: a última release do GitHub (não a ponta do main). Cada push no main que mexe no mod gera
// uma release, mas só depois de a suíte passar no macOS, Windows e Linux. Então seguir as releases
// é seguir os commits, sem receber o que ainda quebra os testes.
//
// Ciclo:
//   1. check(): consulta a release mais nova. Se for maior que a instalada, baixa
//      trivomod-runtime-vX.json.gz e confere o SHA-256 contra o SHA256SUMS.txt da mesma release.
//      Depois valida o pacote (caminhos, versão, JS que compila) e carrega os módulos do processo
//      principal numa pasta à parte para ver se sobem. Só então grava em `<dados>/dist.next`.
//   2. applyPending(): quando o Trivo fecha, troca dist -> dist.prev e dist.next -> dist. Não troca
//      com o app aberto: a página relê renderer/index.js do disco a cada carga, e misturar a página
//      nova com o processo principal velho é pedir problema.
//   3. onStartup()/confirm(): a versão nova precisa chegar ao "boot-ok" da página. Se abrir
//      MAX_UNCONFIRMED vezes sem chegar lá, volta para dist.prev sozinha, reinicia e não tenta mais
//      essa versão.
//
// Limite conhecido: se o módulo principal novo lançar erro ANTES de chamar onStartup (não deveria,
// pois o passo 1 carrega esses módulos antes de aceitar), o loader do Trivo abre o app sem o mod e
// não há quem volte a versão. Aí resolve o instalador ("Reparar").
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const bundle = require("./bundle");

const REPO = "baku01/TrivoMod";
const MAX_UNCONFIRMED = 3; // na 3ª abertura sem boot-ok, volta
const STATE_FILE = "update.json";
const TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD = 8 * 1024 * 1024;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
function compare(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) throw new Error(`versão inválida: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

function paths(dataDir) {
  return {
    dist: path.join(dataDir, "dist"),
    next: path.join(dataDir, "dist.next"),
    tmp: path.join(dataDir, "dist.next.tmp"),
    prev: path.join(dataDir, "dist.prev"),
    bad: path.join(dataDir, "dist.bad"),
    state: path.join(dataDir, STATE_FILE),
  };
}

function emptyState() {
  return { staged: null, pending: null, blocked: [], lastCheck: null, lastError: null };
}

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const st = emptyState();
    if (typeof raw.staged === "string" && SEMVER.test(raw.staged)) st.staged = raw.staged;
    if (raw.pending && typeof raw.pending.version === "string" && SEMVER.test(raw.pending.version)) {
      st.pending = {
        version: raw.pending.version,
        from: typeof raw.pending.from === "string" ? raw.pending.from : null,
        boots: Number.isInteger(raw.pending.boots) && raw.pending.boots >= 0 ? raw.pending.boots : 0,
      };
    }
    if (Array.isArray(raw.blocked)) st.blocked = raw.blocked.filter((v) => typeof v === "string" && SEMVER.test(v)).slice(-20);
    if (typeof raw.lastCheck === "string") st.lastCheck = raw.lastCheck;
    if (typeof raw.lastError === "string") st.lastError = raw.lastError.slice(0, 300);
    return st;
  } catch {
    return emptyState();
  }
}

function saveState(file, st) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* sem disco: perde o estado, o pior caso é baixar de novo */
  }
}

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

function distVersion(dir) {
  return bundle.versionOf(fs.readFileSync(path.join(dir, "version.js"), "utf8"));
}

/**
 * Carrega os módulos do processo principal da pasta nova e descarta em seguida. Esses módulos só
 * declaram funções no topo (quem mexe no Electron é start()), então carregar não liga nada; pega
 * erro de sintaxe, require quebrado ou export faltando antes de a versão virar a oficial.
 */
function testLoad(dir) {
  const mainDir = path.join(dir, "main");
  const before = new Set(Object.keys(require.cache));
  try {
    for (const name of fs.readdirSync(mainDir)) if (name.endsWith(".js")) require(path.join(mainDir, name));
    const entry = require(path.join(mainDir, "index.js"));
    if (typeof entry.start !== "function") throw new Error("main/index.js sem start()");
  } finally {
    for (const key of Object.keys(require.cache)) if (!before.has(key)) delete require.cache[key];
  }
}

/** Limpa staging e pendências: usado pelo instalador quando grava um dist novo à mão. */
function resetForManualInstall(dataDir) {
  const p = paths(dataDir);
  rm(p.next);
  rm(p.tmp);
  const st = loadState(p.state);
  saveState(p.state, { ...emptyState(), blocked: st.blocked });
}

function createUpdater({ dataDir, currentVersion, fetch: fetchImpl, log = () => {}, repo = REPO, now = () => new Date() }) {
  const p = paths(dataDir);
  const ua = `TrivoMod/${currentVersion} (+https://github.com/${repo})`;

  const request = async (url, accept) => {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": ua, Accept: accept },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return res;
  };
  const getBuffer = async (url, accept = "application/octet-stream") => {
    const res = await request(url, accept);
    const len = Number(res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : NaN);
    if (Number.isFinite(len) && len > MAX_DOWNLOAD) throw new Error("download grande demais");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD) throw new Error("download grande demais");
    return buf;
  };
  const allowedAsset = (url) => typeof url === "string" && url.startsWith(`https://github.com/${repo}/releases/download/`);

  let checking = null;

  /** Primeira coisa da abertura. Devolve { rolledBack, version } quando voltou para a anterior. */
  function onStartup({ countBoot = true } = {}) {
    const st = loadState(p.state);
    if (!st.pending || !countBoot) return { rolledBack: false };
    st.pending.boots += 1;
    if (st.pending.boots < MAX_UNCONFIRMED || !fs.existsSync(p.prev)) {
      saveState(p.state, st);
      return { rolledBack: false };
    }
    const bad = st.pending.version;
    rm(p.bad);
    fs.renameSync(p.dist, p.bad);
    try {
      fs.renameSync(p.prev, p.dist);
    } catch (error) {
      fs.renameSync(p.bad, p.dist); // não deixa o app sem dist nenhum
      throw error;
    }
    st.blocked = [...st.blocked.filter((v) => v !== bad), bad].slice(-20);
    st.pending = null;
    st.staged = null;
    st.lastError = `v${bad} não abriu ${MAX_UNCONFIRMED - 1} vezes seguidas; voltou para a anterior`;
    rm(p.next);
    saveState(p.state, st);
    log(`atualização v${bad} desfeita: não chegou ao boot-ok`);
    return { rolledBack: true, version: bad };
  }

  /** boot-ok da página: a versão instalada funciona. */
  function confirm() {
    const st = loadState(p.state);
    if (!st.pending) return false;
    log(`atualização v${st.pending.version} confirmada`);
    st.pending = null;
    saveState(p.state, st);
    return true;
  }

  async function runCheck() {
    const st = loadState(p.state);
    st.lastCheck = now().toISOString();
    try {
      const rel = JSON.parse((await getBuffer(`https://api.github.com/repos/${repo}/releases/latest`, "application/vnd.github+json")).toString("utf8"));
      const version = String(rel && rel.tag_name || "").replace(/^v/, "");
      if (!SEMVER.test(version)) throw new Error(`tag inesperada: ${rel && rel.tag_name}`);
      if (compare(version, currentVersion) <= 0) {
        st.lastError = null;
        saveState(p.state, st);
        return { state: "em-dia", version };
      }
      if (st.blocked.includes(version)) {
        saveState(p.state, st);
        return { state: "bloqueada", version };
      }
      if (st.staged === version && fs.existsSync(p.next)) {
        saveState(p.state, st);
        return { state: "pronta", version };
      }
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const name = bundle.assetName(version);
      const asset = assets.find((a) => a && a.name === name);
      const sums = assets.find((a) => a && a.name === "SHA256SUMS.txt");
      if (!asset || !sums) {
        st.lastError = null;
        saveState(p.state, st);
        return { state: "sem-pacote", version }; // release antiga, sem runtime publicado
      }
      if (!allowedAsset(asset.browser_download_url) || !allowedAsset(sums.browser_download_url)) {
        throw new Error("endereço de download fora do repositório");
      }
      const [buf, sumsBuf] = await Promise.all([getBuffer(asset.browser_download_url), getBuffer(sums.browser_download_url)]);
      const line = sumsBuf
        .toString("utf8")
        .split(/\r?\n/)
        .map((l) => /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(l.trim()))
        .find((m) => m && m[2] === name);
      if (!line) throw new Error(`${name} não está no SHA256SUMS.txt`);
      const got = crypto.createHash("sha256").update(buf).digest("hex");
      if (got !== line[1].toLowerCase()) throw new Error(`SHA-256 de ${name} não confere`);

      const files = bundle.validate(bundle.parse(buf), version);
      rm(p.tmp);
      bundle.writeTo(p.tmp, files);
      try {
        testLoad(p.tmp);
      } catch (error) {
        rm(p.tmp);
        throw new Error(`v${version} não carrega: ${error.message}`);
      }
      rm(p.next);
      fs.renameSync(p.tmp, p.next);
      st.staged = version;
      st.lastError = null;
      saveState(p.state, st);
      log(`atualização v${version} baixada; entra quando o Trivo fechar`);
      return { state: "pronta", version, nova: true };
    } catch (error) {
      st.lastError = String((error && error.message) || error).slice(0, 300);
      saveState(p.state, st);
      log("verificar atualização falhou:", error);
      return { state: "erro", error: st.lastError };
    }
  }

  /** Uma verificação por vez; chamadas durante uma verificação esperam a mesma. */
  function check() {
    if (!checking) checking = runCheck().finally(() => (checking = null));
    return checking;
  }

  /** Ao fechar o Trivo. Síncrono de propósito: o processo está saindo. */
  function applyPending() {
    if (!fs.existsSync(p.next)) return { applied: false };
    const st = loadState(p.state);
    let nextVersion;
    let current;
    try {
      nextVersion = distVersion(p.next);
      current = distVersion(p.dist);
    } catch (error) {
      rm(p.next);
      log("atualização baixada ilegível; descartada:", error);
      return { applied: false };
    }
    // O instalador pode ter gravado uma versão igual ou mais nova enquanto isto esperava.
    if (compare(nextVersion, current) <= 0 || st.blocked.includes(nextVersion)) {
      rm(p.next);
      st.staged = null;
      saveState(p.state, st);
      return { applied: false };
    }
    rm(p.prev);
    fs.renameSync(p.dist, p.prev);
    try {
      fs.renameSync(p.next, p.dist);
    } catch (error) {
      fs.renameSync(p.prev, p.dist);
      log("aplicar atualização falhou; mantida a versão atual:", error);
      return { applied: false, error: error.message };
    }
    st.staged = null;
    st.pending = { version: nextVersion, from: current, boots: 0 };
    saveState(p.state, st);
    log(`atualização v${nextVersion} aplicada (era v${current})`);
    return { applied: true, version: nextVersion, from: current };
  }

  function status() {
    const st = loadState(p.state);
    return {
      current: currentVersion,
      staged: st.staged && fs.existsSync(p.next) ? st.staged : null,
      lastCheck: st.lastCheck,
      lastError: st.lastError,
      blocked: st.blocked,
    };
  }

  return { onStartup, confirm, check, applyPending, status, paths: p };
}

module.exports = { createUpdater, resetForManualInstall, compare, testLoad, MAX_UNCONFIRMED, REPO, STATE_FILE };
