#!/usr/bin/env bash
# Screenshot pages at phone + desktop sizes and report console errors.
#   scripts/preview.sh                  # local: landing page only
#   scripts/preview.sh epoch            # local: landing page + tools/epoch/
#   scripts/preview.sh --live epoch     # same checks on what the live site actually serves
# PNGs land in ${PREVIEW_DIR:-/tmp/mp-preview}/ (a live/ subfolder for --live).
# Exit code is non-zero if any page logged a console error, failed a request,
# or scrolls horizontally.
#
# --live does not point Chromium at the internet: the sandbox's egress proxy
# drops Chromium's TLS handshake (curl is fine). Instead every committed site
# file is downloaded from the live site with curl into a temporary mirror, and
# Chromium runs against that. For a static site this is equivalent.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8765}"
OUT="${PREVIEW_DIR:-/tmp/mp-preview}"
SITE="${SITE:-https://colinmccrae.github.io/mobile-playground}"
SERVE_DIR="$ROOT"

if [[ "${1:-}" == "--live" ]]; then
  shift
  SERVE_DIR="$(mktemp -d)"
  trap 'rm -rf "$SERVE_DIR"' EXIT
  echo "Mirroring live site into $SERVE_DIR"
  missing=0
  while IFS= read -r f; do
    mkdir -p "$SERVE_DIR/$(dirname "$f")"
    if ! curl -fsS --max-time 30 "$SITE/$f?nocache=$(date +%s%N)" -o "$SERVE_DIR/$f"; then
      echo "  not on live site: $f"; missing=1
    fi
  done < <(git -C "$ROOT" ls-files | grep -Ev '^(scripts/|\.github/|\.gitignore|CLAUDE\.md|README\.md|LICENSE)')
  [[ $missing == 0 ]] || echo "  (some committed files are not live yet; is the Pages build finished?)"
  OUT="$OUT/live"
fi

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SERVE_DIR" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; [[ "$SERVE_DIR" != "$ROOT" ]] && rm -rf "$SERVE_DIR"' EXIT
sleep 0.5

export NODE_PATH="${NODE_PATH:-}:$(npm root -g 2>/dev/null)"
export BASE_URL="http://127.0.0.1:$PORT"
export PREVIEW_DIR="$OUT"
node "$ROOT/scripts/preview.js" "$@"
