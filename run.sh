#!/usr/bin/env bash
# Resonance piano — serve the web app on 0.0.0.0 (default port 9040).
#   ./run.sh [port]
# Web MIDI needs a secure context: use http://localhost:PORT on this machine,
# or put an HTTPS reverse proxy in front of it for other devices.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-9040}"
if systemctl --user is-active --quiet resonance-piano.service && [ "$PORT" = 9040 ]; then
  echo "resonance-piano.service already serving on :9040 (systemctl --user restart resonance-piano to restart)"
  exit 0
fi
echo "Resonance piano → http://0.0.0.0:$PORT/  (local: http://localhost:$PORT/)"
exec node "$DIR/serve.mjs" --root "$DIR" --host 0.0.0.0 --port "$PORT"
