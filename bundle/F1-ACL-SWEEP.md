# F1 — the under-granting sweep, and F3's fresh-wallet run

> **SUPERSEDED BY A REDEPLOY — 4 September 2026.** Every transaction hash below is
> against the pool at 0xa9B69Dc9F9f4C4512c926ba9eA432eBcF0026631, which is no longer the live
> pool. The findings stand as a record of what was measured there; the hashes are
> history rather than pointers. The cycle was re-run against
> `0x894F6492357277CF36e9973787663AE9F73387BE` and the fresh results are in
> `out/d1-cycle.json`, `out/f3-fresh-wallet.json` and `out/f1-acl-sweep.json`.
>
> One finding here is CLOSED rather than merely restated: `pendingOf` was unreadable
> by its own owner, and on the redeployed pool the same sweep reports it READABLE.

AA1 searched for handles granted to too many readers. Nothing had ever searched the other
direction. `pendingOf` surfaced only because a coincidence that had been masking it ended,
so the question was whether the same coincidence still masks others.

Measured on Sepolia, **2026-09-03**, by decrypting every externally-readable handle rather
than by reading the source. `scripts/f1-acl-sweep.ts`, raw output `out/f1-acl-sweep.json`.

---

## The sweep

Ten handles probed as the account that is meant to read them. **Four readable, five not,
one uninitialised.**

| contract | getter | intended reader | result |
|---|---|---|---|
| `ConfidentialPrizePool` | `confidentialBalanceOf(me)` | the holder | ✅ readable — `12291000000` |
| `ConfidentialPrizePool` | `winningsOf(me)` | the holder | ✅ readable — `41000000` |
| `ConfidentialPrizePool` | `weightFor(35, me)` | the holder | ✅ readable — `4129440000000` |
| `ConfidentialPrizePool` | `cumulativeAt(me, t)` | the holder | ✅ readable — `1121217552000000` |
| `ConfidentialPrizePool` | **`pendingOf(me)`** | **the holder** | ❌ **NOT READABLE** |
| `ConfidentialPrizePool` | `reserveHandle()` | unclear — no caller | ❌ not readable |
| `SteakhouseReplicaSource` | `principal()` | unclear — in the ABI | ❌ not readable |
| `SteakhouseReplicaSource` | `pending()` | unclear — in the ABI | ❌ not readable |
| `SteakhouseReplicaSource` | `inVault()` | unclear — in the ABI | ❌ not readable |
| `SaveTogetherSession` | `remainingOf(me, cUSDC)` | owner + session key | — uninitialised for this signer |

`SaveTogetherSession` is **clean by construction**. Every write path grants both readers
explicitly — `openSession` (`:172-174`) grants the budget to owner and session key,
`send` (`:267-275`) grants `newRemaining`, `within` and `sent` to both, `increaseBudget`
(`:304-306`) grants `updated` to both. It is the only one of the three contracts that
does this consistently, and it is the model the others should follow.

## Exactly one of the five is a live defect

**`pendingOf` — reachable, and it throws.**

`packages/sdk/src/pool.ts:118-132` builds a lazy resolver over the handle:

```ts
pending: await mk(await pool.pendingOf!(me), "sent"),
// mk -> attachResolver(r, () => userDecrypt(fhevm, sessionKey, handle, poolAddress))
```

`AmountExpr` is documented as *"Resolved to a plaintext for encryption"*, so the reference
is decrypted the moment it is used as an amount. The reachable path is:

```
pool_position          -> returns pend_1 as an opaque reference   (no decrypt — fine)
pool_deposit(pend_1)   -> exprFor -> ref -> revealAmount -> userDecrypt -> THROWS
```

So *"put my pending winnings into the pool"* fails through the conversational layer. The
tool description invites exactly that: *"Pass any of them to pool_deposit or
pool_withdraw."*

