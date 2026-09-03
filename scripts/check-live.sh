#!/usr/bin/env bash
#
# Q1 — "deployed" is not "live at the address a judge opens".
#
# This project has shipped a fix to a URL nobody knew four times, in four
# different disguises. The failure is always the same shape: `vercel --prod`
# reports READY, and the canonical alias stays pinned to an older deployment, so
# every fix is live somewhere that is not the link in the README.
#
# `vercel --prod` does NOT move a pinned alias. It has to be moved explicitly:
#
#     npx vercel alias set <new-deployment-url> ghostpool-himess.vercel.app
#
# Run this after every deploy. It checks the alias target, and then checks the
# canonical URL actually serves the current build — because the alias pointing at
# the right deployment and the page rendering the right thing are two claims, and
# only the second one is the one that matters.
#
#     bash scripts/check-live.sh
#
set -uo pipefail

CANONICAL="ghostpool-himess.vercel.app"
cd "$(dirname "$0")/../frontend" || exit 1

echo "== 1. where does ${CANONICAL} point? =="
ALIAS_LINE=$(npx vercel alias ls 2>/dev/null | grep -F " ${CANONICAL} " || true)
if [ -z "$ALIAS_LINE" ]; then
  echo "  !! no alias row found for ${CANONICAL}"
  exit 1
fi
echo "  ${ALIAS_LINE}"

# The last column is the age of the ALIAS RECORD, not of the deployment it points
# at — an alias created six days ago and re-pointed today still reads "6d". The
# first version of this script warned on that column and cried wolf the moment it
# was working correctly. Compare the target against the newest production
# deployment instead; that is the thing being asserted.
TARGET=$(echo "$ALIAS_LINE" | awk '{print $1}')
LATEST=$(npx vercel ls --prod 2>/dev/null | grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | head -1 | sed 's#https://##')
echo "  alias target : ${TARGET}"
echo "  latest --prod: ${LATEST:-<could not read>}"
if [ -n "$LATEST" ] && [ "$TARGET" != "$LATEST" ]; then
  echo
  echo "  !! MISMATCH — the canonical URL is NOT serving the latest deployment."
  echo "     vercel --prod does not move a pinned alias. Move it:"
  echo "     npx vercel alias set ${LATEST} ${CANONICAL}"
  exit 1
fi
echo "  -> alias is on the latest production deployment"

echo
echo "== 2. is the canonical URL reachable? =="
CODE=$(curl -s -o /dev/null -w "%{http_code}" -L "https://${CANONICAL}")
echo "  HTTP ${CODE}"
[ "$CODE" = "200" ] || { echo "  !! not serving"; exit 1; }

echo
echo "== 3. does it serve the CURRENT build? =="
echo "  The app is client-rendered, so the HTML shell carries no copy and grep"
echo "  proves nothing. Open it in a browser and confirm, by eye:"
echo
echo "    - the sidebar lists 'Try to break it' and 'The brief'"
echo "    - Pool shows the accrual badge with a round number, once a wallet is connected"
echo "    - 'In the pool' reads ••• for a funded wallet, — for none, 0 only when truly empty"
echo "    - Authorise carries the setOperator explanation and vanishes once granted"
echo "    - Verify shows the 'Your thresholds / Your weight' panel with no wallet at all"
echo
echo "  https://${CANONICAL}"
echo
echo "  Not the build log. The page."
