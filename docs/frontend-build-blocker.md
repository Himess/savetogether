# The frontend does not build here, and it is not our code

**Status: open. Pre-existing, not introduced by the hosted work.** The already
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