**And it is universal, not an edge case.** F3 confirmed it from a key that had never
touched the pool: `pendingOf(self)` was already unreadable after that wallet's first
`accrue`. `accrue` writes `nextPending = tryAdd(_pending[user], paid)` on **every**
participant every draw, winner or loser, and grants it only to the contract. There is no
state in which a depositor can read their own pending credit.

The pre-flight read of `40 cUSDC` was the coincidence: while `_pending` and `_winnings`
had accumulated the identical sequence from zero, `tryAdd` produced the **same handle**
for both, and the `FHE.allow(nextWinnings, user)` grant covered it. The first `_drain`
set `_pending` to a fresh zero handle, the two diverged, and the accident ended.

**The other four are dead getters, not defects.** `reserveHandle()` has no caller anywhere
in the repository. `principal()`, `pending()` and `inVault()` sit in `VAULT_SOURCE_ABI`
(`frontend/lib/abis.ts:85-86`) but the Vault screen reads only `rateBps`, `grandPrize`,
`openBatches` and `openRedeems`. `scripts/prove-vault-composition.ts` and
`test/replica-source.ts` call `principal()` only to assert the handle is non-zero — they
never decrypt it, which is why no test caught any of this.

**No coincidence is currently masking anything else.** The four readable handles are all
readable because of an explicit `FHE.allow` naming the reader — `_push` (`:407-408`),
`cumulativeAt` (`:484`), `weightFor` (`:685`), `accrue` (`:896`) — not by handle identity.

---

## The redeploy decision, with the numbers

The fix is two lines:

```solidity
FHE.allow(nextPending, user);      // accrue, alongside the winnings grant at :896
FHE.allow(_pending[user], user);   // _drain, alongside allowThis at :1012
```

**Against redeploying:** the live pool carries 36 draws of history, 6 depositors and the
D1/F3 evidence — twelve and nine transaction hashes respectively, all of which point at
this address. A redeploy invalidates every hash in `D1-LIVE-CYCLE.md` and
`STATE-NOW.md`, resets `drawCount`, and the first draw after a deploy is the one the
README already documents as unable to pay.

**For redeploying:** it is a genuine broken path in a shipped surface, and it is two lines.

**There is a third option, and it is probably the right one.** The defect is only reachable
because the SDK exposes `pending` as a resolvable reference. It is fixable without touching
the chain:

- drop `pending` from `PoolClient.position()`, or
- keep it and attach no resolver, so it surfaces as `BalanceNotVisibleError`
  (`amounts.ts:68` already throws that for an unresolvable ref) rather than as a raw
  decryption failure, and
- amend the `pool_position` description so it stops inviting `pend_N` as a deposit amount.

That closes the reachable failure today, in TypeScript, with no redeploy and no invalidated
hashes — and it leaves the contract-level gap as a documented limitation with a named fix,
which is what this project does with limitations it has measured and chosen not to close.

**Recommendation: take the third option now, and fold the two contract lines into the next
redeploy if one happens for another reason.** The sweep found nothing else that would
justify a redeploy on its own, so there is currently no other reason.

A test should exist either way: decrypt `pendingOf` as its owner after a deposit, a
withdrawal and a claim. It would have caught this, and nothing in the 190-test suite does,
because every existing check on these handles asserts non-zero rather than decrypting.

---

## F3 — the cycle from a wallet with no privileges

D1 ran as the deployer, which is also the owner and the keeper. F3 generated a key that had
never existed, funded it with gas and cUSDC and nothing else, and ran the depositor's path
from it. `scripts/f3-fresh-wallet.ts`, raw output `out/f3-fresh-wallet.json`.

**Fresh wallet `0x93e8195537e624B15c3993e0f448B260FddefB62`** — nonce 0 at the start,
`owner() == fresh` is `false`.

