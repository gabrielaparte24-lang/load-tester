# Wrapper: equivale a "npm run start". Uso: .\scripts\start.ps1 [opcoes]
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js nao encontrado. Instale Node 22.19 ou superior: https://nodejs.org (ou winget install OpenJS.NodeJS.LTS)"
  exit 1
}
& node (Join-Path $PSScriptRoot "start.mjs") @args
exit $LASTEXITCODE
