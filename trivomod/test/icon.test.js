"use strict";
// Ícone original: arquivos .icns/.ico, ajudante do macOS e atalhos do Windows.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { EventEmitter } = require("node:events");
const iconfiles = require("../src/iconfiles");
const { createIconManager, MAC_HELPER, macBundleOf, ORIGINAL_SUFFIX } = require("../src/main/icon");

const PNG = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
const sizes = () => new Map(iconfiles.ALL_SIZES.map((s) => [s, PNG(`p${s}`)]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "trivomod-icon-"));

test("icns: blocos no formato da Apple, com os PNGs nos tamanhos certos", () => {
  const buf = iconfiles.buildIcns(sizes());
  const blocks = iconfiles.parseIcns(buf);
  assert.deepEqual(blocks.map((b) => b.type), iconfiles.ICNS_TYPES.map(([t]) => t));
  for (const [type, size] of iconfiles.ICNS_TYPES) assert.equal(blocks.find((b) => b.type === type).data.toString().slice(8), `p${size}`);
  assert.throws(() => iconfiles.buildIcns(new Map([[16, PNG("x")]])), /falta o PNG/);
});

test("ico: cabeçalho, entradas e deslocamentos corretos (256 vira 0)", () => {
  const buf = iconfiles.buildIco(sizes());
  assert.equal(buf.readUInt16LE(2), 1);
  const n = buf.readUInt16LE(4);
  assert.equal(n, iconfiles.ICO_SIZES.length);
  iconfiles.ICO_SIZES.forEach((size, i) => {
    const e = 6 + 16 * i;
    assert.equal(buf.readUInt8(e), size >= 256 ? 0 : size);
    const len = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    assert.equal(buf.subarray(off + 8, off + len).toString(), `p${size}`);
  });
});

test("ícone real (macOS): o sips lê o .icns gerado", { skip: process.platform !== "darwin" }, () => {
  const dir = tmp();
  const pngs = new Map();
  for (const s of iconfiles.ALL_SIZES) {
    const f = path.join(dir, `${s}.png`);
    cp.execFileSync("/usr/bin/sips", ["-s", "format", "png", "-z", String(s), String(s), "/System/Library/CoreServices/Finder.app/Contents/Resources/Finder.icns", "--out", f], { stdio: "ignore" });
    pngs.set(s, fs.readFileSync(f));
  }
  const icns = path.join(dir, "x.icns");
  fs.writeFileSync(icns, iconfiles.buildIcns(pngs));
  const out = cp.execFileSync("/usr/bin/sips", ["-g", "pixelWidth", icns], { encoding: "utf8" });
  assert.match(out, /pixelWidth: (1024|512)/);
});

