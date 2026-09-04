#!/usr/bin/env bash
#
# The deck is authored at frontend/savetogether-deck.html and SERVED from
# frontend/public/deck.html. Two copies drift, so this is the only way the second
# one is allowed to change, and `npm run build:deck` is the only thing that runs it.
set -euo pipefail
cd "$(dirname "$0")/.."
cp frontend/savetogether-deck.html frontend/public/deck.html
echo "deck.html synced from savetogether-deck.html"
