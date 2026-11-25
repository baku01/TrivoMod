#!/usr/bin/env node
"use strict";
const patch = require("../installer/patch");
const VERSION = require("../src/version");

const HELP = `TrivoMod ${VERSION}

Uso: node bin/trivomod.js <comando> [opções]

Comandos:
  gui         Abre o instalador gráfico (padrão, sem argumentos)
  install     Modifica o app do Trivo para carregar o mod (macOS, Windows e Linux)
  uninstall   Restaura o asar original e o hash de integridade
  update      Copia o código do mod para a pasta de dados, sem mexer no app
  status      Mostra o estado da instalação
  paths       Mostra onde ficam temas, plugins, ajustes e logs

Opções:
  --app <caminho>   O Trivo (.app no macOS; pasta do Trivo.exe no Windows; pasta com resources/ no Linux).
                    Padrão: /Applications/Trivo.app
  --force           Não confere se o Trivo está aberto
  --json            Saída em JSON (status)
`;

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--app") out.app = argv[++i];
    else if (a === "--force") out.force = true;
    else if (a === "--json") out.json = true;
    else if (a === "--no-open") out.noOpen = true;
    else if (a === "--browser") out.browser = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else out._.push(a);
  }
  return out;
}

function main() {
  const args = parse(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help) return console.log(HELP);
  switch (cmd || "gui") {
    case "gui": {
      process.env.TRIVOMOD_GUI_EXIT = "1";
      require("../installer/gui")
        .start({ open: !args.noOpen, browser: Boolean(args.browser) })
        .then(({ url, windowKind }) => console.log(
          windowKind
            ? `Janela do instalador aberta (${windowKind}, ${url})\n(Fecha automaticamente ao fechar a janela; Ctrl+C encerra.)`
            : `Instalador em ${url}\n(Ctrl+C aqui encerra; ele também fecha sozinho quando você fecha a janela.)`
        ))
        .catch((e) => { console.error(`Erro: ${e.message}`); process.exitCode = 1; });
      return;
    }
    case "install": {
      const r = patch.install(args);
      console.log(`Instalado em ${r.app}\n  entrada original: ${r.originalMain}\n  código do mod:    ${r.dist}\n  hash do asar:     ${r.hash}`);
      console.log("\nAbra o Trivo. Atalho do painel: Ctrl/Cmd+Alt+T (ou o botão TM no canto inferior esquerdo).");
      console.log("Depois de atualizar o Trivo, rode install de novo: a atualização apaga o patch.");
      return;
    }
    case "uninstall": {
      const r = patch.uninstall(args);
      console.log(`Original restaurado em ${r.app}. Seus temas e plugins continuam em ${patch.dataDir()}.`);
      return;
    }
    case "update": {
      console.log(`Código copiado para ${patch.syncDist()}`);
      return;
    }
    case "status": {
      const s = patch.status(args);
      if (args.json) return console.log(JSON.stringify(s, null, 2));
      for (const [k, v] of Object.entries(s)) console.log(`${k.padEnd(20)} ${v}`);
      return;
    }
    case "paths": {
      const d = patch.dataDir();
      console.log(`dados    ${d}\ntemas    ${d}/themes\nplugins  ${d}/plugins\najustes  ${d}/settings.json\nlogs     ${d}/logs`);
      return;
    }
    default:
      console.error(`Comando desconhecido: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

try {
  main();
} catch (error) {
  console.error(`Erro: ${error.message}`);
  process.exitCode = 1;
}
