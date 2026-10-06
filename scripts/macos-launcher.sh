#!/bin/bash
# Double-clicked from ONUS-Tools.app. Serves the bundled page and opens it.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVE="$ROOT/MacOS/onus-serve"
WWW="$ROOT/Resources/www"
PORT=4173
PID=""

cleanup() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [ ! -x "$SERVE" ] || [ ! -d "$WWW" ]; then
  osascript -e 'display alert "ONUS-Tools is missing its local files."'
  exit 1
fi

while [ "$PORT" -le 4190 ]; do
  "$SERVE" "$WWW" "$PORT" >/dev/null 2>&1 &
  PID=$!
  sleep 0.2
  if kill -0 "$PID" 2>/dev/null; then
    break
  fi
  PID=""
  PORT=$((PORT + 1))
done

if [ -z "$PID" ]; then
  osascript -e 'display alert "ONUS-Tools could not start its local server."'
  exit 1
fi

open "http://127.0.0.1:${PORT}/"
osascript <<'EOF'
display dialog "ONUS-Tools is open in your browser.

Leave this dialog up while you use it. Quitting stops the local page." buttons {"Quit"} default button 1 with title "ONUS-Tools"
EOF
