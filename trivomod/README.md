# TrivoMod

Mod de cliente para o **Trivo Desktop** (Electron), no mesmo modelo do Vencord: um instalador modifica o
app, e o app passa a carregar o mod a cada abertura. Não é extensão de navegador.

Traz temas, CSS próprio e plugins visuais, com um painel dentro do Trivo.
Não lê mensagens, não envia nada para fora e não automatiza ações.

## Como funciona

```
Trivo.app/Contents/Resources/app.asar
   package.json  main → trivomod-loader.js        ← única mudança no app
   trivomod-loader.js                              ← carrega o mod, depois o app original
~/Library/Application Support/TrivoMod/
   dist/        código do mod (copiado pelo instalador)
   themes/      seus temas .css
   plugins/     seus plugins .js
   settings.json, logs/
```

1. O **loader** roda antes do app e chama `src/main/index.js`, que registra um preload em toda sessão do
   Electron (`session-created` + `registerPreloadScript`, só para `https://trivo.app.br/*`).
2. O **preload** pede ao processo principal os ajustes, temas e plugins, expõe `window.TrivoModNative` e
   injeta o runtime no mundo principal via `webFrame` (a CSP do Trivo proíbe `eval` e script de fora).
3. O **runtime** (`src/renderer/index.js`) aplica os estilos por `adoptedStyleSheets`, carrega os plugins e
   monta o painel.

O Trivo usa `EnableEmbeddedAsarIntegrityValidation` e `OnlyLoadAppFromAsar`. Por isso o instalador regrava o
`app.asar` (header novo + dados originais intactos + arquivos novos no fim), atualiza o hash em
`Info.plist` e **reassina o pacote (ad-hoc)** preservando as entitlements e o hardened runtime.
No **Windows** o hash fica num recurso do `Trivo.exe` (`INTEGRITY/ELECTRONASAR`, um JSON). Como o hash tem
tamanho fixo, o instalador troca só esses 64 caracteres no lugar (o PE não muda de tamanho). O `Trivo.exe`
do Trivo não é assinado, então não há assinatura a refazer.
O original fica em `app.asar.original`, e `uninstall` o restaura byte a byte.

## Instalar (macOS)

**Instalador gráfico** (como o do Vencord): dê duplo clique em `Instalar TrivoMod.command` ou rode
`node bin/trivomod.js gui`. Ele abre uma página local que lista as instalações do Trivo encontradas, com o
estado de cada uma (aberto, sem mod, mod instalado, hash divergente) e os botões **Instalar**, **Reparar**
(reaplica depois de uma atualização do Trivo) e **Desinstalar**. Dá para adicionar outro local pelo caminho.
O servidor só escuta em `127.0.0.1`, confere `Host` e `Origin`, exige um token por sessão e fecha sozinho
quando você fecha a página.

Pela linha de comando:

```sh
cd trivomod
node bin/trivomod.js install          # feche o Trivo antes (inclusive da barra de menu)
node bin/trivomod.js status
node bin/trivomod.js uninstall
```

- Outro local: `--app /caminho/Trivo.app`. Linux: `--app <pasta que contém resources/>` (**não testado**).

## Instalar (Windows)

Precisa do Node.js. Dê duplo clique em `Instalar TrivoMod.cmd` (ou `node bin\trivomod.js gui`).
O instalador acha o Trivo em `%LOCALAPPDATA%\Programs\Trivo`, em `Arquivos de Programas\Trivo` e pelo
`InstallLocation` do registro de desinstalação; outro local vai em "Outro local" (a pasta do `Trivo.exe`).
Feche o Trivo inclusive na bandeja do relógio. Os dados do mod ficam em `%APPDATA%\TrivoMod`.

- O Trivo **se atualiza sozinho no Windows**: cada atualização apaga o patch. Abra o instalador e use **Reparar**.
- **Não testado num Windows de verdade**: o patch foi verificado na pasta extraída do `TrivoSetup-1.0.8.exe`
  (hash no `.exe` = hash do `app.asar`, desfazer volta byte a byte), mas o Trivo.exe não foi executado.
- Se o macOS bloquear a escrita em `/Applications` ("Gerenciamento de Apps"), dê essa permissão ao Terminal
  ou copie o Trivo para `~/Applications` e use `--app`.
- **Atualizar o Trivo apaga o patch**: rode `install` de novo. Para atualizar só o mod, `node bin/trivomod.js update`.

