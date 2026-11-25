#!/bin/bash
# Duplo clique abre o instalador gráfico do TrivoMod.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js não encontrado. Instale em https://nodejs.org e abra este arquivo de novo."
  read -r -p "Enter para fechar…" _
  exit 1
fi
exec node bin/trivomod.js gui
