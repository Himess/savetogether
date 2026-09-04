#!/usr/bin/env bash
#
# Is GitHub showing the code that is actually deployed?
#
# The same failure `check-live.sh` exists for, one layer out. That one compares the
# alias to the newest deployment; this compares GitHub to the local HEAD. Both fail
# silently and look fine: a stale alias serves an old page with a 200, and a stale
# remote serves an old repository with no error at all.
#
# It went wrong exactly this way: fifteen commits sat local while the published
# repository pointed at a pool address that had been replaced — and the brief makes
# the repository mandatory.
#
#   npm run check:pushed
set -euo pipefail
cd "$(dirname "$0")/.."

local_head=$(git rev-parse HEAD)
branch=$(git rev-parse --abbrev-ref HEAD)

git fetch -q origin "$branch" 2>/dev/null || true
remote_head=$(git rev-parse "origin/$branch" 2>/dev/null || echo "none")

echo "  local  $branch  ${local_head:0:8}"
echo "  origin $branch  ${remote_head:0:8}"

if [ "$remote_head" = "none" ]; then
  echo; echo "!! no origin/$branch — nothing has ever been pushed"; exit 1
fi

if [ "$local_head" = "$remote_head" ]; then
  behind=0
else
  behind=$(git rev-list --count "origin/$branch..HEAD")
fi

if [ "$behind" -eq 0 ]; then
  echo; echo "  GitHub matches HEAD."
else
  echo
  echo "!! GitHub is $behind commit(s) behind HEAD."
  echo "   Whoever opens the repository is reading superseded code — including the"
  echo "   deployed addresses, which change on every redeploy."
  echo "   git push origin $branch"
  exit 1
fi

# The repository is cited for specific files. A push that omits one is a push that
# looks fine and breaks a citation.
echo
echo "  files the docs point at, fetched from GitHub:"
for f in README.md LICENSE docs/NUMBERS.md docs/AUDIT-2026-09.md out/deployment.json; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -L --max-time 15 \
    "https://raw.githubusercontent.com/Himess/savetogether/$branch/$f")
  printf "    %s  %s\n" "$code" "$f"
  [ "$code" = "200" ] || { echo "  !! $f is not on GitHub"; exit 1; }
done
