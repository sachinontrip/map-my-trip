#!/bin/bash
# Double-click to open Map My Trip in Chrome. Keep this window open while you work; close it to stop.
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
open_app() { open -a "Google Chrome" "$1" 2>/dev/null || open "$1"; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org and double-click this file again."
  read -r -p "Press Enter to close…"
  exit 1
fi

# Reuse a server that really serves Map My Trip; skip ports held by anything else
# (e.g. an old server started from where this folder used to be).
for PORT in 5199 5198 5197 5196 5195; do
  URL="http://localhost:$PORT"
  if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    if curl -s -m 3 "$URL/" | grep -q "<title>Map My Trip</title>"; then
      echo "Map My Trip is already running."
      open_app "$URL"
      exit 0
    fi
    continue
  fi
  break
done

PORT=$PORT node serve.cjs &
SERVER=$!
sleep 1
open_app "$URL"
echo ""
echo "✈  Map My Trip is running at $URL"
echo "   Keep this window open while you work. Close it (or press Ctrl+C) to stop."
wait $SERVER
