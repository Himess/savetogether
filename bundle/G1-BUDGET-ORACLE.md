# G1 — `can_afford` was a budget oracle. Measured, then closed.

The description read:

> Yes or no. **Leaks neither the budget nor anything else** — prefer this over revealing a
> number when the user only needs to know whether something fits.

True of one call. False of a sequence, and the sequence was free.

---

## The measurement

`test/g1-can-afford-oracle.ts`, seven cases, in the suite. It runs the search against the
real predicate — `left >= amount`, monotone, no counter, no cooldown, no log.

| | |
|---|---|
| Budget used | `4_237_512_345` = **4,237.512345 cUSDC**, deliberately not round |
| Search range assumed | 0 … 1,000,000 tokens |
| **Calls to recover it exactly** | **40** |
| Calls over the whole `uint64` range | 64 |
| Hosted rate limit | 60 / minute (`packages/hosted/src/server.ts:46`) |
| Local stdio server | **no limit at all** |

**40 calls against a 60-per-minute allowance.** The attack completes inside a single
window without ever feeling the limit. On the local server there is nothing to feel.

This also reframes the screenshot. The model **declined** to binary-search, unprompted,
and nothing stopped it. That was a property of the model, not of the system.

## Which mitigation, and why

Both were implemented far enough to compare.

**Counting probes and refusing past a threshold** turns a fast attack into a slow one. The
signal survives; patience recovers it. And the threshold has to bite before 40 calls to
work at all, which is low enough to break ordinary use — a user comparing a few amounts
across a session hits it honestly.

**Coarsening removes the signal.** The answer is computed against the budget rounded
**down** to a bucket, so every budget inside one bucket answers identically to every probe.
No number of calls separates them, because there is nothing left to separate.

**Shipped: coarsening.** `COARSE_BUCKET = 50_000_000` — 50 tokens at six decimals.

```
recovered 4200000000 instead of 4237512345
37.512345 cUSDC still hidden, bucket 50 cUSDC, 40 calls
budgets 4200000000 and 4249999999 answer identically to every probe
```

The search still terminates — it just lands on the bucket floor and stops. The residue is
never disclosed.

**Rounding down, not to nearest**, and that direction is the safety argument: a coarse
answer can refuse something the owner could actually afford, but it can never approve
something that would then fail on chain. An over-promising oracle would be worse than the
leak it fixed. Pinned by a test over 400 budgets.

A budget below one bucket coarsens to zero and the tool answers "no" to everything, which
discloses only that the remainder is under 50 — not a figure.

## The description now says what is true

> Yes or no, answered against the remaining budget rounded **DOWN** to the nearest 50
> tokens. […] One call tells you one bit and never the figure. Repeated calls tell you the
> bucket and stop there — every budget inside the same 50 answers identically, so narrowing
> further is not possible rather than merely discouraged. Because the rounding is downward a
> yes is always a real yes, and a no near the boundary may still go through if sent: it means
> "not within the budget as measured", not "you cannot afford this". Do not use this tool to
> search for the balance.

The refusal text carries the same caveat, so a user who hits the residue is told why rather
than being told they are broke.

## The sweep for the same shape

An oracle is a **free, repeatable predicate over an encrypted value, parameterised by the
caller**. All seventeen tools checked against that definition.

| tool | shape | verdict |
|---|---|---|
| `can_afford` | free predicate, caller-chosen amount | **was an oracle — fixed** |
| `send` | predicate, but distinguishes `over-budget` from `insufficient-balance` | **priced oracle** — one on-chain transaction per bit, and the recipient must already be allowlisted. 40 transactions and 40 gas payments to do what `can_afford` did for nothing. Left as is: the price *is* the defence, and collapsing the two outcomes would make legitimate failures undiagnosable. |
| `pool_deposit`, `pool_withdraw` | same | same — priced, one transaction per probe |
| `balance`, `remaining`, `pool_position` | return opaque references; `reveal` needs a console click **every call** (`revealRef` calls `console.ask` with no caching, and hosted refuses outright) | not oracles — human-gated and not parameterised by an amount |
| `list_assets`, `session_status`, `pool_status`, `vault_status` | public chain data | not oracles |
| `open_session`, `add_recipient`, `revoke_all`, `wrap`, `unwrap`, `vault_join` | actions, no predicate returned | not oracles |

**One free oracle existed. It is closed. Three priced ones remain and are documented as
priced rather than removed.**

## One thing worth stating plainly

`canAfford` always decrypted the budget to answer it — `SessionClient` holds the exact
figure either way. The leak was never in the cryptography; it was in the *shape of the
answer* crossing the MCP boundary. That is why the fix is a bucket and not a cipher, and it
is the row the F6 matrix needs: **the session client sees the exact budget; the model now
sees a bucket floor and cannot narrow past it.**

---

# G2 — `pendingOf`, the third option taken

**No redeploy.** `PoolClient.position()` now hands out `pending` **without a resolver**, so
using it as an amount raises `BalanceNotVisibleError` — the SDK's own word for "this number
is not yours to see" — instead of a raw decryption failure from deep inside the relayer.

The `pool_position` description no longer invites it:

> Pass **the first two** to pool_deposit or pool_withdraw. The third — pending — is a
> reference **NOBODY can resolve, including the holder**: the pool never grants its owner
> permission to read that handle, so it is reported for completeness and cannot be spent or
> revealed. Using it as an amount fails.

The two Solidity lines stay recorded in `bundle/F1-ACL-SWEEP.md` for the next redeploy. The
sweep found no other reason for one.

## The test that should have existed

`test/g2-pending-acl.ts`. The gap was never the ACL — it was that **every existing check on
an encrypted getter asserts the handle is non-zero**:

```ts
const held = await source.principal!();
expect(held).to.not.equal(ethers.ZeroHash);     // test/replica-source.ts:83
```

A non-zero handle proves a value was written. It proves nothing about who may read it, and
who may read it is the entire security surface of an ACL. The same blind spot covers
`reserveHandle()`, `principal()`, `pending()` and `inVault()`.

The new tests **decrypt**. And writing them turned up something the sweep had only inferred:
the coincidence is now asserted directly, then watched to collapse.

```ts
// Before any drain, `_pending` and `_winnings` have accumulated the identical
// sequence from zero, so `tryAdd` produced the SAME handle for both.
const sharedHandle = (await pool.pendingOf(alice)) === (await pool.winningsOf(alice));
expect(sharedHandle, "before any drain the two handles coincide").to.equal(true);

await deposit(alice, 1n * U);          // deposit drains; the handles diverge here
expect(await readable(await pool.pendingOf(alice), pool, alice)).to.be.null;
```

That first assertion is the finding, executable. It also explains why no local test could
have caught this by accident: on a pool where nobody has drained yet, `pendingOf` is
genuinely readable, and the defect only appears after the first `_drain`.

A skipped test sits beside it asserting the **fixed** behaviour, to be enabled the moment
the two lines ship. The current-behaviour test is written to fail if the fix lands silently,
so the pair cannot both be true.

## Suite

**200 passing, 1 pending** — 106 pool (was 96, +10) and 94 session (unchanged). Both new
files are wired into `npm run test:pool`.

The README badge said 176, then 190. It now says neither; D17 will set it to 200.