| # | the depositor's transactions | hash |
|---|---|---|
| 1 | `setOperator(pool)` | [`0x172cf290…df90`](https://sepolia.etherscan.io/tx/0x172cf290627890fa8a0c3766d43bc5b0bd207dbde5c284938aab5460ddcbdf90) |
| 2 | **deposit** 200 cUSDC | [`0xda54ff98…df00`](https://sepolia.etherscan.io/tx/0xda54ff98d06224cd5dc8a19ac9111eb61d04a132bb8286c78aa2bb7b9fd2df00) |
| 3 | **accrue(self)** | [`0x9bc7d336…afaa`](https://sepolia.etherscan.io/tx/0x9bc7d3367ced0a4789519bd92fd848d80b9f9b6af1c98bc863b23d4f00d9afaa) |
| 4 | **claim(self)** | [`0x784318c1…93a9`](https://sepolia.etherscan.io/tx/0x784318c14ad480d5d594636773431dc33715d0145670f65ad9ab6b7cea6193a9) |
| 5 | **withdraw** 120 cUSDC | [`0x97d5e778…15fb`](https://sepolia.etherscan.io/tx/0x97d5e778cb21550c9ed9727ba8d1ccda7be6bdc03543f132a751ff285eea15fb) |

Funding, from the deployer: gas [`0x9c7462ab…c2ec`](https://sepolia.etherscan.io/tx/0x9c7462ab2c0c834ee9920afa38f31a5439388d8eef1ad17aeeb35add1310c2ec),
cUSDC [`0xbe027482…fffc`](https://sepolia.etherscan.io/tx/0xbe0274827b6630cdf4c879202d3c75ed0fb3aa68ece5c6b08e69b9bb536fffcc).
Draw 36 was opened by the keeper — a depositor does not open draws — at
[`0x507de1a5…c5a4`](https://sepolia.etherscan.io/tx/0x507de1a5accbb1d87eb9f12a2ed137dd249387e283c829803ebf37b71278c5a4),
revealed at [`0x20d83358…e9f7`](https://sepolia.etherscan.io/tx/0x20d833582043d94c3ac364925ac1c312d00390a019e4489fba3225f732a8e9f7).

Balances, decrypted with the fresh wallet's own key:

```
funded         300 cUSDC, 0.05 ETH
after deposit  position 200
draw 36        totalWeight 18297432000000  ordinaryThreshold 11729126579947  -> did not win
after claim    position 200   (nothing pending; the no-op path, correctly)
after withdraw position  80   wallet 220     (300 - 200 + 120 = 220, exact)
```

**`accrue` and `claim` were sent by the fresh wallet for itself**, which is the
permissionlessness the design claims, now demonstrated rather than argued. D1's open item —
*"it proves the paths work; it does not prove they work for an address with no
privileges"* — is closed.

The fresh wallet did not win draw 36, so `claim` was again a no-op from that key. The
value-moving `claim` is still the deployer's `0x42743cf9…e3e0`, where position went
12290 → 12291 against a 1 cUSDC tier-2 prize.

---

## F2 — the unwrap now has state on screen

`frontend/components/screens/Wrap.tsx`. The screen debited the cUSDC, said the USDC
"arrives when it settles", and then showed an unchanged balance — which reads as a failure
rather than a queue.

It now records the request in `localStorage` at submission time (amount, timestamp, hash,
and the USDC balance as a baseline), polls every 20 s, and clears itself when the balance
rises by at least the requested amount. While pending it says what is actually true: the
cUSDC is debited, the USDC has not arrived, settlement is `finalizeUnwrap` with a KMS proof
sent by Zama's operator on no fixed schedule, and nothing is lost while waiting. Storage
access is wrapped in try/catch so a private window degrades to a non-persistent panel
rather than throwing.

Frontend only, no redeploy. `npx tsc --noEmit` clean.

**The measurement that motivated it:** the D1 unwrap
([`0xe751fbf5…678a`](https://sepolia.etherscan.io/tx/0xe751fbf5d4bada982b2c3340fecee10f62f39ef56b9c34742853919e3345678a),
100 cUSDC) was still unsettled **1 h 20 min** later — USDC delta exactly `0.0`. Sixteen
unwraps did complete on that wrapper in the scanned window, including 2,091 USDC to a third
party, so it is latency rather than breakage. It is still latency the user could not see.
