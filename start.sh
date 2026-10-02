#!/bin/bash
# hashes.space: build everything the first time, then run the dashboard.
#   ./start.sh                     demo miners (no hardware needed)
#   ./start.sh home                your own miners from backend/tenants.home.json + backend/miners.home.json
# Needs Node.js 20 or newer. Stop with Ctrl+C.
set -eo pipefail
cd "$(dirname "$0")"
export NG_CLI_ANALYTICS=false
if [ ! -f backend/dist/index.js ]; then
  echo "Building the backend…"; (cd backend && npm install --no-audit --no-fund && npm run build)
fi
if [ ! -f frontend/dist/frontend/browser/index.html ]; then
  echo "Building the web app (1 to 3 minutes the first time)…"; (cd frontend && npm install --no-audit --no-fund && npx ng build)
fi
PORT="${PORT:-8080}"
if [ "$1" = "home" ]; then
  [ -f backend/tenants.home.json ] || { echo "Copy backend/tenants.example-home.json to backend/tenants.home.json and fill in your node first."; exit 1; }
  [ -f backend/miners.home.json ] || { echo "Copy backend/miners.example-home.json to backend/miners.home.json and fill in your miners first."; exit 1; }
  KEY=$(node -e "console.log(require('./backend/tenants.home.json')[0].apiKey)")
  export TENANTS_FILE="$PWD/backend/tenants.home.json" MINERS_FILE="$PWD/backend/miners.home.json" SIMULATE_MINERS=false
else
  KEY=demo-key
fi
URL="http://localhost:$PORT/asic?token=$KEY"
echo; echo "hashes.space runs at $URL  (stop with Ctrl+C)"; echo
( sleep 3; (command -v open >/dev/null && open "$URL") || (command -v xdg-open >/dev/null && xdg-open "$URL") || true ) &
cd backend && PORT="$PORT" node --env-file-if-exists=.env dist/index.js
