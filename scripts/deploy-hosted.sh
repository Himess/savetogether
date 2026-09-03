#!/usr/bin/env bash
#
# Deploy the hosted server, without the address being in this repository.
#
# The origin host lives in `probe/secrets.json` (git-ignored) as `hostedHost`,
# beside the deploy key. This repository is public and that box holds the keeper's
# key, the session keys and the hosted server; `survivorsbyashborn.com` is behind
# Cloudflare, so committing the origin would hand back the one thing Cloudflare
# provides.
#
# The old placeholder — `root@<vps>` — is not the alternative. That is what made a
# deploy cost twelve `ssh` probes to find one machine. The address is named in one
# git-ignored place and read from there.
#
#   npm run deploy:hosted
#
set -euo pipefail
cd "$(dirname "$0")/.."

SECRETS="probe/secrets.json"
if [ ! -f "$SECRETS" ]; then
  echo "!! $SECRETS not found. The origin host lives there as \"hostedHost\"."
  echo "   If you do not have that file you are not the operator of this deployment."
  exit 1
fi

HOST=$(node -e 'const s=require("./probe/secrets.json"); if(!s.hostedHost){console.error("hostedHost missing from probe/secrets.json");process.exit(1)} process.stdout.write(s.hostedHost)')
USER_AT=${HOSTED_SSH_USER:-root}

echo "== build =="
npm run build:packages

echo
echo "== copy =="
for p in sdk console mcp-server hosted; do
  scp -q -r "packages/$p/dist" "$USER_AT@$HOST:/opt/ghostpool/packages/$p/"
  scp -q "packages/$p/package.json" "$USER_AT@$HOST:/opt/ghostpool/packages/$p/package.json"
  echo "   $p"
done

echo
echo "== install and restart =="
ssh "$USER_AT@$HOST" 'cd /opt/ghostpool && npm install --omit=dev --no-audit --no-fund >/dev/null && systemctl restart ghostpool-hosted && sleep 3 && systemctl is-active ghostpool-hosted'

echo
echo "== verify FROM OUTSIDE =="
#
# From outside, not from the box, and not from the build log. Four deploys on this
# project went wrong in the gap between "the deploy succeeded" and "the thing a user
# opens changed", and every one of them looked fine from the inside.
#
# The tell to know: a 404 on a request with NO Authorization header means the OLD
# build is still running — the new one answers 401 there, because the route exists
# and is rejecting a missing credential. A 404 with a bogus Bearer token is correct:
# the header was read and the token was not found.
#
BASE="https://survivorsbyashborn.com/ghostpool"
noauth=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/session")
bogus=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer zzzz" "$BASE/api/session")
echo "   GET /api/session, no header      -> $noauth  (401 = new build, 404 = OLD BUILD STILL RUNNING)"
echo "   GET /api/session, bogus bearer   -> $bogus  (404 = header read, token rejected)"

if [ "$noauth" = "404" ]; then
  echo
  echo "!! The old build is still serving. The copy or the restart did not take."
  exit 1
fi

echo
echo "   Now open the site and check the network tab: no token may appear in any"
echo "   request path. That is the whole point of the header, and it is not"
echo "   provable from here."
