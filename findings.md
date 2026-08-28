# GhostPool — Step 1 findings

Self-contained: it repeats the facts it depends on, so it reads without the repos.

**Rule followed throughout:** nothing here is answered from training data. Every claim
about an API, a cost or a behaviour cites installed source at a file:line, a verified
deployment, or a URL, with the version stated. Where a check has not been run, it says
so instead of guessing.

**Versions.** `@fhevm/solidity` **0.11.1**, `@fhevm/host-contracts` **0.10.0**,
`@zama-fhe/relayer-sdk` ^0.4.1, `@openzeppelin/confidential-contracts` ^0.5.1.
`@fhevm/host-contracts@0.10.0` is the same version GhostKey read its HCU table from, so
those costs carry over without version drift.

**Immediate correction to carry forward.** `SepoliaConfig` does not exist in 0.11.1; the
config contract is `ZamaEthereumConfig` (`@fhevm/solidity/config/ZamaConfig.sol:96`).
The first spike contract failed to compile against the older name. GhostLend already uses
the current one (`contracts/GhostLendPool.sol:5`).

---

## 1. The spike: what a claim actually costs, and whether winning is visible

Contract `DrawSpike` at `0x2c6AD3dE18d1f5f69C718Ed9898B555897E847cF`, live Sepolia,
signer `0xF505e2E71df58D7244189072008f25f6b6aaE5ae`. Source: `contracts/DrawSpike.sol`,
driver `spikes/draw-hcu.ts`, raw data `out/draw-hcu.json`.

Method carried from GhostKey's `docs/leakage.md`, which established two things the hard
way. HCU accumulates in transient storage with no event, so it cannot be read back — it
is reconstructed by counting the coprocessor's per-op events and multiplying by the costs
in `HCULimit.sol`. And total `gasUsed` includes intrinsic calldata cost, so comparing
it across arms measures the calldata rather than the computation; execution gas is the
only quantity that means anything.

### 1.1 The claim path — measured

```
FheGt x1  FheIfThenElse x1  TrivialEncrypt x2      172,064 HCU
```

**172,064 HCU**, matching the prediction from the cost table exactly: 117,000 (`gt`
scalar) + 55,000 (`select`) + 2 × 32 (trivial encryption of `prize` and `0`).

That is **0.86% of the 20,000,000 per-transaction ceiling**, and the dependent chain is
two operations deep against a 5,000,000 depth limit. The claim is not merely affordable;
HCU is nowhere near being the constraint on it.

For contrast, the pre-spike model put the prefix design's claim at 315,000 HCU and its
draw at 1,177,000 plus roughly 320,000 **per participant**. This design's draw is
`rand` alone at 24,000, with nothing per participant.

### 1.2 Winner versus loser — the result, and why it is not yet publishable

Twelve rounds per arm, interleaved, same sender, identical calldata (threshold 100,
prize 777). The only difference between arms is the encrypted weight — 1000 wins, 10
loses — which is exactly the secret that must not leak. The first claim was discarded
because it writes `_credit` from zero, and a cold storage slot costs 20,000 gas against
2,900 warm; that difference has nothing to do with the secret.

**Identical on the two quantities that describe the computation:**

```
FHE operation sequence   FheGt x1  FheIfThenElse x1  TrivialEncrypt x2   (1 distinct, all 24)
HCU                      172,064                                          (1 distinct, all 24)
```

**Execution gas takes two values, four apart** — 169,939 and 169,943 — and *both arms
produce both values*:

| arm    | n   | 169,939 | 169,943 | low-value rate |
| ------ | --- | ------- | ------- | -------------- |
| winner | 12  | 3       | 9       | 25.0%          |
| loser  | 12  | 5       | 7       | 41.7%          |

```
chi-square (Yates, 1 df)   0.1875   against 3.841 critical at p = 0.05
Fisher exact, two-sided    p = 0.667
```

This is the same four-gas artefact GhostKey traced to `HCULimit`'s own cost accounting —
there to `checkHCUForFheGe`, here necessarily `checkHCUForFheGt`, the sibling branch.
It is outside anything this project controls.

**The honest verdict is that this run does not settle the question.** At twelve per arm
the design has 80% power to detect only a spread of **±54 percentage points**. The
observed spread is 16.7 points, which at this sample size is indistinguishable from
noise in either direction — it is neither evidence of a leak nor evidence of its absence.

GhostKey made exactly this mistake once: an n = 20 run showed 45% / 30% / 20% and read
as a trend, and the spread collapsed to nothing at n = 60 per path. Publishing a
"winner and loser are indistinguishable" claim on twelve samples would be repeating it.

| samples per arm | 80% power detects |
| --------------- | ----------------- |
| 12 (this run)   | ±53.9 points      |
| 30              | ±34.1 points      |
| 60              | ±24.1 points      |
| 120             | ±17.0 points      |
| **206**         | **±13.0 points**  |

**Required before the claim is made anywhere public: roughly 206 samples per arm**, which
is what it takes to match the ±13-point resolution GhostKey achieved. That is scheduled
for day 5, against the deployed contract rather than this spike. What can be stated now,
and only this: the operation sequence and the HCU are provably identical, and the gas
residual is a known FHEVM accounting artefact that is present in both arms.

### 1.3 A correction to the comparison code

The spike's own `identical` flag reported `false`. That is a bug in the spike, not a
finding: it compared the two arms' distinct-value arrays with `JSON.stringify`, which is
order-sensitive, and the arms happened to encounter 169,939 and 169,943 in opposite
order. The sets are the same. Recorded here rather than quietly fixed, because a
comparison that is sensitive to encounter order would have produced a false alarm on
every future run.

### 1.4 The prefix-design sweep — measured, and the model held exactly

Thirty-six draws on live Sepolia, N = 5…100 across the three designs.

| N   | naive        | incremental  | incremental + credit |
| --- | ------------ | ------------ | -------------------- |
| 5   | 3,587,032    | 2,777,000    | 3,052,064            |
| 10  | 5,997,032    | 4,377,000    | 4,927,064            |
| 20  | 10,817,032   | 7,577,000    | 8,677,064            |
| 25  | 13,227,032   | 9,177,000    | 10,552,064           |
| 30  | **depth**    | 10,777,000   | 12,427,064           |
| 40  | depth        | 13,977,000   | 16,177,064           |
| 50  | depth        | 17,177,000   | **19,927,064**       |
| 60  | depth        | **global**   | **global**           |

Per-participant slopes, from the measurements:

| design               | measured slope | predicted |
| -------------------- | -------------- | --------- |
| naive                | **482,000**    | 482,000   |
| incremental          | **320,000**    | 320,000   |
| incremental + credit | **375,000**    | 375,000   |

All three match to the unit. The per-op costs in `HCULimit.sol` are exact for these
operations — worth recording, because GhostKey found a case where the coprocessor's
accounting disagreed with its own published table, and that does not happen here.

**The architectural claim is proven by the error names, not inferred from the numbers.**

```
naive       N=30   reverted with custom error 'HCUTransactionDepthLimitExceeded()'
incremental N=60   reverted with custom error 'HCUTransactionLimitExceeded()'
```

Two different limits. The naive design dies on **sequential depth** while it still has
volume to spare — its projected HCU at N = 30 is 15,637,032, only 78% of the 20,000,000
global ceiling. Moving accumulation out of the draw does not make the same design
cheaper; it changes which wall it hits, and the second wall is further away.

**Empirical ceilings.** Naive passes at 25 and fails at 30, so its ceiling is in [25, 29];
the depth model puts it at 29 (29 × 162,000 + 171,000 = 4,869,000, against 30 × 162,000 +
171,000 = 5,031,000). Incremental passes at 50 and fails at 60, ceiling in [50, 59]; the
volume model puts it at 58. Incremental-with-credit passes at exactly 50 at
**19,927,064 HCU — 99.6% of the ceiling** — and the model puts its limit at 50 too.

Deferring the credit to claim time is therefore worth **eight participants per draw**,
58 against 50, exactly as predicted.

### 1.5 What the sweep says about the design that was chosen

The comparison is not close, and it is worth stating in per-participant terms because
that is the axis a reviewer will use.

| design                  | cost per participant | ceiling per draw |
| ----------------------- | -------------------- | ---------------- |
| prefix, incremental     | 343,540 HCU at N = 50, **plus a claim** | ~58 |
| independent threshold   | **172,064 HCU**, claim included | **none** |

The prefix design spends 17,177,000 HCU on a draw serving fifty people and each of them
still has to claim afterwards. The independent-threshold design spends 24,000 once on
`rand`, and 172,064 per person on the only transaction they make — **half the cost per
participant, with no ceiling and no chunk state machine at all.**

The sweep was commissioned to size a chunk. It ended up measuring what the chosen design
avoids paying.
---

## 2. Assumption verdicts

| #   | assumption                              | verdict                          |
| --- | --------------------------------------- | -------------------------------- |
| A1  | `FHE.randEuint64()` signature and cost  | **VERIFIED**                     |
| A2  | randomness can be bounded to a modulus  | **PARTIAL — constraint found**   |
| A3  | `FHE.mul(euint64, uint64)` scalar       | **VERIFIED**                     |
| A4  | HCU limits and per-op costs             | **VERIFIED**                     |
| A5  | `euint128` and TWAB overflow            | **VERIFIED — wide type required**|
| A6  | randomness grindability                 | **PARTIAL — ordering is load-bearing** |
| A7  | public-decryption path                  | **VERIFIED — four traps documented** |
| A8  | ERC-7984 tokens on Sepolia              | **VERIFIED — cross-confirmed**   |
| A9  | confidential ERC-4626 on Sepolia        | **VERIFIED — exists, idle-only** |