### Atualização automática do mod

O próprio mod se atualiza (`src/main/updater.js`). O patch dentro do Trivo não muda; só `<dados>/dist`.

- **De onde vem:** a última release do GitHub. Cada push no `main` que mexe em `trivomod/` vira release
  depois de a suíte passar no macOS, Windows e Linux, então quem tem o mod acompanha os commits sem receber
  o que quebra os testes. A release publica `trivomod-runtime-vX.Y.Z.json.gz` (feito por
  `tools/build-runtime.js`), e o `SHA256SUMS.txt` cobre esse arquivo também.
- **Quando:** 30 s depois de abrir e a cada 6 h. O download é conferido pelo SHA-256 e pelo formato
  (caminhos, versão, JS que compila). Os módulos do processo principal são carregados à parte para ver
  se sobem, e só então o pacote vai para `<dados>/dist.next`.
- **Troca:** ao fechar o Trivo (`dist` -> `dist.prev`, `dist.next` -> `dist`), nunca com ele aberto. O
  aviso "Reiniciar agora" faz isso na hora.
- **Volta sozinha:** se a versão nova abrir 2 vezes sem chegar ao `boot-ok` da página, na 3ª abertura
  volta para `dist.prev`, reabre o Trivo e não tenta mais essa versão.
- **Desligar:** Ajustes › TrivoMod › Sobre › "Atualizar automaticamente", ou `TRIVOMOD_NO_UPDATE=1`.
  Rodando do código-fonte (fora de `<dados>/dist`), o atualizador nem liga.
- Instalar/Reparar pelo instalador sempre vence: descarta o que estava baixado esperando.
- **Limite:** se o módulo principal novo quebrar antes de o atualizador rodar, o Trivo abre sem o mod e
  não há quem volte a versão. O passo de carregar os módulos à parte existe para pegar isso antes; se
  acontecer, use **Reparar**.

## Usar

Painel: **Cmd/Ctrl + Alt + T** ou o botão do TrivoMod (estrela) na barra do topo, ao lado de "Avisos", como o Vencord
faz na barra do Discord (dá para esconder). Fora da tela logada ele aparece como botão flutuante no canto.
**Cmd/Ctrl + Shift + P** abre a **paleta de comandos** (trocar tema/layout, ligar plugins, abrir abas do painel,
recarregar, atualizar temas online, exportar backup; plugins podem acrescentar comandos).

O painel tem navegação lateral no estilo dos Ajustes do sistema: no Mac, controles do macOS; no Windows, do Windows 11.

Como no Vencord, o mod também entra nos **Ajustes do Trivo**: a lista lateral ganha o grupo **TrivoMod**
(TrivoMod, Plugins, Temas, Layout, CSS rápido, Ícone do aplicativo), logo antes de "Sobre". Cada item abre a
página do mod na área da direita do próprio diálogo; clicar numa seção do Trivo volta para ela. Em tela estreita
(quando o Trivo mostra só a lista), o item abre o painel flutuante.

- **Temas**: um por vez (escolha única, com prévia das cores e busca). `.css` na pasta `themes/`; mudanças aparecem
  ao salvar, sem recarregar. **Temas online**: cole links `https://…css`; o processo principal baixa (até 1 MB,
  só https), guarda em `cache/links/` e eles entram na lista. Imagens/fontes externas dentro deles não carregam (CSP).
- **Plugins**: `.js` na pasta `plugins/`. Plugins seus nascem **desligados**. Recarregue o Trivo depois de editar.
- **CSS rápido**: editor no painel (Tab indenta), aplicado por último.
- **Janela e sistema** (aparência nativa): a barra de título do Trivo passa a usar as cores da barra de abas (vira
  uma faixa só); **translucidez** do macOS (vibrancy) ou **Mica** do Windows 11 (22H2+) atrás da barra do topo, dos
  servidores e dos canais; fonte do sistema (SF Pro / Segoe UI Variable); cor de destaque do sistema (opcional);
  no Windows os botões da janela ficam no tamanho do Windows 11.
- **Modo seguro automático** (como o do moonlight): se o Trivo falhar ao abrir 3 vezes seguidas com o mod (ou a página
  cair), a próxima abertura sobe sem temas/layouts/plugins e avisa, com botão para sair. Estado em `state.json`.
