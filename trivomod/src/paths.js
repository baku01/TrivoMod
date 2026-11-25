"use strict";
const os = require("node:os");
const path = require("node:path");

/** Onde moram os dados do mod: código (`dist`), temas, plugins, ajustes e logs. */
function dataDir() {
  if (process.env.TRIVOMOD_DIR) return path.resolve(process.env.TRIVOMOD_DIR);
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "TrivoMod");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "TrivoMod");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "TrivoMod");
}

module.exports = { dataDir };
