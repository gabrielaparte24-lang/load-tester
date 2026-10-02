@echo off
rem Wrapper: equivale a "npm run start". Uso: scripts\start.bat [opcoes]
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale Node 22.19 ou superior: https://nodejs.org  ^(ou winget install OpenJS.NodeJS.LTS^)
  exit /b 1
)
node "%~dp0start.mjs" %*
exit /b %ERRORLEVEL%
