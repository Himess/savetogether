# The frontend does not build ON WINDOWS, and it is not our code

**Status: RESOLVED as a blocker. Linux builds it clean.** Vercel compiled and
deployed the same commit in 32 seconds, so the failure is specific to this
Windows machine and never reached the product. Everything below is kept as the
record of what was eliminated, and because the bare-layout reproduction is still
worth reporting upstream. The already
deployed site at ghostpool-himess.vercel.app is unaffected; what is blocked is
shipping a NEW frontend build, which the hosted session panel needs.

```
Error occurred prerendering page "/_global-error"
Error [InvariantError]: Invariant: Expected workStore to be initialized.
                        This is a bug in Next.js.
Export encountered an error on /_global-error/page: /_global-error, exiting the build.
```

## What was ruled out

Each of these was tested by building, not by reasoning about it.

| hypothesis | result |
| --- | --- |
| the new `HostedSession` component | fails with it removed from `App` |
| our custom `app/global-error.tsx` | fails with the file deleted — Next's own default page fails too |
| `export const dynamic = "force-dynamic"` on the root layout | fails without it |
| the wallet / FHE provider tree | fails with `<Providers>` bypassed |
| anything at all in the root layout | fails with a bare layout: no imports, no metadata, no CSS |
| Next 16.2.10 | fails |
| Next 16.2.12 | fails |
| React 19.0.0 | fails |
| React 19.2.8 | fails |
| `turbopack: { root: … }` in `next.config.mjs` | fails without it |
| the webpack builder (`next build --webpack`) | fails differently — a dependency chain through `@wagmi/connectors` → `@base-org/account` → `@coinbase/cdp-sdk` |

A layout containing nothing but `<html><body>{children}</body></html>` and no
imports still fails, which places the fault inside Next's synthesized
`/_global-error` route rather than anywhere in this application.

## What is not affected

- the contracts, and the live pool
- `@ghostkey/sdk`, `@ghostkey/mcp-server`, `@ghostkey/hosted` — all build, 132 tests pass
- the hosted server, proved end to end on Sepolia in `spikes/out/hosted-e2e.json`
- the deployed site, which was built before this appeared

## What to try next

1. **Build it somewhere else.** Vercel's builders run Linux; this is Windows, and
   the webpack failure above is also a Windows-flavoured resolution problem. A CI
   build would say in ten minutes whether this is environmental.
2. Next 16.3.x — untested here because it is a minor bump and the session had a
   working local path to protect.
3. Report it upstream with the bare-layout reproduction, which is small enough to
   be a useful bug report.

`frontend/components/HostedSession.tsx` is written, typechecks, and is wired into
`App`. It is not deployed, and this file exists so that is a stated fact rather
than something a reader discovers.

---

## Resolved: it builds on Linux

```
Vercel  Build Completed in /vercel/output [32s]   READY
```

Deployed to production and verified in a real browser at
**https://ghostpool-himess.vercel.app** — the session panel renders, and the page
reaches the hosted server cross-origin and completes a full `prepare`:

```
health           { ok: true, chainId: 11155111 }
prepare          4 calls for the wallet
  0x1bbBE55d…    setOperator on gUSDC
  0xE5c667c0…    openSession on the module
  0xf0Ffdc93…    delegateForUserDecryption on the ACL
  0x688a0691…    a value transfer, so the session key can pay for itself
```

Everything up to the wallet signature is confirmed working from the deployed
page. The signature itself needs a person, which is the one step that cannot be
automated and should not be.

So this was a Windows-only build failure. Worth keeping the elimination table
anyway: the next person to hit it will otherwise spend the same hour proving it
is not their component, their error page, or their React version.

## What is genuinely still open: a permanent home for the server

The MCP endpoint has to be publicly reachable over **HTTPS**, because Claude's
custom connector is fetched by Anthropic's servers rather than by the user's
browser — `localhost` can never work, and that is a fact about the product's
shape rather than a deployment detail.

Today it runs locally behind a `cloudflared` quick tunnel, which is fine for a
demo and wrong for a submission: the URL changes on every restart, and the
frontend bakes it in at build time.

Two ways to fix it properly, and the second is better:

1. **Host the server somewhere long-lived.** It is an ordinary Node HTTP server.
2. **Make the session token stateless and run it as functions.** The store exists
   only to hold a sealed session key and a little metadata; if the bearer token
   *is* the sealed record, there is no store, no key file, and nothing to persist
   — the chain is already the authority on whether a session is live. That would
   also let the whole thing live inside the Next app as route handlers on one
   origin, which removes the CORS surface and the build-time URL together.
