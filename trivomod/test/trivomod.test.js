"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const asar = require("../installer/asar");
const settings = require("../src/main/settings");
const library = require("../src/main/library");
const { loaderSource } = require("../installer/patch");

const sample = () =>
  asar.pack({
    "package.json": Buffer.from(JSON.stringify({ name: "x", main: "dist/main.js" })),
    "dist/main.js": Buffer.from("module.exports = 1;"),
    "recursos/a.html": Buffer.from("<p>oi</p>"),
  });

test("asar: pack -> parse devolve o que entrou", () => {
  const buf = sample();
  assert.equal(asar.readFile(buf, "dist/main.js").toString(), "module.exports = 1;");
  assert.equal(asar.readFile(buf, "recursos/a.html").toString(), "<p>oi</p>");
});

test("asar: patch substitui e acrescenta sem mexer no resto", () => {
  const buf = sample();
  const out = asar.patch(buf, {
    "package.json": Buffer.from('{"main":"loader.js"}'),
    "loader.js": Buffer.from("// loader"),
  });
  assert.equal(asar.readFile(out.buffer, "package.json").toString(), '{"main":"loader.js"}');
  assert.equal(asar.readFile(out.buffer, "loader.js").toString(), "// loader");
  assert.equal(asar.readFile(out.buffer, "dist/main.js").toString(), "module.exports = 1;");
  assert.equal(asar.readFile(out.buffer, "recursos/a.html").toString(), "<p>oi</p>");
  assert.equal(out.hash, asar.integrityHash(asar.parse(out.buffer).headerString));
});

test("asar: arquivos novos levam integrity no formato do Electron (hash do arquivo + blocos de 4 MiB)", () => {
  const crypto = require("node:crypto");
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const small = Buffer.from("// loader");
  const big = Buffer.alloc(4 * 1024 * 1024 + 10, 7);
  const out = asar.patch(sample(), { "a.js": small, "b.bin": big });
  const { header } = asar.parse(out.buffer);
  const a = asar.lookup(header, "a.js").integrity;
  assert.deepEqual(a, { algorithm: "SHA256", hash: sha(small), blockSize: 4194304, blocks: [sha(small)] });
  const b = asar.lookup(header, "b.bin").integrity;
  assert.equal(b.hash, sha(big));
  assert.equal(b.blocks.length, 2);
  assert.equal(b.blocks[0], sha(big.subarray(0, 4194304)));
  assert.equal(b.blocks[1], sha(big.subarray(4194304)));
});

test("asar: patch é repetível a partir do mesmo original", () => {
  const buf = sample();
  const a = asar.patch(buf, { "x.js": Buffer.from("1") });
  const b = asar.patch(buf, { "x.js": Buffer.from("1") });
  assert.equal(a.hash, b.hash);
});

test("asar: recusa o que não é asar", () => {
  assert.throws(() => asar.parse(Buffer.from("isto nao e um asar de jeito nenhum")));
});

test("asar: o hash do header do Trivo 1.0.8 bate com o Info.plist (se o app baixado existir)", (t) => {
  const app = path.resolve(__dirname, "..", "..", ".dl", "extracted", "Trivo.app", "Contents", "Resources", "app.asar");
  if (!fs.existsSync(app)) return t.skip("app não baixado");
  const { headerString } = asar.parse(fs.readFileSync(app));
  assert.equal(asar.integrityHash(headerString), "59294c6717b5d4f72e935e4413a9349cb8027f28f8e8b9397cce235e8161af2b");
  // serializar o header lido tem de reproduzir os mesmos bytes
  const parsed = asar.parse(fs.readFileSync(app));
  assert.equal(asar.serializeHeader(parsed.header).headerString, headerString);
});

test("loader gerado é JavaScript válido e carrega o app original por último", () => {
  const src = loaderSource("dist/main/principal.js", "/tmp/dados com espaço");
  new vm.Script(src);
  assert.ok(src.indexOf("trivomod") < src.indexOf('require("./dist/main/principal.js")'));
});

test("settings: descarta lixo e chaves perigosas", () => {
  const evil = JSON.parse('{"themes":{"__proto__":true,"ok":true,"x y":true,"n":1},"pluginSettings":{"p":{"constructor":1,"a":2,"b":"s","c":{"d":1}}},"quickCss":5}');
  const clean = settings.sanitize(evil);
  assert.deepEqual(clean.themes, { ok: true });
  assert.deepEqual(clean.pluginSettings, { p: { a: 2, b: "s" } });
  assert.equal(clean.quickCss, "");
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(settings.sanitize("lixo"), settings.defaults());
});

test("settings: limita o tamanho do CSS rápido", () => {
  assert.equal(settings.sanitize({ quickCss: "a".repeat(500_000) }).quickCss.length, 100_000);
});

