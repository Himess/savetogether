# The brief, answered

Every requirement, with **where it lives in the code**, **which test pins it**, and **a
transaction on Sepolia that shows it happening**.

Two rules make this worth reading rather than a checklist anyone could write:

1. Where a line is met **differently**, the row says so and gives the reason. Prize
   distribution is the first such entry — the brief asks for a confidential transfer, and
   using one would defeat the requirement it sits under.
2. Where a line is met with a **known limitation**, the row links the limitation instead of
   claiming the line clean.

The same table is on the site under **The brief · answered**. Twenty-one transactions
across two live runs fill the *shown by* column: twelve from
[`scripts/d1-cycle.ts`](../scripts/d1-cycle.ts) and nine from
[`scripts/f3-fresh-wallet.ts`](../scripts/f3-fresh-wallet.ts), both reproducible.

Everything below was measured on **2026-09-03**. Contracts:
pool `0xa9B69Dc9F9f4C4512c926ba9eA432eBcF0026631`,
source `0xDa596e47029839eA7E1990f97F106fd6d2e33695`,
session `0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6`.

---

## 1. The required cycle

> *Do deposit, draw, claim and withdraw produce the expected results onchain?*

| requirement | where | pinned by | shown by | |
|---|---|---|---|---|
| **Deposit** | `ConfidentialPrizePool.deposit` | `ConfidentialPrizePool.ts`, `accrual.ts` | [`0xf6fbd169…`](https://sepolia.etherscan.io/tx/0xf6fbd169e117cefda236d71c4e0e827d01ea769f42ff70eee88eb48ecda01109) — 500 cUSDC in | met |
| **Draw** | `openDraw` → `revealDraw`, `FHE.randEuint64` + KMS proof | `draw-ordering.ts`, `equality-invariants.ts` | [`0x3f804883…`](https://sepolia.etherscan.io/tx/0x3f804883b402eb1ed6b27800a06518a3a822fec20fb5dbada76cf6aa6e62d499) — draw 35 revealed | met |
| **Claim** | `claim(user)`, permissionless, anyone for anyone | `g2-pending-acl.ts`, `phase-b.ts` | [`0x42743cf9…`](https://sepolia.etherscan.io/tx/0x42743cf9421110ad11a8a81c783d1926bc2a2fbc62907d409510ba776eb7e3e0) — moved exactly 1.000000 cUSDC | met |
| **Withdraw** | `withdraw(externalEuint64, proof)` | `withdraw-buffer.ts` | [`0x2d7ded28…`](https://sepolia.etherscan.io/tx/0x2d7ded28c6ec1e23cef248754b0c9321a996108813e9ea3d0ee7295dea410c0b) — 250 out, balanced to the unit | **met, with a limit** |
| **…from an unprivileged address** | a key generated for the run, funded with gas and cUSDC only | `f3-fresh-wallet.ts` | [`0xda54ff98…`](https://sepolia.etherscan.io/tx/0xda54ff98d06224cd5dc8a19ac9111eb61d04a132bb8286c78aa2bb7b9fd2df00) — fresh wallet deposits | met |

**On the claim.** The first `claim` we ran succeeded while doing nothing: `deposit` calls
`_drain`, so the credit had already been folded in three steps earlier. A transaction that
succeeds while doing nothing is not evidence, so it is not the one cited. The hash above is
the second attempt, run after actually winning draw 35, and it moved the position from
12,290 to 12,291.

**On the withdrawal limit.** All-or-nothing: asking for more than you hold, or more than the
pool has liquid, moves nothing and the transaction still succeeds. A confidential token
cannot revert on an insufficient balance without leaking the comparison — see §4 of the
README's limitations.

**On the unprivileged run.** The first live cycle used the deployer, which is also the pool
owner and the keeper. That proved the paths work; it did not prove they work for a stranger.
The fresh wallet `0x93e8195537e624B15c3993e0f448B260FddefB62` sent `accrue` and `claim` for
itself, which is the permissionlessness the design claims, demonstrated rather than argued.

---

## 2. Confidentiality

| requirement | where | pinned by | shown by | |
|---|---|---|---|---|
| Balances confidential | `euint64` positions, `FHE.allow` to the holder only | `aa1-weight-leak.ts`, `g2-pending-acl.ts` | try it on **Try to break it**, row 1 | met |
| **Prize distribution via confidential transfer, winner-only decryption** | `FHE.select` into `_pending[user]`, for every participant | `c1-indistinguishability.ts` | — | **met differently** |
| Outcome not inferable from the transaction | unconditional accrual, no branch on an encrypted value | `c1-indistinguishability.ts` — 312 accruals, 81 winners, 231 losers, zero within-draw separation | [`0x1ef0e39d…`](https://sepolia.etherscan.io/tx/0x1ef0e39d5d30790963c57030a050fbc480932a86e0527429b449f41ed6bbedc1) — a win costing the same gas as a loss | met |
| Identities | — | — | — | **met, with a limit** |
| Aggregates | `totalWeight` published at every reveal | `spikes/a2-encrypted-total.ts` — encrypting it costs 8.3× | — | **met, with a limit** |

### Why there is no `confidentialTransfer` in the prize path

This is the first and most important divergence, and it is deliberate.

`confidentialTransfer(winner, prize)` hides the **amount** and publishes the **recipient**.
ERC-7984 requires a `ConfidentialTransfer` event on every transfer — *"including zero value
transfers"* — and its `from`/`to` are plain addresses. A prize paid that way puts the
winner's address on chain in a transfer whose sender is the pool, which is precisely the
"who won" that *winner-only decryption* exists to protect.

Following the suggested mechanism literally would defeat the requirement it serves. So the
prize moves as `FHE.select` into `_pending[user]`, applied to **every** participant whether
they won or not, and the credit is a handle only its owner can decrypt. Winner-only
decryption is satisfied; the transfer event that would have announced the winner never
happens.

`docs/leakage.md` §6 records the source-level reason: every transfer variant in
`ERC7984.sol` takes `address to` as a plaintext parameter.

### The limits, stated rather than hidden

**Identities are not hidden and never were claimed to be.** Every `Deposited` event names its
depositor and the participant set is enumerable — six addresses at the time of writing. FHE
is not a mixer.

**Aggregates.** `totalWeight` is published deliberately: it is what makes the draw publicly
auditable, and encrypting it costs 8.3× while removing the thing a lottery most needs to
prove. Separately, the vault leg publishes an **exact** aggregate whenever our pool is the
only participant in a batch — batch 286 published 6,000.000000 cUSDC. Disclosed in
[`leakage.md` §7](leakage.md) with both mitigation costs measured, and neither is
affordable at this size.

---

## 3. FHEVM usage

| requirement | where | pinned by | shown by | |
|---|---|---|---|---|
| On-chain randomness | `FHE.randEuint64()` in `openDraw`, then made publicly decryptable | `draw-ordering.ts` | [`0xcc6712d7…`](https://sepolia.etherscan.io/tx/0xcc6712d72a35142539bfce0a2ee0b4a708ba7adb75f8474ed72d8bbd91503e97) — R revealed with a KMS proof | met |
| Decryption via the KMS, verified on chain | `FHE.checkSignatures` in `revealDraw`, status checked first | `draw-ordering.ts` | same | met |
| ACL | `FHE.allow` / `allowThis` / `allowTransient` throughout | `aa1-weight-leak.ts` (over-granting), `g2-pending-acl.ts` (under-granting) | `scripts/f1-acl-sweep.ts` | **met, with a limit** |
| Within the HCU budget | `accrue`, 7 participants per transaction | `storage-cost.ts` — 2,582,192 HCU against a 5,000,000 sequential-depth limit | — | **met, with a limit** |
| ERC-7984 as the settlement token | Zama's deployed cUSDC, six decimals | `e1-wrap-path.ts`, `d1-wrapper-revert.ts` | — | met |

**Randomness is the protocol's own CSPRNG**, used the way its documentation describes:
generated inside a transaction, never via `eth_call`, then marked publicly decryptable so the
draw can be audited. Not a workaround.

**`checkSignatures` carries no replay guard**, so the status check comes before it —
otherwise a valid proof could be resubmitted to grind R. `revealDraw`'s NatSpec says so.

**The ACL limit.** A live sweep of all ten externally-readable handles
(`scripts/f1-acl-sweep.ts`) found one under-granted: `pendingOf` hands the holder a handle
their own key cannot open, in every state, from their first accrual onward. No money is
affected — the value is zero by then — and the SDK no longer offers it as spendable. The
two-line contract fix is recorded and unshipped; the sweep found no other reason to redeploy.
Four further getters (`reserveHandle`, `principal`, `pending`, `inVault`) are unreadable by
anyone but have no caller.

**The HCU limit.** Accrual is `O(participants)` where PoolTogether's claim is `O(winners)`:
386,608 gas each, so a hundred depositors is 38.7M gas per draw — over a block. That is the
price of unconditional accrual, which is the property the design exists for.

---

## 4. Composition and operations

| requirement | where | pinned by | shown by | |
|---|---|---|---|---|
| Composes with Zama's confidential vault | `SteakhouseReplicaSource.joinVault` / `requestUnwind`, both directions | `replica-source.ts`, `withdraw-buffer.ts` | [`0xc3bb31f1…`](https://sepolia.etherscan.io/tx/0xc3bb31f13aaf629fa37f58958cb2bfc6592152ec748d8e753cb98e0e0d69cb9a) — shares from batch 286 | **met, with a limit** |
| Contracts verified | all three on Etherscan | `scripts/verify-all.sh` | — | **met, with a limit** |
| An agent interface | `@savetogether/mcp-server`, 17 tools over the SDK | `mcp.ts`, `mcp-protocol.ts`, `g1-can-afford-oracle.ts` | — | **met, with a limit** |

**The composition is real and the rate is ours**, and both halves are provable. Zama's
deployed batchers, real shares, both directions. But their Sepolia vault is idle-only:
`totalAssets()` is `1058845820278` against a `totalSupply()` of
`1058845820278000000000000` — a share price of exactly **1.0** — and all ten settled batches
finalised at an exchange rate of exactly `1000000`. A prize funded from its appreciation
would never pay, so the rate is ours and the pot is pre-funded.

**Verification is two Exact Matches and one Similar Match.** `SteakhouseReplicaSource`'s
runtime bytecode matches while its metadata hash does not, which Etherscan renders with an
amber check rather than a green one. `verify-all.sh` reproduces all three but does not
assert which kind it got.

**The agent interface has a measured history.** The model sees opaque references, never
amounts, unless the holder clicks a confirmation on the local console — every call, with no
setting that turns it off. `can_afford` was a budget oracle: forty probes recovered an exact
figure, inside the hosted server's sixty-per-minute allowance. It is now answered against a
budget coarsened to 50-token buckets, so every budget inside a bucket answers identically and
the search has nothing left to divide. `test/g1-can-afford-oracle.ts` runs the attack and
then pins the fix.

**The largest untested surface is not a code path.** The MCP has never been driven by a real
model in a test. Every test is deterministic code calling the SDK, or a client calling tools
by name. Nothing verifies that a model reading these descriptions picks the right tool with
the right arguments — and that is the product's actual interface.
`docs/threat-model.md` §10 says so.

---

## What a scoring sheet with nothing in the "limit" column would mean

Nine of the twenty rows above carry a limitation or a divergence. That is the honest half of
this page. A version of it with twenty clean "met" marks would be a worse document and the
same project — and every one of those nine names the test or the measurement that pins it,
so none of them has to be taken on trust either.
