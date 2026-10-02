# Wrapper: equivale a "npm run setup". Uso: .\scripts\setup.ps1 [opcoes]
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js nao encontrado. Instale Node 22.19 ou superior: https://nodejs.org (ou winget install OpenJS.NodeJS.LTS)"
  exit 1
}
& node (Join-Path $PSScriptRoot "setup.mjs") @args
exit $LASTEXITCODE