- **Backup**: Sobre › Exportar/Importar — um `.json` com ajustes, temas, layouts e plugins seus.
- **Layout**: aba própria; escolha *Trivo (padrão)* ou *Discord*. Só um layout fica ativo; temas ligados valem por cima
  dele. Layouts seus: `.css` na pasta `layouts/`.
  O layout *Discord* segue o Discord atual: sem faixa de abas; a barra de título da janela mostra o nome da tela e
  ganha Avisos e o botão do TrivoMod no canto direito; trilho e canais na mesma cor; ícones de servidor em
  "squircle" de 40 px. Com o trilho recolhido, a faixa de abas do Trivo volta.
- **Ícone**: escolha uma imagem; ela é recortada em quadrado de cantos arredondados (no macOS, na grade de ícones da
  Apple: 824 de 1024 px, margem e sombra). Vira `icon.png`, `icon.icns` e `icon.ico` nos dados do mod e troca também o
  **ícone original**, para o Dock, o Finder e a barra de tarefas ficarem certos com o Trivo fechado:
  - macOS: `Contents/Resources/icon.icns` é trocado e o app é reassinado (ad-hoc). Como reassinar mexe no executável,
    isso acontece quando o Trivo fecha (um ajudante espera o processo sair); o botão **Reiniciar e aplicar** faz na hora.
    O original fica em `icon.icns.trivomod-original`; **Restaurar o original** e o desinstalador o devolvem, e
    Instalar/Reparar reaplica o ícone salvo depois de uma atualização do Trivo. Log em `logs/icon.log`.
  - Windows: os atalhos que apontam para o `Trivo.exe` (Menu Iniciar, Área de Trabalho, fixados na barra de tarefas)
    passam a usar `icon.ico`; é deles que a barra tira o ícone. O `.exe` não muda. Reaplicado a cada abertura.
  - Linux: só as janelas abertas.
- Incluídos: temas *Violeta noturno*, *AMOLED* e **Catppuccin Latte, Frappé, Macchiato e Mocha** (gerados por
  `tools/gen-catppuccin.js` a partir da paleta oficial); plugins *Escala da interface*, *Cor de destaque*,
  *Fonte da interface* e *Catppuccin: destaque* (os 14 acentos).
- **Sem anúncios** (ligado por padrão): esconde os cartões "Do Trivo"/"Patrocinado" do canal de voz, da lista de
  membros e de dentro da chamada; cada um pode ser religado nas opções do plugin.

### Classes do Trivo em CSS: `.$nome`

O Trivo usa CSS Modules: a classe real é `<hash>_nome` (ex.: `TlT3fq_shell`) e o hash muda a cada versão.
Em temas, layouts, plugins e CSS rápido, escreva `.$shell` e o TrivoMod troca por um seletor que casa só o nome.
Peças úteis: `.$shell`, `.$barra`/`.$icone`/`.$alvo` (servidores), `.$sidebar`, `.$serverHeader`, `.$channelLink`,
`.$sidebarFooter`, `.$chatHeader`, `.$messageList`, `.$message`, `.$messageAvatar`, `.$composer`, `.$composerInput`.

### Escrever um tema

O Trivo é todo feito de variáveis CSS e do atributo `data-tema` (`escuro`, `claro`, `brasa`) no `<html>`.
Use `html:root[data-tema=…]` para ter prioridade sobre os temas nativos:

```css
/**
 * @name Meu tema
 * @author Eu
 * @description Fundo azul-marinho no tema escuro.
 */
html:root[data-tema="escuro"] {
  --background: #0a1020;
  --surface-sidebar: #0e1730;
  --surface-raised: #142041;
  --accent: #7aa2ff;
}
```

Variáveis úteis: `--background`, `--surface-sidebar`, `--surface-raised`, `--surface-input`, `--line`,
`--line-strong`, `--text-primary`, `--text-secondary`, `--accent`, `--accent-strong`, `--text-on-accent`,
`--focus-ring`, `--font-ui`. A lista completa está no CSS do site (`:root`, `html[data-tema=claro]`, `html[data-tema=brasa]`).

Limite da CSP do Trivo: **imagens e fontes de fora são bloqueadas** (`img-src`/`font-src`). Use `data:` URIs e fontes do sistema.

### Escrever um plugin