### A1 — randomness — VERIFIED

`FHE.sol:8751` `randEuint64()`, `:8759` `randEuint64(uint64 upperBound)`.
`HCULimit.sol:1307+` (`checkHCUForFheRand`) and `:1336+` (`checkHCUForFheRandBounded`),
`FheType.Uint64` branch: **24,000 HCU** each. Randomness is not a cost concern.

### A2 — bounding the randomness — PARTIAL, and it couples two forks

`FHE.sol:8756-8758`, verbatim:

> `@dev Generates a random encrypted 64-bit unsigned integer in the [0, upperBound) range.`
> `The upperBound must be a power of 2.`

`totalWeight` is never a power of two, so `randEuint64(totalWeight)` is unavailable.

The escape is `FHE.rem(euint64 a, uint64 b)` (`FHE.sol:6576`) — ciphertext modulo
**plaintext** — at **1,153,000 HCU**, and it rejects anything else outright:

```
HCULimit.sol:289   if (scalarByte != 0x01) revert OnlyScalarOperationsAreSupported();
HCULimit.sol:297   opHCU = 1153000;   // FheType.Uint64
```

**Consequence.** Bounding R requires `totalWeight` to be public plaintext. The step-1
brief listed "encrypted vs public R" and "public vs encrypted totalWeight" as separate
forks; they are one fork. There is no configuration in which both stay private.

`FHE.div(euint64, uint64)` exists at `FHE.sol:6566` with the same scalar-only shape.

**How the chosen design escapes this entirely:** see §3. If R is public, the modulus is
taken in plaintext and `rem` is never called — 1,153,000 HCU that simply is not spent.

### A3 — scalar multiply — VERIFIED

`FHE.sol:6546` `mul(euint64 a, uint64 b)`. Cost `HCULimit.sol` `checkHCUForFheMul`:
scalar **365,000** (euint64) / **696,000** (euint128); ciphertext-ciphertext 596,000.

The brief's reading of TWAB is correct. `dt` comes from `block.timestamp` and is
plaintext, so `E(twab) += FHE.mul(E(balance), dt)` needs no ciphertext-by-ciphertext
multiply. The saving is real, though the scalar multiply remains the most expensive
single op in the TWAB path.

### A4 — limits and per-op costs — VERIFIED

```
HCULimit.sol:50   MAX_HOMOMORPHIC_COMPUTE_UNITS_DEPTH_PER_TX  =  5,000,000
HCULimit.sol:54   MAX_HOMOMORPHIC_COMPUTE_UNITS_PER_TX        = 20,000,000
```

| op                      | scalar (u64) | cipher (u64) | scalar (u128) | cipher (u128) |
| ----------------------- | ------------ | ------------ | ------------- | ------------- |
| `add`                   | 133,000      | 162,000      | 172,000       | 259,000       |
| `sub`                   | 133,000      | 162,000      | —             | —             |
| `mul`                   | 365,000      | 596,000      | 696,000       | —             |
| `ge`                    | 116,000      | 152,000      | —             | —             |
| `gt`                    | **117,000**  | 152,000      | 150,000       | 218,000       |
| `le` / `lt`             | 119,000      | 149,000      | —             | —             |
| `and` (ebool)           | 22,000       | 22,000       | —             | —             |
| `select` (IfThenElse)   | —            | 55,000       | —             | 57,000        |
| `rem`                   | 1,153,000    | unsupported  | 1,943,000     | unsupported   |
| `rand`                  | —            | 24,000       | —             | 25,000        |
| `TrivialEncrypt`        | —            | **32**       | —             | 32            |

**Correction to a carried figure:** `gt` scalar is **117,000**, not the 116,000 in
GhostKey's table — that number is `ge`, a different branch (`HCULimit.sol:847` vs `:899`).

### A5 — `euint128` and TWAB overflow — VERIFIED, and the wide type is required

`euint128` exists throughout, at 1.0×–1.9× the euint64 cost: `select` 1.04×, `add`
ct-ct 1.60×, `gt` scalar 1.28×, `mul` scalar 1.91×.

**The overflow is real, not hypothetical.** PoolTogether's observation stores a
cumulative balance, which is `Σ balance × dt`. At a 6-decimal balance of 1e12 held for
one year (3.15e7 s) the cumulative reaches **3.15e19**, against `2^64` = **1.84e19**.
It overflows in roughly **seven months**, not at the three-orders-of-margin the brief
estimated — the brief's arithmetic used a week rather than the retention window the
ring buffer actually implies.

**Verdict: use `euint128` for the cumulative accumulator.** A TWAB update is one scalar
multiply plus one add: **527,000 HCU** at euint64, **955,000** at euint128. Both are
comfortably inside the per-transaction ceiling, so the wide type costs headroom nobody
is using. Periodic normalisation and scaling factors are unnecessary complexity by
comparison.

### A6 — grindability — PARTIAL, and the ordering is load-bearing

Under the chosen design (§3) the per-user threshold is `keccak256(R, user) % totalWeight`,
and R is public. Two distinct attacks follow, and only one was in the brief.

**Keeper grinding.** Whoever triggers the draw could re-request until they like the
revealed R. Mitigation is structural: R is committed at draw request, revealed exactly
once, and not re-issuable for that period. GhostLend already implements this shape —
`FHE.checkSignatures` has **no replay guard of its own**, and the contract supplies one:

```
GhostLendPool.sol:520   require(ep.status == EpochStatus.Pending, "not pending");
                        // replay guard (checkSignatures has none)
```

**Address grinding — not in the brief, and it is fatal if the ordering is wrong.**
Because the threshold is a pure function of `(R, address)` and R becomes public, an
attacker who learns R *before* the eligible set is fixed can grind addresses until one
yields a near-zero threshold, then win with a dust balance: `gt(dust, 0)` is true.

**The mitigation is an ordering requirement, and it must be stated in the contract's
invariants:** freeze weights → draw R → reveal R. An address that was not in the
snapshot cannot be eligible for that round.

With that ordering, **sybil neutrality holds.** Splitting weight `W` across `k`
addresses gives each `w_j` a win probability `w_j / total`, so the expected number of
wins is `Σ w_j / total = W / total` — independent of `k`. Under a fixed per-winner
prize the expected payout is identical, so splitting buys nothing.

### A7 — public decryption — VERIFIED, with four traps already paid for

GhostLend's epoch machine (`contracts/GhostLendPool.sol:478+`) exercises the whole path
and documents every trap in place:

| trap                                                                          | where                     |
| ----------------------------------------------------------------------------- | ------------------------- |
| `makePubliclyDecryptable` is **permanent and irrevocable** — aggregates only   | `:503-507`                |
| `checkSignatures` has **no replay guard**; the contract must supply one        | `:520`                    |
| handles must be rebuilt **from storage in the original off-chain order**       | `:523-526`                |
| a **null handle** is rejected by the KMS and bricks the machine                | `:182-183`                |

All four apply directly to revealing R. The first is harmless here — R is meant to be
public. The second *is* the keeper-grinding mitigation in A6.

### A8 — ERC-7984 on Sepolia — VERIFIED, cross-confirmed

| contract   | address                                      |
| ---------- | -------------------------------------------- |
| cUSDC      | `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639` |
| Mock USDC  | `0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF` |

These match GhostKey's recorded findings **and** Zama's current address reference
exactly, so nothing has changed. Mock USDC has a public `mint`, which is the judges'
faucet path; wrap through the `ERC7984ERC20Wrapper` interface for a confidential balance.

**The finding that decides the prize mechanism.** Every transfer variant in
`ERC7984.sol` takes `address to` as a **plaintext** parameter (lines 112, 127, 140, 149,
169) and `_update` emits `ConfidentialTransfer(from, to, transferred)` at line 322 with
both endpoints in the clear. Only the amount is encrypted. **Paying a winner by transfer
publishes who won.** This is the source-level reason the prize must be a per-participant
encrypted credit, and it is not a matter of preference.

Second, carried from GhostKey: `ERC7984.sol:144` returns `transferred` under
`FHE.allowTransient`, so any credit reconciliation must happen **in the same transaction
as the transfer**. No design that transfers first and books later can work.

### A9 — confidential ERC-4626 on Sepolia — VERIFIED, better than expected

Zama's Confidential Vault **is deployed on Sepolia**, block 11117640:

| contract        | address                                      |
| --------------- | -------------------------------------------- |
| ERC-4626 vault  | `0x6AB54988261AEC573a2CA13cF802d3B1114f864C` |
| cShare          | `0x7E93d5c150A2178B1fCde0278582Acf59478eA5f` |
| Deposit batcher | `0x48758559c14d4d92b4C74A99660B6a8dbe85F53b` |
| Redeem batcher  | `0xe94E9afdDd43a19C2914739e9279cb6Fe287BEb0` |
| Whitelist gate  | `0x0C7c3830B16B65FF90f96F88a9ad2dCaB9434e74` |

It is a **staging deployment with an idle-only VaultV2 and no yield adapter**, so it
generates no yield. A mock yield source is therefore required for the demo — but the
bounty's condition is that the README documents how a real one plugs in, and that
document can now name a real deployed address rather than describing a hypothetical.

Worth noting for the architecture: the Confidential Vault's own privacy model is
batch-based — observers see who participated and the batch total, never an individual
amount. That is a weaker guarantee than GhostPool's per-participant credit.

---

## 3. PoolTogether V5 — what survives

The most consequential finding in the recon is that **V5 does not use prefix sums, and
never did.**

`TierCalculationLib.sol` (`GenerationSoftware/pt-v5-prize-pool`):

