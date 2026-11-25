@echo off
rem Duplo clique abre o instalador grafico do TrivoMod (Windows).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org e abra este arquivo de novo.
  pause
  exit /b 1
)
node bin\trivomod.js gui
