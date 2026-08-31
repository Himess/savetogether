# Contract inventory and gap analysis

Read from the source on 31 August 2026, not from memory. Every load-bearing claim
carries a file and line. Nothing was built in this pass.

---

## 1. `ConfidentialPrizePool.sol`

### 1.1 External and public surface

| line | function | who may call | tested by |
| --- | --- | --- | --- |
| 181 | `deposit(externalEuint64, bytes)` | anyone | `ConfidentialPrizePool.ts`, `yield.ts`, `accrual.ts` |
| 216 | `withdraw(externalEuint64, bytes)` | anyone | `ConfidentialPrizePool.ts` (incl. the clamp), `yield.ts` |
| 312 | `confidentialBalanceOf(address)` view | anyone | throughout |
| 316 | `observationCount(address)` view | anyone | `ConfidentialPrizePool.ts` |
| 320 | `totalObservationCount()` view | anyone | `equality-invariants.ts` |
| 324 | `observationAt(address, uint256)` view | anyone | `ConfidentialPrizePool.ts` |
| 328 | `indexAt(address, uint40)` view | anyone | `ConfidentialPrizePool.ts` (incl. the pre-history revert) |
| 340 | `cumulativeAt(address, uint40)` | anyone | `ConfidentialPrizePool.ts` |
| 367 | `openDraw()` | **anyone** | `draw-ordering.ts` (empty pool, double-open) |
| 416 | `revealDraw(uint32, bytes, bytes)` | anyone with valid KMS signatures | `draw-ordering.ts` (replay guard before signature check) |
| 463 | `thresholdFor(uint32, address)` view | anyone | `draw-ordering.ts`, `accrual.ts` |
| 494 | `weightFor(uint32, address)` | anyone | `draw-ordering.ts` |
| 506 | `drawAt(uint32)` view | anyone | throughout |
| 538 | `setYieldSource(IYieldSource)` | **ANYONE — see §4** | **no access-control test** |
| 553 | `harvest()` | anyone, by design | `yield.ts` (the paired test) |
| 563 | `setPrize(uint64)` | **ANYONE — see §4** | **no access-control test** |
| 568 | `fundReserve(externalEuint64, bytes)` | anyone | `accrual.ts` setup |
| 590 | `accrue(address, uint32)` | anyone, for anyone | `accrual.ts` (idempotence, cold/warm cache, reserve clamp) |
| 630 | `accrueMany(address[], uint32)` | anyone | `sepolia-accrue-cost.ts` |
| 676 | `pendingOf(address)` view | anyone | `accrual.ts` |
| 680 | `winningsOf(address)` view | anyone | `accrual.ts` |
| 684 | `reserveHandle()` view | anyone | `accrual.ts` |

**Measured cost.** `accrue` steady state 2,582,192 HCU, 7 users per transaction
(findings §11.1, measured on chain). `accrueMany(6)` was 2,655,606 gas in one
transaction (§16.2). A deposit is 625,465 gas on the spike harness (§20/R2).

### 1.2 State

| line | variable | encrypted | readable by |
| --- | --- | --- | --- |
| 46 | `asset` immutable | no | anyone |
| 61 | `_userObs[address]` — `Observation[]` | `balance` and `cumulative` are; **`timestamp` is plaintext** | the holder decrypts their own; timestamps are public |
| 64 | `_totalObs` — the aggregate | same split | same |
| 85–93 | `_draws[id]` — `Draw` | `encR`, `encTotalWeight` until reveal | `r` and `totalWeight` become **public at reveal, by design** |
| 95 | `drawCount` | no | anyone |
| 98 | `prize` | no — plaintext by design | anyone |
| 101 | `_reserve` | yes | the contract only |
| 109 | `yieldSource` | no | anyone |
| 119 | `_pending[address]` | yes | the contract; not granted to the user |
| — | `_winnings[address]` | yes | granted to the user (`FHE.allow(nextWinnings, user)`, :625) |
| — | `accrued[drawId][user]` | no — plaintext flag | anyone |

The plaintext observation timestamp and the plaintext `accrued` flag are both
deliberate and documented in `docs/leakage.md`; the flag leaks nothing because
accrual runs for every participant regardless of outcome (:583–588).

---

## 2. `GhostKeySession.sol`

Access control is present and specific throughout, in contrast to §1:

| line | check |
| --- | --- |
| 275 | `if (s.owner != msg.sender) revert NotSessionOwner` — `increaseBudget` |
| 309 | same — `addRecipient` |
| 328–329 | `msg.sender != s.owner && msg.sender != sessionKey` → `NotOwnerOrSessionKey` — `removeRecipient` |
| 363–364 | same — `closeSession` |
| 133 | `ECDSA.recover(digest, sig) != params.sessionKey` → `InvalidSessionKeySignature` |