```solidity
calculatePseudoRandomNumber =
    uint256(keccak256(abi.encode(_drawId, _vault, _user, _tier, _prizeIndex, _winningRandomNumber)))

isWinner =
    UniformRandomNumber.uniform(_userSpecificRandomNumber, _vaultTwabTotalSupply)
        < calculateWinningZone(_userTwab, _vaultContributionFraction, _tierOdds)
```

Each user is evaluated independently; there is no cross-user aggregation anywhere in the
check. That is structurally identical to the independent-threshold design — a public
per-user random mapped uniformly into `[0, totalSupply)` and compared against a zone
scaled by the user's own TWAB. The inequality even runs the same direction as
`FHE.gt(E(weight), threshold)`.

**This changes the framing of the whole step.** The independent-threshold design is not
an FHE workaround; it is fidelity to the reference protocol. The prefix-sum construction
in the original brief described a mechanism V5 does not implement, and the global-ordering
blocker raised in the pre-spike report was a problem PoolTogether never had.

One detail worth porting verbatim: `UniformRandomNumber.uniform` performs rejection
sampling to remove modulo bias. Because GhostPool's threshold is computed entirely in
plaintext, that code ports at **zero FHE cost** — the bias question disappears rather
than being tolerated.

| V5 component            | verdict under FHE                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TwabController`        | **Survives, ports directly.** Its index is a binary search over **plaintext timestamps**; only the stored balance and cumulative become ciphertexts. The search structure is untouched by FHE. |
| Winner selection        | **Survives.** Already independent per user; the only change is that the comparison runs on a ciphertext.                                            |
| Observation ring buffer | **Survives**, with `euint128` for the cumulative field (A5).                                                                                        |
| Flash-deposit defence   | **Survives and is required.** V5 aligns periods smaller than a draw so a mid-period overwrite cannot alter the record for that draw.                |
| Tiered prizes           | **Cut.** Multiplies the draw *and* the per-claim cost that must stay gas-equal, and earns nothing against the judging criteria.                     |
| Draw smoothing          | **Cut.** Exists to stabilise multi-tier economics that will not be built.                                                                           |
| VRGDA claimer economics | **Cut as economics, but the problem it solves is real** — see §5.                                                                                   |
| Vaults / liquidation pairs | **Cut.** Replaced by a mock yield source plus the documented plug-in path from A9.                                                              |

`TwabController` mechanics, from the protocol docs: each observation stores a timestamp,
the balance after the transfer, and a cumulative balance advanced by the previous balance
times elapsed time. A balance at time `T` is reconstructed from the closest observation
at or before `T`; a TWAB over an interval is `Δcumulative / Δtime`. Retention is about
one year before overwrite — which is precisely the window that forces `euint128`.

---

## 4. GhostLend reuse inventory

The eight-day schedule only works with heavy reuse. Paths are in the GhostLend repo
(`desktop\zama`).

| what                                | path                                             | transfers as        |
| ----------------------------------- | ------------------------------------------------ | ------------------- |
| Epoch / async-reveal state machine  | `contracts/GhostLendPool.sol:478-560`            | **adapt** — becomes the draw's commit-reveal |
| Replay guard on reveal              | `contracts/GhostLendPool.sol:520`                | **as-is** — this is the A6 mitigation |
| Null-handle KMS trap + fix          | `contracts/GhostLendPool.sol:182-183`            | **as-is** as a rule; the bug class recurs |
| Self-healing keeper                 | `scripts/keeper.ts` (198 lines)                  | **adapt** — recovers a closed-but-unfinalized epoch from `queryFilter` over recent blocks, idempotent because finalize reverts when already done |
| Mock yield source                   | `contracts/market2/MockYieldVault.sol` (27)      | **as-is**           |
| ERC-7984 wrapper                    | `contracts/market2/ConfidentialShareWrapper.sol` (16) | **as-is**      |
| ERC-7984 mock token                 | `contracts/mocks/ERC7984Mock.sol` (32)           | **as-is**           |
| Batching patterns                   | `contracts/market2/VaultBatchers.sol` (103)      | **reference**       |
| ACL-hygiene regression tests        | `test/GhostLendPool.audit.ts`                    | **adapt** — the assertions carry, the subjects change |
| Hardhat + FHEVM toolchain           | `hardhat.config.ts`, `probe/secrets.json` convention | **as-is** — already carried into `desktop\ghostpool` |
| Frontend shell                      | `frontend/` — `components/App.tsx`, `Wizard.tsx`, `Toast.tsx`, `TokenIcon.tsx`, `lib/{abis,addresses,wagmi,format,css}.ts` | **adapt** — the wagmi + relayer-SDK wiring and the wizard shell transfer; the screens do not |
| `GhostGate.sol` (355)               | `contracts/market2/GhostGate.sol`                | **does not apply** — lending-specific |
| `InterestRateModel.sol`             | `contracts/libraries/`                           | **does not apply**  |
| `OracleAdapter.sol`                 | `contracts/`                                     | **does not apply** — no price feed needed |

---

## 5. Architecture proposal

### 5.1 Winner selection — independent per-user threshold

```
R            = randEuint64(), committed at draw request, revealed once via KMS
threshold_i  = uniform(keccak256(R, user_i), totalWeight)      // plaintext, unbiased
isWinner_i   = FHE.gt(E(twab_i), threshold_i)                  // scalar comparison
credit_i     = FHE.select(isWinner_i, prize, 0)                // computed at claim time
```

`P(user i wins) = twab_i / totalWeight`, exactly the weighting the bounty requires, with
`E[winners] = 1`.

What this removes: prefix sums, global ordering, the draw-time snapshot of a global
ordering, chunked draws, partially-completed draw recovery, and the 1,153,000-HCU `rem`.
The draw transaction is `rand` plus a reveal, with **nothing per participant**.

`totalWeight` is public. Under this design that is a choice rather than a constraint —
`rem` is not used — but it is still required, because the threshold must be mapped into
`[0, totalWeight)` in plaintext. It is an aggregate disclosure of the same kind GhostLend
already makes for epoch utilisation, and it belongs in the README as a stated trade.

### 5.2 The snapshot problem, resolved

Weight must still be frozen as of the draw, but **per user rather than globally** — and
a per-user checkpoint is `O(1)` and local. This is exactly what `TwabController`'s ring
buffer does, and its search runs over plaintext timestamps, so it ports without
redesign. The pre-spike report flagged global prefix ordering as the schedule's main
risk; that risk is now closed, and it was closed by discovering that the reference
protocol never had it.

### 5.3 Prize distribution — permissionless accrual, and nobody claims

Paying the winner by transfer is impossible: `to` is plaintext and
`ConfidentialTransfer` emits both endpoints (A8). The prize is therefore an
encrypted per-participant credit, with N−1 encrypted zeros.

**An earlier draft of this section required every participant to claim, and that
design is withdrawn. It leaked the winner.** The reasoning that killed it, checked
link by link:

1. `threshold_i = keccak256(R, addr) % totalWeight` is public — R is revealed, the
   address is public, and `totalWeight` is revealed at draw time.
2. An observer cannot compare it against the encrypted weight. **But the user can.**
   Withholding the ACL on their balance handle changes nothing: the depositor
   chose the amounts and encrypted them, and the timestamps are on chain, so they
   can reconstruct their own TWAB in plaintext from their own history.
3. So a participant learns their own outcome **off chain, with zero transactions.**
4. A loser therefore has no reason to claim — it costs gas to receive an encrypted
   zero.
5. Under rational behaviour only winners claim, and **"who claimed" becomes "who
   won"**. The leak returns on the cheapest observation available.

Calling that an "accepted design consequence" was wrong. It was a behavioural
assumption — individually irrational and unenforceable — load-bearing under the
project's central claim. Two rescues were considered and both fail: bundling the
claim into a withdrawal moves the leak to withdrawal timing, and paying a claim
rebate makes the protocol fund an action that exists only to create noise.

**The fix is to remove the claim, not to motivate it.**

```solidity
function accrue(address user, uint32 drawId) external {
    // idempotent; a plaintext per-(user, draw) flag prevents double accrual
    E(balance[user]) += FHE.select(
        FHE.gt(E(twabAt[user][drawId]), threshold(drawId, user)),
        prize, 0
    );
}
```

A keeper calls this for every participant. The call is public, its result is
encrypted, and it happens for everyone — so there is no selectivity to observe.
The prize compounds straight into the confidential balance, which means there is
no separate winnings-withdrawal whose timing could be correlated with a draw.

The participant set is already public: deposits are ordinary transactions and
`Deposited` carries an indexed address. Enumerating it reveals nothing new.

~~Cost is the measured 172,064 HCU per user per draw, about 116 users per
transaction.~~ **Corrected in §10.2 — the real figure is 2,374,128 HCU and eight
users per transaction.** The 172,064 measurement was the bare comparison; it never
included computing the weight out of the TWAB record, which is where the cost is. It chunks with no deadline
pressure and no state carried between chunks, because each `(user, drawId)` is
independent and idempotent. The historical snapshot handles the rest:
`twabAt[user][drawId]` is a past value that a later withdrawal cannot move.

For the bounty's EIP-712 winnings requirement, `E(cumulativeWinnings_i)` is kept
separately. Reading it is a decryption, not a transaction, so it leaks nothing.

**Two residuals this design does not remove, named rather than buried:**

- **Keeper liveness is now a privacy property, not just an availability one.** If
  the keeper skips someone, that user can self-accrue — and a self-accrual is weak
  evidence they won, since a loser has no reason to bother. The leak only appears
  when the keeper fails, which is far weaker than the claim design where it
  appeared in the normal case, but it is not zero. Accrual should be completed for
  every participant before the next draw, and a shortfall should be visible.

  **Narrowed, cheaply:** `deposit` and `withdraw` each drain that caller's pending
  accruals first. Anyone the keeper missed is then swept up silently by their next
  ordinary action, and a standalone self-accrual survives only at the intersection
  of "the keeper failed", "the user has no other reason to transact", and "they
  want the prize now". The cost is one extra state read on paths that are already
  writing.
- **The aggregate reveal leaks the winner count, not the winners.** Revealing
  `totalWeight` each draw means that between two draws with no deposits or
  withdrawals, the change in the total is `winners × prize`. That discloses how
  many won, never which. Ordinary deposit traffic masks it; a dead period does not.

  There is a structural fix — count the reserve inside `totalWeight` so a prize
  leaves the sum unchanged — but it needs the reserve excluded from its own win
  check, the probability mass rescaled, and reserve accounting tied into TWAB.
  **Deliberately not built.** What leaks is a count, never an identity, which is a
  materially weaker disclosure than the one this protocol exists to prevent. It is
  written up in `docs/leakage.md` with its bound and left there.

### 5.4 Winner count and the reserve

Winners are Poisson-binomial with `Σp_i = 1`. Where no single participant dominates this
approaches Poisson(1):

| winners ≥ k | probability | one round in |
| ----------- | ----------- | ------------ |
| 2           | 0.264241    | 4            |
| 3           | 0.080301    | 12           |
| 4           | 0.018988    | 53           |
| 5           | 0.003660    | **273**      |
| 6           | 0.000594    | **1,683**    |
| 7           | 0.000083    | 12,013       |

**Correction to the brief:** `P(≥5 winners)` is `0.37%` — one round in 273, not "below
one in a thousand". The recommendation it supported still holds: funding the reserve for
five winners leaves a shortfall only when six or more win, one round in 1,683.

**And the tail is conservative by construction.** The Poisson-binomial variance is
`Σp_i(1−p_i) = 1 − Σp_i²`, maximised as every `p_i → 0`. Any concentration of weight —
a whale — makes the tail *thinner*. So Poisson(1) is the worst case across all weight
distributions, and a reserve sized against it cannot be undersized by a change in the
depositor mix. That is worth a sentence in the README, because it is the kind of claim
a reviewer expects to be hand-waved.

Zero winners carries the prize over. That is standard lottery mechanics, not a defect.

### 5.5 GhostKey's role, corrected

An earlier draft claimed GhostKey was *required* by this design, because every
participant had to claim and session keys were what made N−1 gas-burning claims
tolerable. **With accrual permissionless, that claim is false and is withdrawn.**
The keeper does the work; no session key is needed for a user to receive a prize.

What remains is real but smaller, and should be described as what it is:
conversational deposits, and bounded automation — "put 500 in every week" — with
an encrypted budget the automation cannot exceed. That is a genuine product
surface, not a structural necessity.

It is worth noting separately that V5's claimer-bot economics **do** break under
FHE: a bot cannot claim on behalf of winners when it cannot see who won. GhostPool
does not answer that with session keys; it answers it by removing claiming
altogether. That is the stronger answer, and it does not need GhostKey to hold.

---

## 6. Blockers and open questions

1. **Ordering is a security invariant, not an implementation detail.** Freeze weights →
   draw R → reveal R. Getting this backwards makes address grinding a total break (A6).
   It must be enforced in the contract and asserted in tests, not left to the keeper.
2. ~~**Every participant must claim.**~~ **Closed, by removing claiming** (§5.3). The
   voluntary design leaked the winner, because a participant can compute their own
   outcome off chain and a loser then has no reason to act. Permissionless accrual
   replaces it. What is now open in its place is narrower: **keeper liveness is a
   privacy property**, and a missed participant who self-accrues is weak evidence
   they won.
3. **`totalWeight` is public.** Aggregate disclosure, deliberate, README-visible.
4. **`euint128` for the cumulative accumulator** (A5). Decide before the storage layout
   is fixed; changing it later is a migration.
5. **Yield is mocked on Sepolia** because the deployed vault has no adapter (A9). The
   README must name the real address and the plug-in path.
6. ~~**Not yet examined:** the ring buffer's storage cost.~~ **Measured — see §8.**
   An observation costs three cold SSTOREs, 60,000 gas, which is **5.7% of a live
   Sepolia deposit at 1,035,178 gas**. Neither pre-initialisation nor timestamp
   packing pays for itself. The growable array stands.

---

## 7. Revised eight-day schedule

Deadline 5 September; step 1 completed 28 August.

| day   | work                                                                                    |
| ----- | --------------------------------------------------------------------------------------- |
| 1     | `ConfidentialPrizePool.sol` — deposit, withdraw, TWAB observations (`euint128`)          |
| 2     | Draw commit-reveal on GhostLend's epoch machine; the ordering invariant and its tests    |
| 3     | `accrue` — permissionless, idempotent, folded into deposit/withdraw — plus reserve accounting; the ACL-hygiene regression suite |
| 4     | Sepolia deployment, keeper adaptation, end-to-end round on live chain                    |
| 5     | Gas-equality run on **`accrue`**, winner against loser, at the GhostKey sample size, on the deployed contract |
| 6     | Frontend: wizard shell, deposit and balance screens, relayer wiring — there is no claim screen |
| 7     | GhostKey: conversational deposits and bounded automation (not claiming — §5.5); README, probability table, leakage document |
| 8     | Buffer — reserved for the failure that has not happened yet                              |

The buffer is not padding. On this codebase every step so far has surfaced at least one
thing that was true in the docs and false in the source.

---

## 8. Day 1 — the record, built and measured

`contracts/ConfidentialPrizePool.sol`, `test/ConfidentialPrizePool.ts` (9 passing),
`test/storage-cost.ts`, `test/sepolia-deposit.ts`.

### 8.1 The storage measurement, and the cardinality it implies

Measured locally for the pure-EVM part, then on live Sepolia for the denominator,
because the mock's FHE operations are not the coprocessor's and quoting a mock
total as a chain cost would have been wrong by 25%.

```
local mock, steady-state deposit    829,614 gas
live Sepolia, steady-state deposit  1,035,178 gas     (0x68C004C5…32AA7)
observation storage                    60,000 gas     3 cold SSTOREs
storage as a fraction of a deposit        5.7%
```

The steady state is flat: twelve consecutive local deposits spread −16 to +8 gas
around the mean, so an observation costs a constant amount and the array's growth
adds nothing per write.

**Decision: growable array, no pre-initialisation, no timestamp packing.**

- **Pre-initialising a ring buffer loses.** It costs `3 × cardinality × 20,000`
  up front and saves 51,300 per observation afterwards, so it pays back only after
  roughly 1.1 × cardinality observations — 37 writes at cardinality 32. A prize
  saver deposits a handful of times, not forty. PoolTogether's ring buffer exists
  to bound storage growth over a year, not to save gas, and an eight-day
  submission does not have that problem yet.
- **Packing timestamps six to a slot saves 16,666 gas, which is 1.6% of a
  deposit.** Not worth a second array and the index arithmetic that comes with it.

The layout is not where the gas is. The coprocessor calls are 94% of a deposit.

### 8.2 What the contract does, and what pins it

| invariant                                                                    | test                                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A deposit credits what the token actually moved, never what was requested     | "credits a deposit and records the first observation"            |
| The cumulative starts at zero — there is no history before the first deposit  | "starts the cumulative at zero"                                  |
| The cumulative advances by balance × elapsed seconds                          | "accumulates balance times elapsed time"                         |
| A late deposit weighs less than an early one of the same size                 | "weights a late deposit less than an early one"                  |
| A withdrawal returns funds and lowers the running weight                      | "returns funds on withdraw and lowers the running weight"        |
| **An over-withdrawal clamps and does not revert**                             | "clamps an over-withdrawal instead of reverting"                 |
| The aggregate advances in step with the parts                                 | "keeps the aggregate in step with the sum of the parts"          |
| Lookup finds the observation at or before a timestamp                         | "finds the observation at or before a timestamp"                 |
| A timestamp before any observation is refused, not reported as zero           | "refuses a timestamp before any observation"                     |

Two of these are doing more work than they look.

**The clamp.** A revert is visible on chain, so "this account asked for more than
it had" would be a leak. The withdrawal path therefore runs `tryDecrease` and
selects an encrypted zero rather than reverting — the same primitive the draw uses,
and the same one GhostKey measured over 180 transactions.

**"No observations" versus "a balance of zero."** These are different claims, and
a draw that conflated them would score an account that did not exist at the
snapshot. The lookup reverts rather than returning a zero balance.

### 8.3 Two things carried in from GhostLend that will bite

~~**The mock clamps; the deployed wrappers may revert.**~~ **Tested against the
deployed contract — it clamps. The blocker does not exist.**

`ERC7984Mock`'s header records that OpenZeppelin's v0.5.1 base clamps an
insufficient transfer to zero while the wrappers deployed on Sepolia revert
`ERC7984ZeroBalance` on a never-funded `from` (GhostLend PROBE-RESULTS P4). The
withdrawal path depends on clamping, and a revert is the one observable this
design spends its whole budget avoiding — so it was moved ahead of the draw and
run against the real contract rather than left to surface on deployment day.

Against deployed cUSDC `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`
(`test/d1-wrapper-revert.ts`, raw data `out/d1-wrapper.json`):

| case                                                                 | result        |
| -------------------------------------------------------------------- | ------------- |
| A — a `from` the token has never seen (handle `0x00…0`) sends 100    | **succeeded** |
| B — a funded `from` sends an **encrypted zero** — the pool's clamp path | **succeeded** |
| C — a funded `from` overdraws by far more than it holds               | **succeeded** |

Case C is the decisive one. A transfer of 1.8e19 against a balance of
61,116,148,996 left the balance **untouched at 61,116,148,996**, so the token
moved an encrypted zero rather than reverting or moving what it could. The
deployed wrapper clamps, exactly like the installed base.

Two things follow. The withdrawal path stands as written, with no contract-side
clamp needed. And case A clears a second edge that had not been asked about: a
withdrawal against a pool that has never been funded does not revert either.

**What this does not establish** is why P4 saw otherwise. The most likely
explanations are that the wrapper has been redeployed since, or that P4 exercised
a different token or condition. The note stays in `ERC7984Mock` as a warning
about a class of divergence, but it does not describe cUSDC today, and
`ERC7984ZeroBalance` does not appear anywhere in the v0.5.1 source installed here.

**The transient handle.** `ERC7984.sol:144` returns `transferred` under
`FHE.allowTransient`, so the balance has to be reconciled inside the same
transaction as the transfer. The deposit and withdrawal paths both do; no later
reconciliation is possible.

### 8.4 What day 1 did not change

C1 rewrites how prizes are distributed, not how balances are recorded. Deposit,
withdrawal and the observation record are unaffected by it, which is why they were
safe to build while the distribution question was still open. `accrue` and the
draw arrive on days 2 and 3.

### 8.5 Which observables get their own equality run

Two paths now hide a secret behind identical code, and they are not the same
problem, so they do not get the same treatment.

**`accrue` needs the full run.** The secret is win/loss, the function is new, and
nothing comparable has been measured. 206 samples per arm, 412 transactions, on
the deployed contract. This is the measurement the central claim rests on.

**The withdrawal clamp inherits GhostKey's evidence and gets a confirmatory run,
not a full one.** Its secret is different — whether the requested amount exceeds
the balance, not whether an account won — but its structure is not: `tryDecrease`,
then `select` against an encrypted zero, then a real transfer of whatever came
out. That is the same shape GhostKey measured over 180 live transactions across
three paths, finding one distinct operation sequence, one distinct HCU value, and
a mutual information below its own noise floor. The argument transfers because the
code does.

What does not transfer is the specific gas residual, since the surrounding
contract differs. So the withdrawal path gets 60 samples per arm — enough to
detect ±24 points, which would catch any gross divergence from GhostKey's result
without spending a second 412-transaction budget on a question that has already
been answered once at higher resolution.

Stated plainly so it can be challenged: **if the withdrawal run at n = 60 shows
anything other than what GhostKey saw, the inherited argument is void and the full
run is owed.**

### 8.6 Starting the day-5 run early

412 transactions at the observed pace is roughly three and a half hours, on a day
that also carries other work. It starts in the background as soon as `accrue`
exists on chain, not when day 5 begins.

The SDK-side transport retry from GhostKey is carried over **before** that run
rather than after: a 60-sample run there died on its fifth send with
`UND_ERR_CONNECT_TIMEOUT`, and a 412-transaction run that dies at sample 300 has
lost the day it was scheduled to save.

---

## 9. Revised schedule, with the two hard requirements and the cut list

Two submission requirements were missing from §7 and were leaning on the buffer,
whose whole purpose is the failure that has not happened yet. Both now have slots.

### 9.1 The dependency that reorders everything

**The video needs the frontend to exist.** That single fact moves the frontend's
real deadline from day 6 to the end of day 5, and it is the schedule's critical
path — not the contract work, which is well understood, and not the equality run,
which is background waiting.

Two overlaps make it fit without touching the buffer:

- **The ABI is frozen at the end of day 3**, so the frontend starts on day 4
  alongside deployment rather than after it.
- **Day 5's 412-transaction run is unattended.** Three and a half hours of waiting
  are three and a half hours of frontend.

The frontend therefore gets days 4 and 5 rather than day 6 alone — two days
instead of one, bought by overlapping rather than by adding time.

### 9.2 Days 2–8

| day | date   | work                                                                                                       |
| --- | ------ | ---------------------------------------------------------------------------------------------------------- |
| 2   | 29 Aug | Draw commit-reveal on GhostLend's epoch machine; the A6 ordering invariant enforced in the contract and asserted in tests |
| 3   | 30 Aug | `accrue` — permissionless, idempotent, folded into deposit and withdraw — plus reserve accounting and the ACL-hygiene regression suite. **ABI frozen.** |
| 4   | 31 Aug | Sepolia deployment, keeper, end-to-end round. Frontend scaffold in parallel: wallet connect, network guard, deposit. **The `accrue` equality run starts in the background the moment `accrue` is on chain.** |
| 5   | 1 Sep  | Frontend main build: withdraw, EIP-712 balance decryption, draw status, winnings. Equality run lands and is analysed. **Frontend usable by end of day.** |
| 6   | 2 Sep  | **Video.** Script, takes, edit. Its own day.                                                                |
| 7   | 3 Sep  | README, probability table, `docs/leakage.md`, **X thread**. GhostKey surface if it fits.                    |
| 8   | 4 Sep  | Buffer — still reserved for the failure that has not happened yet. Submission 5 Sep.                        |

### 9.3 The video is the highest-variance item

It is the only deliverable requiring a skill this project has not yet exercised,
and the constraints are strict: three minutes, a real person, no AI voice, no
speed-up. Two mitigations, both cheap:

- **Write the script in full before recording.** Writing is the stronger channel;
  reading a finished script converts an unpractised task into a practised one.
- **Record on day 6 with day 8 still free.** A re-record has somewhere to go. If
  the video slips into the buffer, that is the buffer doing its job — but it must
  not be the *plan* for the buffer.

### 9.4 What gets cut from the frontend, decided now

Deciding this on day 7 costs more than deciding it today, so it is decided today.

**Never cut** — a judge cannot evaluate the submission without these:

1. Wallet connect and a network guard that says plainly when the wrong chain is selected
2. Deposit, including the approve → wrap → deposit path, gated on balance and allowance (E1)
3. Withdraw — the product's claim is *no-loss*, so getting money back has to be demonstrable
4. **EIP-712 balance decryption** — an explicit bounty requirement, not a nicety
5. Draw status and winnings display

**Cut in this order** if day 5 runs out:

1. Historical draw archive and past-winner lists
2. Transaction history and activity feed
3. Draw-reveal animation and any motion design — a static status line makes the same claim
4. Multi-token support; cUSDC alone is the demo
5. Responsive polish beyond "does not break on a phone"
6. The GhostKey conversational surface — §5.5 withdrew its necessity, so it is polish now, not structure

The list is ordered so that everything above the line survives any single bad day,
and everything below it can go without weakening a scored criterion.

### 9.5 E1 — the wrap path, measured

Against deployed cUSDC (`test/e1-wrap-path.ts`, `out/e1-wrap.json`):

| case                                            | result        |
| ----------------------------------------------- | ------------- |
| W0 — wrap with no underlying and no approval    | **reverted**  |
| W1 — mint, approve, wrap (the deposit flow)     | **succeeded** |
| W2 — wrap zero                                  | **succeeded** |

The revert in W0 came back as an undifferentiated `execution reverted` with no
decodable custom error, so **it cannot be attributed to `ERC7984ZeroBalance`**.
The likeliest cause is the underlying ERC-20's `transferFrom` failing on an empty
balance and allowance, which is ordinary behaviour. The third explanation for the
P4 divergence is therefore narrowed rather than confirmed.

No leakage consequence — a wrap is a public action on a public amount. One UX
consequence, which is why it was worth the gas: **the deposit screen must gate
wrapping on balance and allowance**, or a judge meets a bare revert. W2 passing
means an empty amount field does not.

---

## 10. Day 2 — the draw, and a cost estimate that was wrong

22 local tests passing (`npm test`); three Sepolia suites (`npm run test:sepolia`).

### 10.1 The ordering invariant, enforced rather than assumed

A6 said the security of the whole scheme rests on one ordering — **freeze weights,
draw R, reveal R** — and that it must live in the contract rather than in the
keeper's habits. It now does, in two halves.

**`openDraw` freezes and draws atomically.** The snapshot timestamp and
`FHE.randEuint64()` happen in the same transaction, so there is no window in which
R exists and the eligible set is still open. R does not become public until the KMS
reveal, which is a separate transaction and cannot be brought forward.

**An account with no history before the snapshot carries exactly zero weight**, and
`FHE.gt` is strict, so `gt(0, threshold)` is false for every threshold including
zero. The grinder's move — pick an address whose threshold is favourable, fund it
after R is out — produces a participant who mathematically cannot win. That is the
arithmetic half, and it is what makes the ordering enforceable rather than merely
stated.

Three guards carried straight from GhostLend, each of which cost that project
something to learn:

| guard                                                                  | why                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `openDraw` reverts `NothingStaked` on an empty pool                     | `makePubliclyDecryptable` on an uninitialised handle is rejected by the KMS and bricks the machine (`GhostLendPool.sol:182-183`) |
| the status check precedes `checkSignatures` in `revealDraw`             | `checkSignatures` carries no replay guard of its own (`:520`), and re-finalising is precisely how a keeper would grind R |
| handles are rebuilt from storage in the original order                  | `:523-526`                                                                            |

Eight tests pin these. The one worth naming is "checks the replay guard before it
checks signatures": it calls `revealDraw` on a draw that was never opened and
asserts `DrawNotOpen` rather than a signature failure. If the guard were ordered
the other way the test would fail, and a finalised draw could be finalised again.

`UniformRandomNumber.uniform` is ported verbatim from PoolTogether. Because every
input to the threshold is public, its rejection sampling runs in plaintext and
removes modulo bias at zero FHE cost — the bias disappears rather than being
bounded and tolerated.

**Not testable locally:** `revealDraw`'s KMS round trip needs real signatures and
is exercised on Sepolia at day 4. What is tested locally is everything that
decides whether the reveal can be abused, which is the part that matters.

### 10.2 The accrual cost estimate in §5.3 was wrong by a factor of fourteen

§5.3 put `accrue` at the measured 172,064 HCU and about 116 users per transaction.
That is wrong, and the error is instructive: **172,064 was the cost of the bare
comparison, measured on a spike that was handed a weight already sitting in
storage.** The real function has to compute the weight out of the TWAB record
first, and that is where the cost lives.

Computed from the same `HCULimit.sol` table the spike validated to the unit:

```
cumulativeAt          cast 32 + mul(u128) 696,000 + add(u128) 259,000   =    955,032
weightFor             two of those, plus sub(u128) 259,000              =  2,169,064
threshold comparison  gt(u128) 150,000 + select(u64) 55,000 + 2 trivial =    205,064
                                                                          ----------