test("library: lê o cabeçalho do tema e lista os incluídos", () => {
  assert.deepEqual(library.parseMeta("/**\n * @name Foo\n * @author Bar\n */\nbody{}"), { name: "Foo", author: "Bar" });
  const dist = path.resolve(__dirname, "..", "src");
  const themes = library.listThemes(dist, "/nao/existe");
  assert.ok(themes.some((t) => t.id === "builtin:amoled" && t.name === "AMOLED"));
  assert.ok(library.listPlugins(dist, "/nao/existe").length >= 3);
});

test("plugins incluídos compilam isolados", () => {
  const dir = path.resolve(__dirname, "..", "src", "plugins");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    new vm.Script(`(function(){\n${fs.readFileSync(path.join(dir, f), "utf8")}\n})`, { filename: f });
  }
  new vm.Script(fs.readFileSync(path.resolve(__dirname, "..", "src", "renderer", "index.js"), "utf8"));
  new vm.Script(`(function(require){${fs.readFileSync(path.resolve(__dirname, "..", "src", "preload", "index.js"), "utf8")}})`);
});

test("settings: layout aceita id válido e descarta lixo", () => {
  assert.equal(settings.sanitize({ layout: "builtin:discord" }).layout, "builtin:discord");
  assert.equal(settings.sanitize({ layout: "../x y" }).layout, "");
  assert.equal(settings.sanitize({ layout: 3 }).layout, "");
});

test("temas e layouts incluídos: CSS válido depois de expandir `.$nome`", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "renderer", "index.js"), "utf8");
  const expandSrc = /const expandModules = \(css\) =>\s*([\s\S]*?\);)\n/.exec(src)[1];
  const expand = new Function("css", `return ${expandSrc.replace(/;$/, "")}`);
  assert.equal(expand(".$shell .$channelLink:hover"), ':is([class$="_shell"],[class*="_shell "]) :is([class$="_channelLink"],[class*="_channelLink "]):hover');
  const dist = path.resolve(__dirname, "..", "src");
  const all = [...library.listThemes(dist, "/nao/existe"), ...library.listLayouts(dist, "/nao/existe")];
  for (const t of all) {
    const css = expand(t.css);
    assert.ok(!css.includes(".$"), `${t.id}: sobrou .$`);
    let depth = 0;
    for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) { if (ch === "{") depth += 1; if (ch === "}") depth -= 1; assert.ok(depth >= 0, t.id); }
    assert.equal(depth, 0, `${t.id}: chaves desbalanceadas`);
  }
});

test("catppuccin: os 4 sabores com as 26 cores da paleta oficial e o plugin com os 14 acentos", () => {
  const { PALETTE, ACCENTS } = require("../tools/gen-catppuccin.js");
  assert.deepEqual(Object.keys(PALETTE), ["latte", "frappe", "macchiato", "mocha"]);
  assert.equal(ACCENTS.length, 14);
  for (const [id, p] of Object.entries(PALETTE)) {
    const css = fs.readFileSync(path.resolve(__dirname, "..", "src", "themes", `catppuccin-${id}.css`), "utf8");
    assert.equal((css.match(/--ctp-[a-z0-9]+: #[0-9a-f]{6};/g) || []).length, 26, id);
    assert.ok(css.includes(`--ctp-base: ${p.base};`) && css.includes(`--ctp-text: ${p.text};`));
  }
  assert.equal(PALETTE.mocha.base, "#1e1e2e");
  assert.equal(PALETTE.latte.mauve, "#8839ef");
  const plugin = fs.readFileSync(path.resolve(__dirname, "..", "src", "plugins", "catppuccin-destaque.js"), "utf8");
  for (const a of ACCENTS) assert.ok(plugin.includes(`"${a}"`), a);
});

test("sem anúncios: incluído, ligado por padrão, esconde os três espaços do Trivo", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "plugins", "sem-anuncios.js"), "utf8");
  let def;
  new vm.Script(src).runInNewContext({ TrivoMod: { definePlugin: (d) => (def = d) } });
  assert.equal(def.defaultEnabled, true);
  def.options = { get: (k) => def.settings[k].default };
  const css = def.styles();
  for (const c of [".$voiceSlot", ".$membersSlot", ".$callTile"]) assert.ok(css.includes(c), c);
  assert.match(css, /display: none !important/);
  def.options = { get: () => false };
  assert.equal(def.styles(), "");
});

test("ajustes embutidos: hideEmbedded oculta display inline para menus padrões voltarem a aparecer", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "renderer", "index.js"), "utf8");
  assert.match(src, /#trivomod-settings-view\[hidden\]\s*\{\s*display:\s*none !important;/);
  assert.match(src, /function hideEmbedded\(\)[\s\S]*?embed\.view\.style\.display = "none";/);
  assert.match(src, /function showEmbedded\(tab\)[\s\S]*?embed\.view\.style\.display = "flex";/);
  assert.match(src, /dialog\.addEventListener\("close", hideEmbedded\)/);
});
