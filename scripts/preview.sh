#!/usr/bin/env bash
# Serve the repo locally and screenshot pages at phone + desktop sizes.
#   scripts/preview.sh              # landing page only
#   scripts/preview.sh epoch        # landing page + tools/epoch/
# PNGs land in ${PREVIEW_DIR:-/tmp/mp-preview}/. Exit code is non-zero if any
# page logged a console error, failed a request, or scrolls horizontally.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8765}"

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 0.5

export NODE_PATH="${NODE_PATH:-}:$(npm root -g 2>/dev/null)"
export BASE_URL="http://127.0.0.1:$PORT"
node "$ROOT/scripts/preview.js" "$@"
