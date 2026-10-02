#!/usr/bin/env sh
# Wrapper: equivale a `npm run start`. Uso: ./scripts/start.sh [opções]
DIR="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js não encontrado. Instale Node >= 22.19 (https://nodejs.org ou nvm install --lts)." >&2
  exit 1
fi
exec node "$DIR/start.mjs" "$@"