accrue, per user                                                          2,374,128
users per transaction, against the 20,000,000 ceiling                             8
```

**Stated as computed, not measured.** The spike validated this table exactly for
`add`, `le`, `gt`, `select` and `rem`, so the arithmetic is trustworthy — but the
project's rule is that a load-bearing number gets measured, and this one is
measured on day 3 when `accrue` exists on chain.

Eight users per transaction is workable: the keeper pays, chunks are idempotent,
each `(user, drawId)` is independent, and there is no deadline inside a draw. A
fifty-participant demo is seven transactions rather than one. But "116" was going
into a README, and it was wrong.

**The optimisation this exposes, for day 3.** `weightFor` is 91% of the cost, and
half of that is recomputing a value that was already computed once:
`_cumulativeAt(user, periodStart)` for draw N is the *same quantity* as
`_cumulativeAt(user, snapshotAt)` for draw N−1, because `periodStart_N` is
`snapshotAt_{N−1}`. Caching it when a user is accrued for draw N−1 makes draw N's
accrual `955,032 + 259,000 + 205,064 = 1,419,096` — **fourteen users per
transaction instead of eight**, for one extra storage slot per user.

That is the same lesson the step-1 spike taught in a different costume: the win
came from moving accumulation out of the hot path, not from making the hot path
cheaper.

---

## 11. Day 3 — accrual, and the measured cost

30 local tests passing. `contracts/ConfidentialPrizePool.sol` (accrual),
`contracts/mocks/PrizePoolHarness.sol`, `test/accrual.ts` (8),
`test/sepolia-accrue-cost.ts`.

### 11.1 The measured number, and how the computed one was wrong

Measured on live Sepolia, pool `0x62D145C7315fE40be042225925FbaCB36FE7288C`:

```
accrue, cold pending/winnings   501,555 gas   Cast1 Add1 Ge1 Gt1 Sel3 Mul1 Sub2 Triv6
accrue, steady state            589,971 gas   Cast1 Add3 Ge3 Gt1 Sel5 Mul1 Sub2 Triv5
```

Attributing each operation to its width — the coprocessor's event does not carry
the type, so this is read off the code rather than off the log:

| operation                                   | HCU           |
| ------------------------------------------- | ------------- |
| `mul(euint128, uint128)` in `cumulativeAt`  | 696,000       |
| `add(euint128)` in `cumulativeAt`           | 259,000       |
| `sub(euint128)` — the weight                | 260,000       |
| `ge(euint64)` × 3 — two `tryAdd`, one `tryDecrease` | 456,000 |
| `select` × 5                                | 275,000       |
| `add(euint64)` × 2 — pending, winnings      | 324,000       |
| `sub(euint64)` — reserve `tryDecrease`      | 162,000       |
| `gt(euint128, uint128)` — the threshold     | 150,000       |
| `Cast` + `TrivialEncrypt` × 5               | 192           |
| **total, steady state**                     | **2,582,192** |
| **users per transaction**                   | **7**         |

**§10.2 computed 2,374,128 and it was wrong, by 9% and for two compensating
reasons.** It over-counted the weight — it assumed two full `cumulativeAt`
extrapolations when one is routinely free, either because the user's record
starts after the window opens or because the cache holds it — and it omitted the
reserve `tryDecrease` and the two bookkeeping `tryAdd`s entirely. A figure that
lands near the truth because two errors cancel is not a figure anything can be
extrapolated from, which is the whole reason the rule is to measure.

**The cache is worth less than claimed.** §10.2 said it would take eight users per
transaction to fourteen. Measured, a cold cache costs 3,537,224 and a warm one
2,582,192, so it takes **five to seven**. Real, and worth the storage slot, but not
the doubling advertised.

### 11.2 A confound in my own measurement, stated rather than buried

The first run reads as though the cold-cache draw were *cheaper* than the cached
one — 501,555 gas against 589,971. That is not the cache; it is that `_pending`
and `_winnings` were uninitialised on their first write, so both `tryAdd`s
short-circuited. The operation counts show it directly: `FheAdd` 1 → 3, `FheGe`
1 → 3, `FheIfThenElse` 3 → 5, which is exactly two extra `tryAdd`s.

So the two rows do not isolate the cache and were never a clean comparison. The
cache's effect is visible elsewhere and is unambiguous: both rows contain exactly
**one** `FheMul`, where an uncached second draw would contain two.

### 11.3 F1 — the cache is an optimisation, and §5.3's wording is now qualified

§5.3 said every `(user, drawId)` is independent with no state carried between
chunks. The cache is exactly such state, so the sentence needed narrowing rather
than defending:

> **Independent in correctness, ordered in cost.** A cold entry is recomputed from
> the observation record — the same source the cached value came from — so
> accruing draw 5 before draw 4 returns the same answer as the other order and
> merely costs a second extrapolation.

A keeper written against the original sentence would have been correct about
outcomes and wrong about gas budgeting, which is the kind of error that shows up
as a stuck chunk at 3am. The out-of-order path is tested
(`"gives the same answer with a cold cache as with a warm one"`), not assumed.

### 11.4 F2 — `accrue` is frozen from the moment the equality run starts

Day 4 launches 412 background transactions against this function. **Any change to
`accrue` after that point voids the run and costs day 5.** Written here because a
small gas optimisation will look tempting and harmless, and it is neither.

The freeze covers `accrue`, `_snapshotCumulative`, `_cumulativeAt`, `thresholdFor`
and `_uniform`. Everything downstream of the credit — `_drain`, the frontend, the
keeper — stays editable.

### 11.5 F3 — the demo is sized to the measurement, decided now

Seven users per transaction, so:

**The demo pool holds six participants and accrual is a single transaction.** The
whole draw — open, reveal, accrue, balances move — fits on camera without a cut,
and cutting between shots is allowed while speeding up is not.

That decision is forced by the video, not by the protocol: a fifty-participant
draw is eight keeper transactions plus a KMS round trip, which is minutes of
nothing happening. Six participants is enough to show a winner and five losers
with identical transactions, which is the claim.

**The "draw in progress" state joins §9.4's never-cut list.** A judge on the live
URL arrives mid-round like anyone else, and a screen that cannot say *which chunk,
how many remain, what changes on completion* reads as broken rather than busy.
The demo pool avoids chunking; the live URL cannot promise that.

### 11.6 What accrual does

`accrue(user, drawId)` is permissionless, unconditional and idempotent. It writes
**no observation** — the fold-in into a balance happens on the user's next deposit
or withdrawal, which was going to write one anyway, so the credit rides for free
on a path already paying that cost.

Eight tests pin it. The two doing the most work:

- **"cannot pay an address that did not exist at the snapshot"** — the draw is
  revealed with a total weight of 1, which makes *every* threshold zero, the most
  generous case there is. The latecomer still wins nothing, because their weight
  is zero and `gt` is strict. The grinding defence is arithmetic, not a check that
  could be forgotten.
- **"does not pay out more than the reserve holds"** — the credit is gated on
  `tryDecrease` against the reserve, so an exhausted reserve clamps the payout
  instead of crediting a winner against money the pool does not have.

---

## 12. Day 4 — the reveal works, and the equality run is budget-blocked

Sequenced by risk per G2: deploy, then verify the KMS reveal, then the run.
Nothing downstream started until the reveal passed.

### 12.1 The KMS reveal, end to end

`test/sepolia-reveal.ts`, pool `0x70157aC697181d510C9d6e1D81FC4eDF338D4d2c`,
against the **real** `ConfidentialPrizePool`, not the harness.

```
draw 1 opened, snapshot 1787901180
publicDecrypt([encR, encTotalWeight])       ok
revealDraw                                  383,919 gas
status                                      2  (Revealed)
R                                           9331665430707183917
totalWeight                                 36012
threshold, on chain                         28053
threshold, recomputed off chain             28053
weight                                      36012  >  28053
winnings after accrue                       5000
```

**The test does not stop at "it did not revert."** The threshold was recomputed
from the revealed R by an independent TypeScript implementation of `_uniform`,
and the two agree exactly. That is a stronger check than it looks: had the handle
list been ordered differently from the off-chain request — A7's pitfall, and a
silent one because `abi.decode` is positional — R and `totalWeight` would have
swapped and the thresholds would not have matched.

Randomness, KMS reveal, threshold, encrypted comparison and prize all work
together on a live chain. The largest untested piece of the system is now tested.

### 12.2 The equality runner, built and validated

`test/sepolia-equality.ts`. Two arms, interleaved, execution gas rather than
`gasUsed`, HCU reconstructed from coprocessor events — GhostKey's method.

Arms are constructed so one wins every round and the other loses every round, and
**the construction is verified rather than trusted**: lifetime winnings are read
at the end.

```
winner lifetime winnings   40,000   expected 40,000   (8 rounds x 5,000)
loser  lifetime winnings        0   expected 0
```

Eight rounds per arm:

```
                exec gas                       HCU                  op sequences
