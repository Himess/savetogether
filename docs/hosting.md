# Where the hosted server runs, and why it is not serverless

**Public endpoint: `https://survivorsbyashborn.com/ghostpool`**

> **The path says `ghostpool` and the product is called SaveTogether.** That is not
> an oversight. This path, `/opt/ghostpool`, and the `ghostpool-hosted` and
> `ghostpool-keeper` units are **addresses**: every MCP URL handed to a Claude
> connector so far points at this one, and renaming it would break each of them to
> change a string nobody reads. The site, the deck and the docs say SaveTogether;
> the plumbing keeps the name it was built under.

Stable, on a VPS, under systemd with `Restart=always` and `enabled` at boot. No
tunnel, no laptop, no build-time URL to keep in sync.

## Why not Vercel

Measured, not assumed:

| step | time |
| --- | --- |
| `prepare` — one FHE input proof | 13 s locally, 22 s on the VPS |
| `pool_deposit` — two proofs plus three Sepolia confirmations | **70–90 s** |

Vercel's serverless ceiling is 60 seconds. A deposit does not fit, and no amount
of tuning changes that: the time is an FHE proof and three block confirmations,
neither of which is ours to speed up. The MCP endpoint has to be a long-lived
process, so it is one.

The frontend stays on Vercel. Only the server moved.

## The server holds nothing

The bearer token in the MCP URL **is** the session record — an AES-256-GCM sealed
blob containing the session key, the owner, the expiry, the read scope and the
token list, at 146 characters. There is no database and no key file.

Three consequences, and the third is the one that matters:

1. A restart costs nothing. Verified: `systemctl restart ghostpool-hosted`, and a
   URL issued before it still works.
2. The server can be moved to another host by copying one environment variable.
3. **With no record to mark closed, every request asks the chain whether the
   session is still live.** Revocation therefore takes effect immediately and
   without this server being told, which is what the owner was promised.

`SAVETOGETHER_MASTER_KEY` lives in `/opt/ghostpool/.env` at mode 600 and nowhere
else. It is not generated at boot — that was the earlier design, and a key that
changes on restart silently invalidates every URL a user has pasted into a chat
client. The server refuses to start without one and tells you how to make it.

## Layout

```
/opt/ghostpool/                     the built packages, no sources
/opt/ghostpool/.env                 master key, RPC, public URL, CORS allowlist
/etc/systemd/system/ghostpool-hosted.service
/etc/nginx/sites-enabled/survivors  one added `location /savetogether/` block
```

nginx proxies to `127.0.0.1:8787` with `proxy_read_timeout 300s`, because the
default 60 would cut a deposit off mid-transaction. The config was tested with
`nginx -t` before reload and the existing site was verified still serving 200
afterwards; a backup of the vhost sits in `/root/`.

## CORS is an allowlist, not a wildcard

Two origins exist, so they are named:

```
Origin: https://ghostpool-himess.vercel.app  ->  access-control-allow-origin: https://ghostpool-himess.vercel.app
Origin: https://evil.example                 ->  (no header)
```

The MCP route carries no CORS at all, on purpose. It is fetched by a chat
client's servers rather than by a browser — which is also why `localhost` could
never have worked, and why a public HTTPS endpoint was not optional.

## Redeploying

```
npm run deploy:hosted
```

**The origin host is not in this repository, and that is deliberate.** It lives in
`probe/secrets.json` (git-ignored) as `hostedHost`, beside the deploy key. If you do
not have that file, you are not the operator of this deployment.

This repository is public and that box holds the keeper's key, the session keys and
the hosted server. `survivorsbyashborn.com` is behind Cloudflare, so publishing the
origin hands back the one thing Cloudflare provides — and it would do so during the
window when the service most needs to stay up. The address was briefly written here
after a deploy and removed for that reason; it never reached a commit.

The previous placeholder — `root@<vps>`, and `root@HOST` in `keeper-deploy.md` — is
not the fix either: it is what made the last deploy cost twelve `ssh` probes to
identify one machine. Naming *where the address lives* is the difference. The script
reads it, so nobody has to know it by heart.

Verify from outside afterwards, not from the box:

```
curl -o /dev/null -w "%{http_code}
"   -H "Authorization: Bearer zzzz" https://survivorsbyashborn.com/ghostpool/api/session
# 404 = the route exists and rejected the token. 401 = no header. 404 on a
# no-header request means the OLD build is still running.
```

Existing MCP URLs survive it, as long as `.env` is left alone.

### The rule is not remote, and it is not about `ssh`

The same check applies to `npm run dev` and `next start` on this laptop, and skipping
it there cost a long debugging session: a countdown "would not render", and the cause
was `EADDRINUSE`. `pkill` had not killed the first server, every later `next start`
died on the port, and the browser kept being served a build from twenty minutes
earlier. Everything looked fine — the build said `✓ Compiled successfully`, the start
command printed nothing, the page returned 200 — and every one of those was true
about the *wrong bytes*.

**The check is not "did the command report success". It is "did the bytes change".**

Report-success and bytes-changed come apart in every direction: a build can succeed
and not be served, a restart can fail silently and leave the old process answering,
an alias can stay pinned to a previous deployment. So verify against the artefact a
user actually receives:

```bash
# does the SERVED bundle contain the thing you just wrote?
curl -s http://localhost:3111/_next/static/chunks/<chunk>.js | grep -c '<a string only the new code has>'
```

Pick a string that did not exist before the edit. On a port that will not free
itself, take the PID from `netstat -ano | grep ':3111.*LISTENING'` and stop it by
id rather than trusting `pkill`, which does not reliably match node processes on
Windows.

## Still worth doing

The endpoint sits under another project's domain because adding a subdomain needs
a DNS record in Cloudflare, which this session had no access to. One `A`/`CNAME`
record for something like `pool.ghostrail.xyz` pointed at the same host, plus a
`server_name` line, would move it — the origin certificate is Cloudflare's and
already covers a wildcard.
