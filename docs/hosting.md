# Where the hosted server runs, and why it is not serverless

**Public endpoint: `https://survivorsbyashborn.com/ghostpool`**

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

`GHOSTPOOL_MASTER_KEY` lives in `/opt/ghostpool/.env` at mode 600 and nowhere
else. It is not generated at boot — that was the earlier design, and a key that
changes on restart silently invalidates every URL a user has pasted into a chat
client. The server refuses to start without one and tells you how to make it.

## Layout

```
/opt/ghostpool/                     the built packages, no sources
/opt/ghostpool/.env                 master key, RPC, public URL, CORS allowlist
/etc/systemd/system/ghostpool-hosted.service
/etc/nginx/sites-enabled/survivors  one added `location /ghostpool/` block
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
npm run build:packages
# copy packages/{sdk,console,mcp-server,hosted}/{package.json,dist} to /opt/ghostpool
ssh root@<vps> "cd /opt/ghostpool && npm install --omit=dev && systemctl restart ghostpool-hosted"
```

Existing MCP URLs survive it, as long as `.env` is left alone.

## Still worth doing

The endpoint sits under another project's domain because adding a subdomain needs
a DNS record in Cloudflare, which this session had no access to. One `A`/`CNAME`
record for something like `pool.ghostrail.xyz` pointed at the same host, plus a
`server_name` line, would move it — the origin certificate is Cloudflare's and
already covers a wildcard.
