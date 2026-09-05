#!/usr/bin/env bash
# Confirm that what is committed locally is what the live site is serving.
#
#   scripts/check-live.sh              # landing page + tools.json match the working tree
#   scripts/check-live.sh <slug>       # ...and tools/<slug>/index.html is live and listed
#
# Polls for up to ~4 minutes (GitHub Pages usually publishes within 1-2 minutes
# of a push to main). Exit 0 when the live copies match the local files byte for
# byte, 1 on timeout. A cache-busting query string sidesteps the Pages CDN cache.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE="${SITE:-https://colinmccrae.github.io/mobile-playground}"
SLUG="${1:-}"
ATTEMPTS="${ATTEMPTS:-16}"     # x 15 s = 4 min
INTERVAL="${INTERVAL:-15}"

sha() { sha256sum "$1" | cut -d' ' -f1; }
live_sha() { curl -fsS --max-time 20 "$SITE/$1?nocache=$(date +%s%N)" | sha256sum | cut -d' ' -f1; }

files=(index.html tools.json)
[[ -n "$SLUG" ]] && files+=("tools/$SLUG/index.html")

for ((i = 1; i <= ATTEMPTS; i++)); do
  ok=1
  for f in "${files[@]}"; do
    [[ -f "$ROOT/$f" ]] || { echo "missing local file: $f" >&2; exit 1; }
    if [[ "$(live_sha "$f" 2>/dev/null || echo none)" != "$(sha "$ROOT/$f")" ]]; then
      ok=0; echo "  [$i/$ATTEMPTS] $f: live copy differs (or not yet published)"; break
    fi
  done
  if [[ $ok == 1 ]]; then
    echo "LIVE  $SITE/ matches the working tree${SLUG:+ (including tools/$SLUG/)}."
    [[ -n "$SLUG" ]] && echo "      $SITE/tools/$SLUG/"
    exit 0
  fi
  (( i < ATTEMPTS )) && python3 -c "import time; time.sleep($INTERVAL)"
done
echo "TIMEOUT: live site still differs after $((ATTEMPTS * INTERVAL)) s. Check the 'pages build and deployment' run on GitHub." >&2
exit 1