winner    500995, 560285, 560289      1,285,224 / 2,023,192          2 distinct
loser     500995, 560285, 560289      1,285,224 / 2,023,192          2 distinct
```

**The two arms produce identical sets on all three quantities.** The two HCU
values are the cold and warm bookkeeping cases from §11.2, not an outcome effect —
round 1 initialises `_pending` and `_winnings`, every later round does not, and
both arms cross that boundary together.

The 4-gas split — 560,289 against 560,285 — is the same FHEVM `HCULimit`
accounting artefact GhostKey traced, appearing here in both arms at one sample in
seven each.

**This is not yet the result.** Seven steady-state rounds per arm has 80% power to
detect only a ±52-point spread, which is no better than the n = 12 run in §1.2 and
for the same reason. What it establishes is that the harness works, the arms do
what they were built to do, and the operation sequence and HCU are exactly equal —
which is structural rather than statistical and does not need a larger sample.

### 12.3 The blocker: the full run costs more Sepolia ETH than we hold

Measured from the validation run: **0.00505 ETH per round**, 75 seconds per round.

| samples per arm | cost      | wall clock | 80% power detects |
| --------------- | --------- | ---------- | ----------------- |
| 8 (run)         | 0.040 ETH | 10 min     | ±52.4 points      |
| 60              | 0.303 ETH | 75 min     | ±17.9 points      |
| **120**         | **0.605 ETH** | 150 min | **±12.7 points**  |
| 206             | 1.039 ETH | 258 min    | ±9.7 points       |

**The wallet holds 0.1622 ETH.** `0xF505e2E71df58D7244189072008f25f6b6aaE5ae`.

So the run that matches GhostKey's ±13-point resolution needs about **0.6 ETH**,
and 206 per arm needs **1.04 ETH**. Sepolia ETH is free but faucets are
rate-limited per day, which is why this is reported now rather than on day 5.

**Recommendation: fund to 0.7 ETH and run 120 per arm.** That reaches ±12.7
points, which is the resolution GhostKey published, at 150 minutes — comfortably
inside a day that is otherwise frontend work. Going to 206 buys ±9.7 for another
0.43 ETH and 108 minutes, and no reviewer is going to ask for it.

Until it is funded, **the claim stays unmade.** What can be said today is that the
operation sequence and HCU are exactly equal across arms; what cannot be said is
that the gas distributions are indistinguishable, because seven samples per arm
cannot support it.

### 12.4 G1 — the deferred fold-in's leakage dimension, now written down

§11.6 presented accrual writing no observation as a pure saving. It is a saving,
but it has a dimension that was not named: the TWAB is computed from `balance`,
not from `_pending`, so **a winner who never transacts earns no weight on their
prize in the next draw.** That puts pressure on winners specifically to transact,
which is the same shape as the leak C1 removed.

`docs/leakage.md` now exists and states all three residuals with their bounds.
This one is argued as the weakest of the three: `_drain` is unconditional so the
transaction itself is uniform, nothing is at risk while a credit waits, and
`winningsOf` is EIP-712 readable so **nobody has to transact merely to learn
whether they won** — the pressure is on compounding, not on discovery.

Not redesigned: `accrue` is frozen for the equality run, and reopening it to close
the weakest of three named residuals five days from a deadline is the wrong trade.

---

## 13. Day 4 continued — keeper, frontend scaffold, and a build failure that is not ours

### 13.1 The keeper

`scripts/keeper.ts`, adapted from GhostLend's self-healing driver. It repairs
before it advances: on every tick it first reveals any draw left Open, then
settles outstanding accruals oldest-first, and only then opens new work.

That order matters more here than it did in GhostLend. An Open draw blocks every
later one, so it is the only state that can wedge the machine — but the deeper
reason is that **accrual is what stands in for claiming**. A keeper that stops is
a keeper that has quietly turned "who transacted" back into a signal, which is
the leak C1 removed. Keeper liveness is a privacy property here, and
`docs/leakage.md` says so.

Two contract properties make blind repair safe, and both are deliberate:
`revealDraw` reverts `DrawNotOpen` on an already-revealed draw, and `accrue`
returns early rather than reverting on an already-accrued pair. Re-running a
chunk after a dropped receipt is normal operation, not an error path.

Chunk size is 6, set from the measurement rather than guessed: `accrue` costs
~2.58M HCU warm against a 20M ceiling, so seven fit, and six leaves room for the
3.54M cold-cache case.

### 13.2 Frontend scaffold

`frontend/` — wallet connect, the network guard, and the deposit path.
Next + wagmi + viem, carried from GhostLend's shell.

**The network guard names both chains.** "Your wallet is on chain 1; GhostPool
runs on Sepolia (11155111)" with a one-click switch, rather than "wrong network".
A judge who lands on mainnet should be able to fix it from the message.

**The deposit panel shows every precondition instead of letting one fail.** This
is E1 turned into UI: the deployed wrapper's `wrap` reverts with a bare
`execution reverted` and no decodable reason when the caller lacks underlying
balance or allowance. So the panel reads and displays USDC balance, allowance to
cUSDC, and whether the pool is an operator, each with its own action, and gates
the wrap button on all of them. The mint button is there because the underlying
is a mock with a public `mint` — the faucet is the token itself.

The panel also states plainly that wrapping is public. It is the one step in the
flow that is not confidential, and a judge should learn that from the interface
rather than from the chain.

### 13.3 The production build fails locally, and it is the environment

`next build` fails prerendering Next's own internal pages:

```
Error occurred prerendering page "/_global-error"
Error [InvariantError]: Invariant: Expected workStore to be initialized.
                        This is a bug in Next.js.
