# SaveTogether — Step 1 interim: source verification, before the spike

Self-contained: it repeats the facts it depends on, so it reads without the repos.

**Status.** Pre-spike. This covers what could be settled by reading installed source
rather than by spending Sepolia gas, plus one architectural finding that changes what
the spike is even for. No contracts written. The spike is next.

**Why this comes before the spike:** three of the nine assumptions are answerable from
`node_modules/` in minutes, and one of them — A2 — invalidates part of the brief's
framing. Running the spike first would have measured the right thing for the wrong
architecture.

---

## 0. Versions, pinned

| package                 | version | how known                                             |
| ----------------------- | ------- | ----------------------------------------------------- |
| `@fhevm/solidity`       | 0.11.1  | `node_modules/@fhevm/solidity/package.json`            |
| `@fhevm/host-contracts` | 0.10.0  | `node_modules/@fhevm/host-contracts/package.json`      |
| `@zama-fhe/relayer-sdk` | ^0.4.1  | GhostLend `package.json` devDependencies              |
| `@openzeppelin/confidential-contracts` | ^0.5.1 | GhostLend `package.json`                 |

`@fhevm/host-contracts@0.10.0` is **the same version SaveTogether read its HCU table
from**. So A4's per-op costs carry over with no version drift and did not need
re-deriving — one of the few places the eight-day schedule gets something for free.

---

## 1. A2 — bounded randomness — **PARTIAL, and it couples two forks the brief listed as independent**

This is the most consequential finding in this pass.

### The bounded variant exists but cannot be used directly

`node_modules/@fhevm/solidity/lib/FHE.sol:8756-8761`:

```solidity
/**
 * @dev Generates a random encrypted 64-bit unsigned integer in the [0, upperBound) range.
 *      The upperBound must be a power of 2.
 */
function randEuint64(uint64 upperBound) internal returns (euint64) {
    return euint64.wrap(Impl.randBounded(upperBound, FheType.Uint64));
}
```

**`upperBound` must be a power of two.** `totalWeight` never will be. So
`randEuint64(totalWeight)` is not available, and the brief's assumption that bounded
randomness is a simple lookup is false.

### The escape exists, and it is scalar-only

`FHE.sol:6576` — ciphertext modulo **plaintext**:

```solidity
function rem(euint64 a, uint64 b) internal returns (euint64)
```

`HCULimit.sol:280-298` gives the cost and the constraint:

```
:289   if (scalarByte != 0x01) revert OnlyScalarOperationsAreSupported();
:296   } else if (resultType == FheType.Uint64) {
:297       opHCU = 1153000;
```

So `R = FHE.rem(FHE.randEuint64(), totalWeight)` works and costs **1,153,000 HCU**,
once per draw rather than per participant. Modulo bias is on the order of
`totalWeight / 2^64` — negligible.

### The consequence

`rem`'s modulus is a `uint64`, not a ciphertext. **Bounding R therefore requires
`totalWeight` to be public plaintext.** The brief lists "encrypted vs public R" and
"public vs encrypted totalWeight" as two separate forks. They are one: choosing a
bounded encrypted R forces a public total weight. There is no configuration where both
stay private.

This is an aggregate disclosure, not an individual one — the same trade GhostLend
already makes for epoch utilisation, with the same justification available. It should
be stated as a deliberate choice in the README rather than discovered by a judge.

For the record, `FHE.div(euint64, uint64)` also exists (`FHE.sol:6566`), same
scalar-only shape. It matters for the scaling alternative discussed in §4.

---

## 2. A3 — scalar multiply — **VERIFIED**

`FHE.sol:6546`:

```solidity
function mul(euint64 a, uint64 b) internal returns (euint64)
```

The brief's reading of TWAB is correct: because `dt` derives from `block.timestamp`
and is plaintext, `E(twab) += FHE.mul(E(balance), dt)` needs **no ciphertext-by-
ciphertext multiply at all**. That removes the most expensive op class from the hot
path before it was ever budgeted for.

---

## 3. A1 / A4 — randomness cost and the limits — **VERIFIED**

`HCULimit.sol:1307+` (`checkHCUForFheRand`) and `:1336+` (`checkHCUForFheRandBounded`),
`FheType.Uint64` branch: **24,000 HCU** each. Randomness is not a cost concern.

Limits, from the same contract at the version installed here:

```
:50   MAX_HOMOMORPHIC_COMPUTE_UNITS_DEPTH_PER_TX  =  5,000,000
:54   MAX_HOMOMORPHIC_COMPUTE_UNITS_PER_TX        = 20,000,000
```

Per-op `euint64` costs, carried from SaveTogether's A8 against the identical version:

| op                      | scalar operand | both ciphertext |
| ----------------------- | -------------- | --------------- |
| `add`                   | 133,000        | 162,000         |
| `sub`                   | 133,000        | 162,000         |
| `le`                    | 119,000        | 149,000         |
| `ge`                    | 116,000        | 152,000         |
| `select` (`IfThenElse`) | —              | 55,000          |
| `rand` / `randBounded`  | —              | 24,000          |
| `rem`                   | 1,153,000      | unsupported     |

**Read directly** in this pass: the power-of-two constraint, `rem`'s cost and its
scalar-only revert, `rand`/`randBounded` costs, the existence of `mul`/`div`/`rem`
scalar forms. **Carried** from SaveTogether at the same version: `add`, `le`, `select`,
and both limits. **Assumed and flagged for the spike:** `lt` ciphertext-ciphertext
equals `le` at 149,000, and `and(ebool, ebool)` ≈ 22,000. Both are cheap enough that
being wrong shifts the ceilings by single digits, but neither is asserted.

---

## 4. What the spike should find — and why it is still worth running

The brief asks for the ceiling to be found empirically rather than calculated. Agreed —
but the calculation is what tells the spike where to look, so here it is up front,
falsifiable.

### Naive draw (prefix sums recomputed inside the draw)

Per participant, all ciphertext-ciphertext:

```
add(prefix, weight)      162,000     <-- SEQUENTIAL, chains across participants
le(prefix[i-1], R)       149,000
lt(R, prefix[i])         149,000
and(ebool, ebool)         22,000
                       = 482,000
```

One-off per draw: `rand` 24,000 + `rem` 1,153,000 = **1,177,000**.

- **Global limit:** `(20,000,000 − 1,177,000) / 482,000` ≈ **39 participants**
- **Depth limit:** the chained adds dominate — `N × 162,000 + 171,000 ≤ 5,000,000` ≈ **29 participants**

**Depth binds first, at roughly 29.**

### Incremental prefix sums (maintained on deposit and withdraw)

The draw loses the `add`, and what remains is **independent per participant** — no
chain:

- **Global limit:** `(20,000,000 − 1,177,000) / 320,000` ≈ **58 participants**
- **Depth:** `1,177,000 + 171,000` = 1,348,000, **constant in N** — stops binding entirely

### The finding, stated as the brief asked

Moving accumulation out of the draw is **not an optimisation**. It roughly doubles the
ceiling *and changes which limit binds* — from sequential depth to global HCU. Those
are different failure modes with different fixes, so the two designs are not the same
architecture with different constants.

Writing the winner credits at draw time costs another `select` per participant
(55,000 → 375,000 each), pulling the ceiling back to ≈ **50**. Deferring the credit to
claim time is therefore worth about **8 participants per transaction**, which the spike
should confirm as its third measurement.

### Why measure anyway

SaveTogether found a real discrepancy *inside `HCULimit`* — 181 identical calls in a trace
diff and exactly one differing — so the coprocessor's own accounting is not guaranteed
to match the table it publishes. If reality diverges from the numbers above, that
divergence is the finding, not the ceiling.

---

## 5. The design that removes the O(N) draw entirely

Whether the ceiling is 29 or 58, both are small for a real pool, and the naive reading
forces a chunked state machine. There is an alternative that eliminates the loop rather
than chunking it, and it should be evaluated before committing to chunk mechanics.

**Reveal R publicly.** GhostLend already owns the machinery — `makePubliclyDecryptable`
→ KMS `publicDecrypt` → finalize with `checkSignatures` (A7 still to be re-confirmed).

Two things follow:

**The draw becomes O(1) and nearly free.** If R is going to be public anyway, reveal
the *raw* `randEuint64()` and take the modulus in plain Solidity afterwards. That
drops the 1,153,000-HCU `rem` completely: the draw transaction is `rand` at **24,000
HCU** plus the reveal round trip. Nothing per participant at all.

**Each user's win check becomes O(1), scalar, and lazy.** With R public,
`isWinner_i = and(le(prefix[i-1], R), lt(R, prefix[i]))` is ciphertext-vs-plaintext —
`le` at 119,000 instead of 149,000 — and, crucially, it need not happen at draw time.
Each user computes their own at claim time in their own transaction:

```
le scalar   119,000
lt scalar   119,000
and          22,000
select       55,000
          = 315,000 HCU per claim, O(1), no loop anywhere
```

**No chunking. No state carried between chunks. No partially-completed draw to
recover from.**

### What it costs

**R being public leaks nothing about who won.** Mapping R to a user requires the prefix
sums, and those stay encrypted. And `totalWeight` is already public by §1, so this adds
no new disclosure.

**But every user must claim.** If only winners claim, "claimed" is the leak, and the
bounty's central goal fails on the cheapest possible observation. So a loser's claim
must execute a real transfer of an encrypted zero, and the claim path must be
**gas-equal for winners and losers**.

