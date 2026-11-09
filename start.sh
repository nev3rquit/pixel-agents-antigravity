#!/usr/bin/env bash
# Launcher Linux/macOS di AziendaAI (equivalente di start.vbs):
# avvia il server in background e apre la dashboard nel browser.
# Uso: ./start.sh            -> avvia e apre il browser
#      ./start.sh --headless -> avvia senza aprire il browser
set -euo pipefail

cd "$(dirname "$0")"
PORT=3000

# Chiude eventuali vecchie istanze in ascolto sulla porta 3000
# (lsof prima: e' presente su macOS, dove fuser non supporta -k/porte TCP)
if command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -t -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
elif command -v fuser >/dev/null 2>&1; then
  fuser -k -TERM "${PORT}/tcp" >/dev/null 2>&1 || true
fi
sleep 0.5

nohup node server.js >server.log 2>&1 &
echo "AziendaAI avviato (PID $!) su http://localhost:${PORT} - log in server.log"

if [ "${1:-}" != "--headless" ]; then
  sleep 1.5
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:${PORT}" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then
    open "http://localhost:${PORT}"
  fi
fi
