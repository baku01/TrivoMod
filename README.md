<p align="center">
  <img src="assets/icon.svg" alt="TrivoMod" width="148" height="148" />
</p>

<h1 align="center">TrivoMod</h1>

<p align="center">
  <a href="https://github.com/baku01/TrivoMod/actions/workflows/release.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/baku01/TrivoMod/release.yml?style=for-the-badge&label=Build&logo=github" alt="Build Status" />
  </a>
  <a href="https://github.com/baku01/TrivoMod/releases">
    <img src="https://img.shields.io/github/v/release/baku01/TrivoMod?style=for-the-badge&label=Release&color=145ee0" alt="Latest Release" />
  </a>
  <img src="https://img.shields.io/badge/Plataformas-macOS%20%7C%20Windows%20%7C%20Linux-1a1d26?style=for-the-badge" alt="macOS, Windows, Linux" />
</p>

---

## ✨ Recursos

- **Super fácil de instalar**: instalador gráfico em janela própria, sem precisar abrir o navegador.
- **Áudio aprimorado**: escolha na aba do TrivoMod entre o áudio padrão do Trivo ou o modo melhorado, com voz mais limpa, volume equilibrado e menos cortes nas chamadas.
- **Ícone dinâmico da Arara Pirata**: aplicado automaticamente ao instalar e muda de cor sozinho conforme o seu tema — e se você escolher um ícone próprio, o seu sempre prevalece.
- **Temas, Layouts e CSS personalizado**:
  - Já vem com os temas **Catppuccin** (*Latte*, *Frappé*, *Macchiato* e *Mocha*), *Violeta noturno*, *AMOLED* e o **Layout Discord**.
  - Editor de CSS ao vivo, suporte a temas locais (`.css`) e importação de temas por link.
- **Visual nativo**: barra superior integrada às cores do tema, efeito translúcido no macOS e Windows 11, fonte e cor de destaque do sistema.
- **Plugins integrados**: *Sem anúncios* (ativo por padrão), *Áudio aprimorado*, *Escala da interface*, *Cor de destaque*, *Fonte da interface* e *Catppuccin: destaque*, além de suporte aos seus próprios plugins.
- **Integrado aos Ajustes do Trivo**: acesse pelo menu lateral dos Ajustes, pelo atalho `Cmd/Ctrl + Alt + T` ou pela paleta rápida de comandos (`Cmd/Ctrl + Shift + P`).
- **Leve, privado e seguro**: sem telemetria, não lê suas mensagens, conta com modo seguro automático em caso de falhas e exportação/importação de backup das suas configurações.

---

## 🎨 Ícone dinâmico por tema

Ao instalar o TrivoMod, o app passa a usar o ícone da **Arara Pirata**, que muda de cores automaticamente sempre que você troca de tema.

<p align="center">
  <img src="assets/icon-themes-preview.png" alt="Prévia do ícone da Arara Pirata em 4 temas" width="680" />
</p>

> Se você definir uma imagem própria em **Ajustes › TrivoMod › Ícone do aplicativo**, o seu ícone personalizado sempre terá prioridade e nunca será substituído ao trocar de tema.

---

## 📦 Instalação / Desinstalação

### Baixar pronto (Recomendado)

1. Baixe a versão mais recente na página de **[Releases](https://github.com/baku01/TrivoMod/releases)** para o seu sistema (**macOS**, **Windows** ou **Linux**).
2. Feche completamente o **Trivo** (inclusive na barra de menu ou bandeja do sistema).
3. Abra o instalador:
   - **macOS:** dê duplo clique em `Instalar TrivoMod.command`
   - **Windows:** dê duplo clique em `Instalar TrivoMod.cmd`
   - **Linux:** execute `./instalar-trivomod.sh`
4. Clique em **Instalar**. Quando o Trivo atualizar, basta abrir o instalador e clicar em **Reparar**. Para voltar ao original, clique em **Desinstalar**.

### Pelo código-fonte

```sh
git clone https://github.com/baku01/TrivoMod.git
cd TrivoMod/trivomod
node bin/trivomod.js gui
```

---

## ⌨️ Atalhos

| Atalho | Ação |
| --- | --- |
| `Cmd / Ctrl + Alt + T` | Abre ou fecha o painel do TrivoMod |
| `Cmd / Ctrl + Shift + P` | Abre a paleta de comandos (temas, layouts, plugins, backup…) |

---

## 🧩 Para desenvolvedores

Quer criar temas, plugins ou entender como o mod funciona por baixo dos panos? Veja a documentação técnica em **[trivomod/README.md](trivomod/README.md)**.

---

## ⚠️ Aviso

- **Trivo** é marca de seus respectivos proprietários e é mencionado aqui apenas de forma descritiva. Este projeto não tem qualquer afiliação ou endosso do Trivo.
- Modificações de cliente não são oficialmente suportadas pelo Trivo. Embora o TrivoMod não leia mensagens nem automatize ações na sua conta, o uso é por sua conta e risco.