71 tests. The indistinguishability result (identical execution gas across the
success, over-budget and short-balance paths) is asserted in test 1.

## 3. The yield sources

`MockYieldSource`: `controller` immutable (:39), `onlyController` (:71) guards
`supply` (:95) and `redeem` (:107). `harvest` (:131) is permissionless by design.
`ZamaVaultSource`: identical shape — `onlyController` (:87) on `supply` (:105)
and `redeem` (:150); `joinVault` and `claimShares` permissionless. `yield.ts`
covers "refuses supply and redeem from anyone but the pool".

---

## 4. Admin surface — and the finding

**`ConfidentialPrizePool` has no access control of any kind.** No `Ownable`, no
owner, no modifier, no `msg.sender` comparison anywhere in the file. Two of its
functions should not be open:

### `setYieldSource` (:538) — a live drain path

```solidity
function setYieldSource(IYieldSource source) external {
    yieldSource = source;
    if (address(source) != address(0)) {
        asset.setOperator(address(source), type(uint48).max);   // :540
    }
```

Anyone may call this, and it grants the address they name **unlimited operator
authority over the pool's own token balance, until 2^48**. The attack is one
transaction:

1. `setYieldSource(evil)` — `evil` is now an operator of the pool's asset
2. `evil` calls `asset.confidentialTransferFrom(pool, evil, …)` and takes the
   reserve
3. every later `deposit` forwards principal to `evil.supply()` (:194–197)
4. every later `withdraw` asks `evil.redeem()` for the money back (:228–231)

Confirmed against the live deployment: the pool **holds an encrypted balance**,
and `isOperator(pool, currentSource)` is already `true`, so the mechanism is
demonstrably the one in use.

### `setPrize` (:563)

```solidity
function setPrize(uint64 prize_) external { prize = prize_; }
```

Anyone may set the per-winner prize to anything. Setting it to `0` bricks
accrual (`if (prize == 0) revert PrizeNotSet()`, :593); setting it high drains
the reserve to the first winners.

### What a judge concludes reading it cold

Not "this is centralised" — the opposite, and worse. `GhostKeySession` next door
is carefully permissioned, so this does not read as a philosophy. It reads as an
oversight in the headline contract, and it is the first thing a security-minded
reviewer greps for.

**Neither function has a test asserting a stranger cannot call it.** Both appear
in tests only as setup (`yield.ts:77–78`, `accrual.ts:92`).

---

## 5. The rubric, line by line

| requirement | where satisfied | proof |
| --- | --- | --- |
| Confidential deposit | `deposit` :181 | `ConfidentialPrizePool.ts`; live tx on chain |
| Encrypted balance | `_userObs.balance`, `confidentialBalanceOf` :312 | tests + live decryption in the app |
| On-chain weighted draw with `FHE.rand` | `FHE.randEuint64()` :385, `thresholdFor` :463 | `draw-ordering.ts`; **two live rounds**, R published on chain |
| EIP-712 decryption | frontend `useGrantPermit` / `useDecryptValues` | live in the app; A6 verified on chain (findings §2) |
| No-loss | `withdraw` :216 returns principal; only yield funds prizes | `yield.ts` paired test — **pays from harvest, pays nothing without** |
| Keeper / admin flow for draws | `scripts/keeper.ts`; README "Running it" | documented ✅ — **but not running, see G2** |
| Faucet | `ERC7984Mock.mint`, Pool and Wrap screens | live |
| Open source | the repository | ✅ |
| Live URL | ghostpool-himess.vercel.app | ✅ |

**Satisfied by argument rather than evidence:** none of the above, with one
qualification — "keeper flow" is satisfied by a documented script, and a judge
who deposits will experience it as *not* satisfied unless the script is running.

---

# PHASE TWO — the gaps

## G1 — a draw with one participant

**Arithmetically confirmed, and untested.**

`thresholdFor` (:466) returns `_uniform(keccak256(r, drawId, user), d.totalWeight)`,
and `_uniform` (:476) returns `random % upperBound` — a value in
`[0, totalWeight − 1]`. The win test is `FHE.gt(weight, threshold)` (:606),
strict.

With a single participant, `weight == totalWeight` and the threshold is at most
`totalWeight − 1`. **The sole depositor wins every round, with probability 1.**
That is correct — they hold 100% of the weight — but it is the exact case a judge
trying the live app alone will produce.

**No test covers it.** The accrual tests use two or three depositors
(`accrual.ts:126–128`, `:143–149`). The two-participant case *is* covered:
"pays a winner and leaves a loser at zero" (`accrual.ts`), and `draw-ordering.ts`
covers a mid-period joiner weighing less than a full-period holder.