That is precisely the primitive SaveTogether proved — 180 live Sepolia transactions, one
distinct FHE operation sequence, one distinct HCU value, χ² 0.374 at p = 0.83, mutual
information below its own noise floor. The methodology in that repo's `docs/leakage.md`
transfers directly and should be applied here deliberately, as the differentiator it is.

**Grindability gets worse, not better (A6).** A keeper that can re-request a draw until
it likes the revealed R breaks fairness, and a public R makes the outcome legible to
whoever is grinding. The mitigation is structural: R is committed at draw request,
revealed once, and the request is not re-issuable for that period. GhostLend's epoch
state machine already has replay guards of exactly this shape.

---

## 6. The problem I have not solved, and it is the real schedule risk

The lazy-claim design requires each user's ticket range `[prefix[i-1], prefix[i])` to be
**frozen as of the draw**. The brief specifies principal is withdrawable at any time.
A withdrawal after the draw shifts every later user's range, and R lands on somebody
else.

So what is needed is not per-user TWAB — it is **the global prefix ordering as of a
particular draw**. That is strictly harder than what PoolTogether's `TwabController`
solves, because a prefix sum depends on every other participant's position, not just
the holder's own history. Storing a snapshot per draw per user is O(N) writes and puts
the loop straight back in.

Candidate directions, none yet evaluated:

- **Append-only ticket ranges.** Ranges are assigned at deposit and never shift; a
  withdrawal marks a range dead rather than compacting it. R landing on a dead range
  means no winner that round — which is a real, quantifiable prize-carryover rule, not
  a bug, but it needs its probability bounded.
- **Draw against a frozen epoch.** Deposits and withdrawals during an epoch take effect
  in the next one. Simplest by far, and GhostLend's epoch machine already models it —
  but "withdrawable at any time" then means principal leaves immediately while the
  ticket persists to period end, which must be stated honestly.
- **Fenwick tree over encrypted values.** Correct and general; almost certainly too
  expensive under FHE and too much to build in eight days.

**This, not the spike's number, is the decision that determines whether the eight days
work.** Flagging it now per the brief's instruction: a correction here costs an hour,
the same correction after step 2 costs three days.

---

## 7. Scope

I agree with the brief's cut list — multi-tier prizes, syndicates, jackpots, draw
smoothing, VRGDA claimer economics — and would go further on one point.

Multi-tier is not merely unrewarding against the judging criteria; it multiplies the
draw by the number of tiers in exactly the dimension that is already constrained, and
under the §5 design it also multiplies the per-claim cost that must stay gas-equal.
Cutting it protects the differentiator, not just the schedule.

The one thing I would **not** cut is TWAB. Without it a flash deposit immediately before
the draw wins at the same odds as a full period's deposit, and that is the first attack
any reviewer will try.

---

## 8. Open questions and blockers

1. **The prefix-snapshot problem (§6) is unsolved.** Highest risk to the deadline.
2. **Public `totalWeight` is now forced, not chosen** (§1), if R is to be bounded at
   all. Needs an explicit decision and a README sentence.
3. **Every user must claim** for the indistinguishability claim to hold (§5). This is a
   UX and gas cost imposed on losers and should be an accepted design consequence
   rather than a discovered one.
4. **A5 not yet checked** — `euint128` existence and relative cost. The brief's own
   arithmetic gives only three orders of margin before TWAB overflow at 2^64, which is
   thin enough to need an answer before the type is fixed.
5. **A7 not yet re-confirmed** at 0.11.1 — the public-decryption path GhostLend relies
   on. §5's whole design depends on it still working as built.
6. **A9 not yet checked** — whether any confidential ERC-4626 vault exists on Sepolia.
   Expectation is that the mock is the only option, but that must be established rather
   than assumed, since the bounty allows a mock only if the README documents the real
   plug-in path.

---

## 9. Plan

1. `desktop\savetogether` skeleton — hardhat + FHEVM setup carried from GhostLend, no
   contracts
2. `spikes/draw-hcu.ts` — naive vs incremental, N = 5, 10, 20, 40, 80 on live Sepolia,
   then push N until the limit trips, to find the ceiling empirically rather than
   inferring it
3. A third column in the same spike: the public-R / lazy-claim path from §5. The model
   says O(1); a claim that strong is not written down unmeasured
4. Finish A5–A9
5. PoolTogether V5 recon, weighted toward `TwabController`'s observation ring buffer,
   since §6's answer will come from there if it comes from anywhere
6. GhostLend reuse inventory with file paths
7. `findings.md` + `architecture.md`

Sepolia funding confirmed: `0xF505e2E71df58D7244189072008f25f6b6aaE5ae`, **0.3513 ETH**,
sufficient for the full matrix.