function fakeBundle() {
  const root = path.join(tmp(), "Trivo.app");
  fs.mkdirSync(path.join(root, "Contents", "Resources"), { recursive: true });
  fs.mkdirSync(path.join(root, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(root, "Contents", "Resources", "icon.icns"), "ORIGINAL");
  fs.writeFileSync(path.join(root, "Contents", "MacOS", "Trivo"), "");
  return root;
}

test("ajudante do macOS: espera o PID sair, troca o .icns guardando o original e depois restaura", { skip: process.platform === "win32" }, () => {
  const app = fakeBundle();
  const res = path.join(app, "Contents", "Resources");
  const data = tmp();
  fs.writeFileSync(path.join(data, "icon.icns"), "NOVO");
  const log = path.join(data, "icon.log");
  const dead = cp.spawnSync(process.execPath, ["-e", "0"]).pid; // PID que já saiu
  const run = (icns) => cp.spawnSync("/bin/sh", ["-c", MAC_HELPER, "t", String(dead), app, icns, log, "0"], { encoding: "utf8" });
  run(path.join(data, "icon.icns"));
  assert.equal(fs.readFileSync(path.join(res, "icon.icns"), "utf8"), "NOVO");
  assert.equal(fs.readFileSync(path.join(res, `icon.icns${ORIGINAL_SUFFIX}`), "utf8"), "ORIGINAL");
  run(path.join(data, "icon.icns")); // de novo: o backup continua sendo o original
  assert.equal(fs.readFileSync(path.join(res, `icon.icns${ORIGINAL_SUFFIX}`), "utf8"), "ORIGINAL");
  run("");
  assert.equal(fs.readFileSync(path.join(res, "icon.icns"), "utf8"), "ORIGINAL");
  assert.equal(fs.existsSync(path.join(res, `icon.icns${ORIGINAL_SUFFIX}`)), false);
  assert.match(fs.readFileSync(log, "utf8"), /concluído/);
});

test("ajudante do macOS: caminho com espaço e aspas não vira comando", { skip: process.platform === "win32" }, () => {
  const base = path.join(tmp(), `a "b" $(touch x) ; c`);
  fs.mkdirSync(base);
  const app = path.join(base, "Trivo.app");
  fs.renameSync(fakeBundle(), app);
  const icns = path.join(base, "n.icns");
  fs.writeFileSync(icns, "NOVO");
  cp.spawnSync("/bin/sh", ["-c", MAC_HELPER, "t", "999999", app, icns, path.join(base, "l.log"), "0"], { cwd: base });
  assert.equal(fs.readFileSync(path.join(app, "Contents", "Resources", "icon.icns"), "utf8"), "NOVO");
  assert.equal(fs.existsSync(path.join(base, "x")), false);
});

function manager(platform, execPath) {
  const app = new EventEmitter();
  app.quit = () => app.emit("quitCalled");
  const liveIcons = [];
  app.dock = { setIcon: (img) => liveIcons.push(img) };
  const img = (buf) => ({ isEmpty: () => !buf, buf, toPNG: () => buf, resize: ({ width }) => img(PNG(`r${width}`)) });
  const electron = { app, nativeImage: { createFromBuffer: img, createFromPath: (p) => img(fs.existsSync(p) ? fs.readFileSync(p) : null) }, BaseWindow: { getAllWindows: () => [] } };
  const data = tmp();
  const files = {
    png: path.join(data, "icon.png"),
    icns: path.join(data, "icon.icns"),
    ico: path.join(data, "icon.ico"),
    defaultPng: path.join(data, "cache", "default-icon.png"),
    defaultIcns: path.join(data, "cache", "default-icon.icns"),
    defaultIco: path.join(data, "cache", "default-icon.ico"),
    log: path.join(data, "icon.log"),
  };
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => { child.stdout.emit("data", "3\n"); child.emit("close", 0); });
    return child;
  };
  const m = createIconManager({ electron, files, platform, execPath, spawn });
  return { m, app, files, spawned, liveIcons };
}
const url = `data:image/png;base64,${PNG("x".repeat(80)).toString("base64")}`;

test("macOS: Aplicar deixa o original pendente e o ajudante sai na saída do app", async () => {
  const bundle = fakeBundle();
  const { m, app, spawned } = manager("darwin", path.join(bundle, "Contents", "MacOS", "Trivo"));
  assert.equal(macBundleOf(path.join(bundle, "Contents", "MacOS", "Trivo")), bundle);
  const r = await m.set(url);
  assert.equal(r.state, "aplicar");
  app.emit("will-quit");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, "/bin/sh");
  assert.equal(spawned[0].args[3], String(process.pid));
  assert.equal(spawned[0].args[4], bundle);
  assert.equal(spawned[0].opts.detached, true);
  app.emit("will-quit");
  assert.equal(spawned.length, 1, "só uma vez");
});

test("macOS: Reiniciar e aplicar pede a reabertura; sem mudança pendente o ajudante não roda", async () => {
  const bundle = fakeBundle();
  const { m, app, spawned } = manager("darwin", path.join(bundle, "Contents", "MacOS", "Trivo"));
  app.emit("will-quit");
  assert.equal(spawned.length, 0, "nada pendente");
  await m.set(url);
  const quit = new Promise((r) => app.once("quitCalled", r));
  m.restartToApply();
  await quit;
  app.emit("will-quit");
  assert.equal(spawned[0].args[7], "1");
});

test("Windows: troca os atalhos que apontam para este Trivo.exe e restaura para o .exe", async () => {
  const { m, spawned, files } = manager("win32", "C:\\Users\\x\\AppData\\Local\\Programs\\Trivo\\Trivo.exe");
  const r = await m.set(url);
  assert.equal(r.state, "atalhos");
  assert.equal(r.shortcuts, 3);
  assert.equal(spawned[0].cmd, "powershell.exe");
  assert.equal(spawned[0].opts.env.TM_EXE, "C:\\Users\\x\\AppData\\Local\\Programs\\Trivo\\Trivo.exe");
  assert.equal(spawned[0].opts.env.TM_ICON, files.ico);
  assert.ok(!spawned[0].args.join(" ").includes("Trivo.exe"), "caminho vai por variável de ambiente, não no script");
  const back = await m.reset();
  assert.equal(back.state, "original");
  assert.equal(spawned[1].opts.env.TM_ICON, "");
});