## G2 — who calls `accrueMany`, and what happens when nobody does

**Nobody is calling it. Measured on the live pool just now:**

```
depositors ever: 11
draw 1  accrued  6/11   INCOMPLETE — prizes pending
draw 2  accrued  6/11   INCOMPLETE — prizes pending
```

`systemctl list-units` on the VPS shows only `ghostpool-hosted.service`. There is
no keeper anywhere, and five addresses have unaccrued results on both live draws
right now.

This is the sharpest gap in the submission, because it undercuts the argument the
design is proudest of. The README says accrual is what replaces claiming
(:159) and `docs/leakage.md` says keeper liveness is a *privacy* property (:250).
A judge who deposits, waits, and sees nothing move does not conclude "the keeper
is down" — they conclude the product does not work.

## G3 — draw automation

**Documented, not automated.** `scripts/keeper.ts` is a self-healing driver that
repairs before it advances, and the README's "Running it" section carries
`POOL=0x… npm run keeper` plus a table entry describing it. That satisfies the
brief's "or provide a documented keeper/admin flow".

Two smaller accuracy problems in the same section: it says `npm test` runs
"30 tests" when the suite is now 132, and it does not say that a judge must run
the keeper themselves for a deposit to ever be scored.

---

# Ranked, with the argument against each

## 1. Access control on `setYieldSource` and `setPrize`

**Against a criterion:** security review. It is the first thing anyone competent
greps for, and finding an open operator grant in the headline contract costs more
than any feature adds.

**Cost:** the pool must be redeployed — there is no way to close it on the
deployed bytecode. That loses two live rounds of history, which are themselves
evidence for the draw criterion. It does **not** touch the frozen surface: adding
a modifier to two functions that `accrue`, `_snapshotCumulative`, `_cumulativeAt`,
`thresholdFor` and `_uniform` do not call cannot change them, and R3 already
measured that adding a whole function leaves `accrue`'s gas identical at
426,105/426,093. Redeploy plus a scripted round: 1–2 hours.

**The case against doing it:** the live history is real evidence and a fresh pool
starts at zero. A disclosed known-issue in the README costs nothing and is
honest. And there is a real risk in redeploying at day four with a video unmade —
the last redeploy is what left the README pointing at a dead pool for two days.

**My view:** fix it. A judge finding this unprompted is worse than a thinner
history, and the history can be rebuilt in an hour with `demo-round.ts`.

## 2. Run the keeper

**Against a criterion:** the keeper/admin-flow requirement, and the no-claim
argument that the whole design rests on.

**Cost:** ~30 minutes. A systemd unit on the VPS beside the hosted server, the
same pattern already working there. Gas: a few cents a day on Sepolia.

**The case against:** it is a live process that can die quietly, and a keeper that
stops mid-judging is worse than one a judge was told to run themselves — it turns
"documented flow" into "broken automation". It also spends the deployer's ETH
unattended.

**My view:** do it, with `Restart=always`, and keep the README line so the manual
path stays documented.

## 3. Say what happens when you are the only depositor

**Against a criterion:** none directly. It is a completeness gap on the path a
judge walks first.

**Cost:** one test and two sentences in the README. Under an hour.

**The case against:** the behaviour is correct and a test does not change what the
judge sees. If the README sentence is written, the test adds nothing a reviewer
will read.

**My view:** write the README sentence. The test is optional.

## 4. Fix the two stale facts in the README

**Cost:** ten minutes. `npm test` is 132 tests, not 30.

**The case against:** nobody scores a test count.

**My view:** do it while touching the README anyway. A wrong number in the first
technical section is the cheapest possible way to look careless.

---

## Completeness gaps, flagged separately

These are rough edges on paths a judge actually walks, and they are worth more
than any feature:

1. **Unaccrued prizes on the live pool.** G2. Five addresses, both draws.
2. **A lone depositor wins every round with no explanation on screen.** G1.
3. **The keeper is not running**, so the product's answer to "why no claim" is
   currently unbacked in the only place a judge will check.

## What I am NOT proposing, and why

- **More tests on the frozen surface.** The 306-sample result is the strongest
  evidence in the submission and every touch is a risk to it.
- **Multi-tier prizes, syndicates, a jackpot.** V5 folklore, absent from the
  criteria, and each multiplies the per-accrual cost that must stay gas-equal.
- **A second pool or more tokens.** The cUSDC pool already proves the token is
  not a dependency; a third deployment is surface without a claim.
- **Any change to `accrue` for G1.** Making a lone participant *not* win would be
  wrong: they hold all the weight. The gap is explanatory, not arithmetic.