```

Four hypotheses were tested and three were eliminated: it is not the `Providers`
tree (removing it moves the error to `/_not-found` rather than fixing it), not
`force-dynamic`, not the Next version (16.3.3 and 16.2.10 fail identically), and
not a stale `.next` cache.

**The decisive test was to build GhostLend's frontend in the same environment. It
fails with exactly the same invariant** — and GhostLend is deployed and running on
Vercel. So the failure is Node 22.13.0 on Windows, not this codebase, and it does
not reproduce on the Linux builder that actually ships the site.

`next dev` serves the page correctly (HTTP 200, renders). Local development is
not blocked.

**What this does not establish** is that the Vercel build passes for *this* app.
The inference is strong — same stack, same shell, same failure locally, and the
sibling ships — but it is an inference. Deploying is on day 5, before the video
depends on it, and it is where the claim gets verified rather than argued.

### 13.4 The equality run is in flight

`ROUNDS=120` launched after the reveal was verified, per G2's ordering. Roughly
150 minutes, unattended, writing incrementally to `out/equality.json` so a crash
loses progress rather than everything.

120 per arm reaches ±12.7 points at 80% power — the resolution GhostKey published
— for 0.605 ETH. 206 per arm would buy ±9.7 for another 0.43 ETH and 108 minutes;
the budget now allows it and it was still declined, because the remaining ETH is
needed for deployment, the demo round and the recording, and no reviewer is going
to ask for the difference.

---

## 14. The equality run detected a difference that was not there

At n = 153 per arm the pooled chi-square crossed the threshold — 4.17 with Yates,
p = 0.041; 4.71 uncorrected, p = 0.030 — and the trend across the run looked like
a real effect rather than noise:

```
n per arm     64      89     121     153
spread      14.1     7.9    10.7    11.1  points
p (Yates)   0.113   0.308   0.082   0.041
```

The spread stayed in a band while p fell as n grew, which is what a genuine effect
does and what noise does not. On that reading the central claim was in trouble.

**It was my test that was wrong, not the contract.**

### 14.1 The confound

The arms are **fixed addresses**. Five winner addresses and five loser addresses,
measured over many rounds each. Per-arm low-gas rates within one batch:

| winner arms | rate  | loser arms | rate  |
| ----------- | ----- | ---------- | ----- |
| #0          | 21.1% | #1         | 36.8% |
| #2          | 47.4% | #3         | 10.5% |
| #4          | 15.8% | #5         | 21.1% |
| #6          | 57.9% | #7         | 26.3% |
| **mean**    | 35.5% | **mean**   | 23.7% |
| **sd**      | 20.3  | **sd**     | 11.0  |

**The variation within a side is far larger than the difference between sides.**
Winner arms run from 16% to 58%; the between-side gap is 11.9 points. Each address
has its own stable rate, which makes sense — the threshold is
`keccak256(R, drawId, address)`, so the address is an input to everything the
transaction does.

The chi-square treated 153 observations as independent. They are not: they are
about nineteen repeated measurements on each of eight fixed addresses. That is
pseudo-replication, and it inflates significance by roughly the ratio of
observations to true independent units.

The correct test compares **arms**, not observations:

```
winner mean 35.5%, loser mean 23.7%, difference 11.9 points
Welch t = 1.029, df = 4.6, two-sided p = 0.3545   NOT significant
```

### 14.2 What this costs and what replaces it

Every sample taken so far — 306 accruals, roughly 0.55 ETH — measured the wrong
thing. Not worthless: it establishes that the operation sequence and HCU are
exactly identical across 306 samples, which is structural and stands. But the gas
comparison it was built for cannot be made from it, because the design cannot
separate "winner versus loser" from "this address versus that address".

**The replacement is a paired design.** Instead of some addresses always winning
and others always losing, every address wins in some rounds and loses in others,
and each address is compared against itself. That removes the address effect by
construction rather than by adjusting for it afterwards.

It is arranged by setting `totalWeight` at reveal time to roughly twice the
window's actual weight, so each address's threshold lands above or below its
weight about half the time. The weight is computable exactly without decrypting
anything — it is `deposit x (snapshotAt_N - snapshotAt_{N-1})`, and both
timestamps are on chain.

**The lesson is the same one §11.1 recorded in a different costume.** There, two
errors cancelled and produced a number that looked right. Here, a wrong unit of
analysis produced a p-value that looked decisive. Both were caught by asking what
the number was actually measuring rather than whether it looked plausible.

---

## 15. The paired run: computed, costed, and declined

### 15.1 The power calculation

In a paired design the unit of analysis is still the address; the test runs on
per-address (win-round minus lose-round) differences, and the address effect
cancels by construction. What remains is binomial noise, so `SD(d) = sqrt(2p(1-p)/k)`
for `k` samples per side per address, and the standard error falls with the number
of **addresses**.

| addresses | per side | accruals | 80% power detects |
| --------- | -------- | -------- | ----------------- |
| 8         | 10       | 160      | ±23.1 points      |
| 8         | 25       | 400      | ±14.6 points      |
| **20**    | **10**   | **400**  | **±13.3 points**  |
| 12        | 25       | 600      | ±11.3 points      |
| 20        | 25       | 1000     | ±8.4 points       |

**More addresses beats more samples per address at equal cost.** A = 20 with k = 10
reaches ±13.3 on the same 400 accruals that A = 8 with k = 25 spends to reach only
±14.6, because the address effect is already cancelled and the remaining constraint
is degrees of freedom.

At the measured 0.00126 ETH and 13.2 seconds per transaction, A = 20, k = 10 is
520 transactions: **0.66 ETH and 1.9 hours.**

### 15.2 Declined, for three reasons in ascending order of weight

**Budget.** The wallet holds 0.8217 ETH. Spending 0.66 leaves 0.17 for deploying
the production pool, funding the reserve, funding and depositing six demo
participants, running a KMS draw on camera, and re-recording the video if the
first take is not usable. That work is about 0.15 ETH, so the margin would be
essentially nil against a hard submission requirement.

**The claim from existing data is already the right one**, and it costs nothing
further. See §15.3.

**The confirmation would have weaker provenance than the thing it confirms.** On
the real contract with A equal arms each address wins with probability 1/A — 5% at
A = 20 — so ten winning samples per address would take two hundred rounds. Getting
to a 50% win rate requires choosing `totalWeight` at reveal time, which only
`PrizePoolHarness.forceReveal` can do. So the paired run would necessarily measure
the harness, while §12.1 went out of its way to verify the reveal on the shipped
contract. Spending 0.66 ETH to add a measurement with a weaker chain of custody
than the argument it supports is the wrong trade.

### 15.3 The claim, as it stands today

> Across **306 live Sepolia accruals**, the FHE operation sequence and the HCU are
> **exactly identical** — one distinct value of each. Execution gas takes two
> values four apart, and that variation tracks the **address**, not the outcome:
> within-arm rates run from 16% to 58% against a between-arm difference of 11.9
> points, and on the correct unit of analysis Welch gives **t = 1.03, df = 4.6,
> p = 0.35**.
>
> The address is a public input to the threshold — `keccak256(R, drawId, address)` —
> so gas varying with it discloses nothing an observer does not already hold.

This is structural where it matters and statistical only where it has to be, and
it is stronger than GhostKey's equivalent in one respect: there the four-gas
residual was localised but unexplained, whereas here the variable it tracks is
identified and is public by construction.

### 15.4 What would change the decision

If a reviewer asks for the paired measurement, it is one command against the
existing harness — `A = 20, k = 10`, 0.66 ETH, 1.9 hours — and the power table
above says exactly what it would buy. The reason not to run it today is the
submission's shape, not doubt about the result.

---

## 16. Day 5 — deployed, and a live round end to end

### 16.1 The deployment

```
pool   0x307e2D1eA71C73FD4358622933880868BbCe05D0
token  0x056AC066e0770A7BE08eCAc73C09f811B067fc46
prize  25 per winner, reserve funded and encrypted
```

The **real** `ConfidentialPrizePool`, not the harness. The harness exists so CI can
reveal a draw without the KMS and has no business on an address a judge visits.

The demo token is our own ERC-7984 mock rather than Zama's deployed cUSDC, and
that is a trade worth naming rather than hiding. The mock has a public `mint`, so
a judge funds themselves in one click. The cUSDC path needs mint, approve and wrap
first, and E1 measured what that path does when a precondition is missing: a bare
`execution reverted` with nothing in it. The production path is documented and the
addresses are in `lib/addresses.ts`; it is simply not what a first-time visitor
meets.

### 16.2 One complete round, on chain

```
6 participants deposit 100, 200, 300, 400, 500, 600 — staggered
draw 1 opened          weights frozen, randomness drawn and still encrypted
KMS reveal             12.0 seconds
R                      16355410072577012541
totalWeight            300,000
accrueMany(6)          ONE transaction, 2,655,606 gas
winner                 the account that deposited 100
```

**The smallest depositor won, because they deposited first.** Deposits were
staggered by design — a time-weighted pool where everyone joins at the same
instant demonstrates nothing about time weighting — and holding 100 for the whole
window is worth about what holding 600 for the last fifth of it is. That is the
TWAB argument made visible in a single round, and it is what the video should show.

Six accruals in one transaction is 2,655,606 EVM gas and roughly 15.5M HCU,
comfortably under the 20M ceiling and consistent with the measured "seven fit,
six with headroom".

### 16.3 The frontend, and a bug a type cast was hiding

All six never-cut items from §9.4 are built: wallet connect with a network guard
that names both chains, deposit gated on its preconditions, withdraw, EIP-712
balance decryption, draw status, and the "draw in progress" state.

**One real bug, found by reading the SDK's types rather than trusting a cast.**
`Withdraw.tsx` reached for `enc.handles[0]`, which does not exist — the SDK
returns `{ encryptedValues, inputProof }`. It type-checked only because the call
carried an `as never`, so the error would have surfaced as a runtime failure in
front of whoever pressed Withdraw first. The cast is removed and both call sites
now use the real field.

That is the second time in this project a cast or a coincidence produced something
that looked correct — §11.1's cancelling errors, §14's wrong unit of analysis —
and the same habit caught all three: check what the thing actually is, not whether
it looks plausible.

### 16.4 What is verified, and what is not

**Verified:** TypeScript passes; the client bundle contains every panel; the dev
server serves the shell at HTTP 200; the contract path underneath each panel is
exercised by 30 local tests and a live round.

**Not verified: browser behaviour with a real wallet.** The app renders
client-only (`ssr: false`), so a fetch of the served HTML shows the shell and
nothing else — by design, and it means curl cannot check the panels. Connecting a
wallet, signing the EIP-712 permit, and watching a balance decrypt is a manual
pass that has not been done.

That, and the Vercel deployment that §13.3 could only infer would work, are the
first two things on day 6 — before the video depends on either.

---

## 17. Day 6 — deployed publicly, and the wall a judge would have hit

### 17.1 The Vercel build settles §13.3

`readyState: READY`. The local `next build` failure was environmental, exactly as
§13.3 inferred from GhostLend reproducing it — the Linux builder compiles the same
source without complaint. That inference is now a measurement.

**Live: https://ghostpool-himess.vercel.app**

### 17.2 The deployment served a Vercel login page, not the app

The first thing the deployed URL returned was `HTTP 200` with the title
**`Login – Vercel`**. Deployment Protection is on by default for this account, so
every visitor — including a judge — would have met an authentication wall instead
of GhostPool, while the deploy itself reported success.

This is precisely what I1 was for. Nothing in the build, the tests or the type
checker could have caught it: the deployment was correct and the *access policy*
was wrong.

Fixed with `vercel project protection disable --sso`. The URL now returns the real
title, and the lazily-loaded panel chunk (`/_next/static/chunks/3lrau_1e-gp5n.js`)
is served and contains every component — traversed from the served HTML rather
than assumed from the local build.

### 17.3 A naming collision worth knowing about

`ghostpool.vercel.app` is already taken, by an unrelated project called
**"GhostPool — Private Prediction Markets on Arbitrum"**. The submission's URL is
therefore `ghostpool-himess.vercel.app`.

Not a technical problem, but worth deciding deliberately rather than discovering
in a judging thread: the name is not unique in this ecosystem.

### 17.4 I3 needed no work

The demo reserve was funded at 10,000 against a prize of 25 — **400 prizes**. With
six participants and one expected winner per draw, the tail that §5.4 sizes for is
nowhere near it. No change made.

### 17.5 What still cannot be checked without a person

The browser pass with a real wallet. Everything checkable by machine now is:
TypeScript passes, the Vercel build succeeds, the URL is publicly reachable, the
served bundle contains every panel, and the contract path under each is covered by
30 local tests plus a live round.

What is not: connecting a wallet, the network guard firing and recovering, signing
the EIP-712 permit, a balance actually decrypting in a browser, rejecting a
signature mid-flow, and reloading during a pending transaction. **The relayer SDK
has never run in a browser in this project** — only in Node.

That is a human pass, and §16.3's `as never` bug is the argument for doing it
before the recording rather than during it.