test("ícone padrão temático: aplica automaticamente, dedupes, mas NUNCA sobrescreve ícone personalizado do usuário", async () => {
  const bundle = fakeBundle();
  const { m, app, files, spawned, liveIcons } = manager("darwin", path.join(bundle, "Contents", "MacOS", "Trivo"));
  const themeA = `data:image/png;base64,${PNG("themeA".repeat(20)).toString("base64")}`;
  const themeB = `data:image/png;base64,${PNG("themeB".repeat(20)).toString("base64")}`;
  const custom = `data:image/png;base64,${PNG("custom".repeat(20)).toString("base64")}`;

  // 1. Sem ícone personalizado, o padrão temático é aplicado e gravado no cache
  const r1 = await m.setTheme(themeA);
  assert.equal(r1.skipped, undefined);
  assert.equal(r1.unchanged, false);
  assert.equal(r1.state, "aplicar");
  assert.ok(fs.existsSync(files.defaultPng) && fs.existsSync(files.defaultIcns) && fs.existsSync(files.defaultIco));
  assert.equal(liveIcons.length, 1);

  // 2. Mesmo PNG repetido não regrava nem pisca o Dock
  const r2 = await m.setTheme(themeA);
  assert.equal(r2.unchanged, true);
  assert.equal(liveIcons.length, 1);

  // 3. Usuário aplica ícone próprio: ele vence SEMPRE
  await m.set(custom);
  assert.equal(m.hasCustom(), true);
  const countAfterCustom = liveIcons.length;

  // 4. Troca de tema tenta atualizar o ícone padrão -> estritamente ignorado!
  const rSkipped = await m.setTheme(themeB);
  assert.equal(rSkipped.skipped, "custom");
  assert.equal(liveIcons.length, countAfterCustom, "não substitui o ícone do usuário no Dock");
  assert.deepEqual(fs.readFileSync(files.png), PNG("custom".repeat(20)));
  assert.deepEqual(fs.readFileSync(files.defaultPng), PNG("themeA".repeat(20)), "nem altera o cache enquanto custom estiver ativo");

  // 5. Ao remover o ícone personalizado (reset), volta para o padrão temático e volta a aceitar trocas de tema
  await m.reset();
  assert.equal(m.hasCustom(), false);
  const rAfterReset = await m.setTheme(themeB);
  assert.equal(rAfterReset.skipped, undefined);
  assert.equal(rAfterReset.unchanged, false);
  assert.deepEqual(fs.readFileSync(files.defaultPng), PNG("themeB".repeat(20)));

  // 6. Ajudante do macOS recebe defaultIcns quando não há custom
  app.emit("will-quit");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args[5], files.defaultIcns);
});

test("default-icon.js: gera SVG vetorial da Arara Pirata com cores dinâmicas por tema", () => {
  const di = require("../src/default-icon");
  const pDefault = di.paletteFromTheme(null);
  assert.deepEqual(pDefault, di.DEFAULT_PALETTE);

  const pMocha = di.paletteFromTheme({ bg: "#1e1e2e", sidebar: "#181825", accent: "#cba6f7", green: "#a6e3a1", yellow: "#f9e2af", red: "#f38ba8" });
  const pLatte = di.paletteFromTheme({ bg: "#eff1f5", sidebar: "#e6e9ef", accent: "#1e66f5", green: "#40a02b", yellow: "#df8e1d", red: "#d20f39" });
  assert.notEqual(pMocha.wave2, pLatte.wave2);
  assert.notEqual(pMocha.wave3, pLatte.wave3);
  assert.equal(pMocha.feathers, "#cba6f7");
  assert.equal(pLatte.feathers, "#1e66f5");

  const svg = di.buildIconSvg(pMocha);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1024 1024"/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(svg.includes("#cba6f7"), "contém a cor principal do tema");
  assert.ok(!svg.includes("undefined"), "não contém valores indefinidos");
});