```js
TrivoMod.definePlugin({
  name: "Meu plugin",
  description: "Faz algo visual.",
  authors: ["Eu"],
  settings: {
    cor: { type: "color", label: "Cor", default: "#ff8a3d" },   // boolean | number | range | color | select | string
  },
  styles() { return `html:root { --accent: ${this.options.get("cor")}; }`; },  // string ou função; recalculada ao mudar a opção
  start() { /* ao ligar */ },
  stop() { /* ao desligar */ },
  settingsChanged(chave, valor) { /* opcional */ },
  commands: [{ name: "Meu comando", run() { TrivoMod.toast("Oi!"); } }],  // aparecem na paleta enquanto ligado
});
```

- `this.store.cor` lê (com o padrão) e `this.store.cor = "#fff"` grava e avisa, como o `settings.store` do Vencord;
  `this.options.subscribe("cor", (valor) => …)` (ou `"*"`) devolve quem cancela.
- `TrivoMod.toast(texto, { tipo: "info" | "sucesso" | "erro", duracao, acao: { rotulo, run } })`,
  `TrivoMod.registerCommand({ name, run })`, `TrivoMod.on("theme" | "layout" | "plugin", cb)`.
- `TrivoMod.modules`: os módulos do próprio site (Turbopack), como o `findByProps` do Vencord, sem eval:
  `find(filtro)`, `findAll`, `findByProps(...nomes)`, `findByCode(...trechos)`, `waitFor(filtro)`, `waitForProps`,
  `get(id)`, `ready`. Só enxerga módulos já carregados; para os que vêm depois, use `waitFor`.

`TrivoMod.Utils.waitFor(seletor)` espera um elemento aparecer. Um plugin roda como qualquer script da página
(sem Node, sem arquivos); a única ponte é `TrivoModNative` (ajustes e abrir pasta).

## Segurança

- O processo principal só atende o preload vindo do **quadro principal** de `https://trivo.app.br`
  (outras origens: `TRIVOMOD_ORIGINS=url,url`, para desenvolvimento).
- Os ajustes gravados passam por um filtro de formato; chaves como `__proto__` são descartadas.
- Quem escreve em `~/Library/Application Support/TrivoMod/dist` executa código no Trivo. É a mesma
  confiança que o Vencord pede, então proteja essa pasta.
- Perfil isolado para testes: `TRIVOMOD_USER_DATA=/pasta` (o Trivo de release recusa `--user-data-dir`). Autoteste: `TRIVOMOD_SELFTEST=1` abre o painel, liga um tema, grava `logs/selftest/` e encerra.
- Modo seguro: abra o Trivo com `TRIVOMOD_SAFE=1` para não carregar nada. Depuração: `TRIVOMOD_DEBUG=1`
  grava as mensagens `[TrivoMod]` do console em `logs/renderer.log`.

## Avisos

- O Trivo é um serviço em Beta e não oferece suporte a mods. Os Termos de Uso (versão 6, item 16) restringem
  automação em conta de pessoa e engenharia reversa "para abusar do serviço"; o mod não faz nenhuma das duas,
  mas a interpretação é do Trivo. Use por sua conta e risco.
- No macOS o app deixa de estar com a assinatura original (continua ad-hoc). No Windows o `Trivo.exe` muda (64 bytes), e a atualização automática do Trivo
  pode apagar o patch.
- Este projeto não é afiliado ao Trivo.

## Desenvolvimento

```sh
npm test                                  # asar, ajustes, processo principal, preload (Electron simulado) e instalador gráfico
node test/fixture.js out.html <globals.css do Trivo> --probe   # página que imita o preload
swiftc -module-cache-path /tmp/m test/webkit-probe.swift -o /tmp/webkit-probe && /tmp/webkit-probe out.html
```

O `fixture.js` + `webkit-probe` rodam o painel de verdade (WebKit) com o CSS real do Trivo e clicam em tudo.
O `webkit-probe` também abre o instalador gráfico (`--eval` e `--snapshot out.png`).
Sonda ao vivo: com a pasta `dev/` criada nos dados do mod (antes de abrir o Trivo), gravar `dev/request.js` roda o
script na página do Trivo e devolve `dev/response.json` e `dev/shot.png` (`reload` recarrega a página). Serve para
ajustar layouts na tela logada de verdade; apague a pasta para desligar.
`test/fixture-shell.js` monta uma réplica da tela logada com as classes reais e o CSS do Trivo (baixado do site),
para conferir layouts e temas sem conta: `--layout builtin:discord --themes builtin:catppuccin-mocha`.
Use `TRIVOMOD_DIR=/outra/pasta` para isolar os dados durante os testes.
