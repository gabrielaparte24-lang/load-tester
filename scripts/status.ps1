# Wrapper: equivale a "npm run status". Uso: .\scripts\status.ps1 [opcoes]
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js nao encontrado. Instale Node 22.19 ou superior: https://nodejs.org (ou winget install OpenJS.NodeJS.LTS)"
  exit 1
}
& node (Join-Path $PSScriptRoot "status.mjs") @args
exit $LASTEXITCODE
