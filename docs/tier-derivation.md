# Where the tier sizes come from

`ConfidentialPrizePool.sol` refers to this file, so it exists to carry the
arithmetic rather than to restate the conclusion. The short version: **the prizes
are derived from the harvest, and choosing them instead is what made this pool
run for hours paying nothing.**

## 1. The inputs, all public

`totalWeight` is published at every reveal and the draw window is public, so the
aggregate balance is a public quantity — `totalWeight / window` — and does not
have to be taken on trust.

```
B      = 12,401 cUSDC        total balance, read from four consecutive draws
rate   = 100,000 bps         1000%/yr, immutable on the source
period = 1800 s              keeper cadence

H = B × rate × period / (10000 × 365 days) = 7.0782 cUSDC per round
```

## 2. What `k` means, derived

With `threshold(t) = uniform(keccak(r, drawId, user, t), totalWeight × k[t])`:

```
P(user i wins tier t) = weight_i / (totalWeight × k[t])
```

Summing over every participant, the `weight_i` collapse into `totalWeight`:

```
E[winners of tier t per draw] = 1 / k[t]
```

**`k[t]` is literally "one winner every `k[t]` draws", and it is
distribution-free** — the schedule does not move when a whale arrives or leaves,
only who tends to be on it. Verified on the live pool: a sole holder's odds print
as 1.000% / 10.000% / 100.000% for `k = [100, 10, 1]`.

## 3. Solvency

Awarding only the best tier cleared, the expected payout per draw is bounded by

```
E ≤ Σ_t prize[t] / k[t]
```

and the constraint is `E ≤ H`. This is the easy half.

## 4. Variance is the binding constraint, not solvency

A single reserve sized by the *average* payout still has to absorb a prize that
fires once every `k[0]` draws. The reserve starts empty and grows at `s = H − E`:

```
rounds until the reserve covers the grand prize = G / s
P(tier 0 fires before it can be paid)          ≈ (G/s) / k[0]
G ≤ 0.05 · k[0] · s        for that to stay under 5%
```

If it fires early, `FHESafeMath.tryDecrease` declines and the winner is credited
**zero, silently**, because a declined decrease is what losing looks like.

### Why PoolTogether does not have this problem

V5 **does not carry a fixed prize against accumulated liquidity — the prize IS
the accumulated tier liquidity, divided by the prize count.** Each tier accrues
its own share and pays what it has, so a shortfall cannot arise. Ours is a
plaintext `uint64`. That single difference is the whole reason tier sizing is
delicate here and routine there.

**What blocks closing it is narrower than this used to say.** The old wording blamed
`FHE.div` being "scalar-only", which is backwards: the library declares
`div(euint64 a, uint64 b)` and has no `euint64/euint64` form, so a **plaintext divisor
is exactly the supported shape**. What cannot be expressed is *V5's* denominator — the
realised winner count — because that is encrypted. V5's literal mechanism does not port.

A fixed plaintext divisor `C_t` does. `prize_t = FHE.div(_reserve, C_t)` computed **once
per draw** costs three divisions at 715,000 HCU each — about 2.1M against a 20M ceiling,
depth 715,000 against 5M — and leaves per-accrual cost unchanged, because
`FHE.select(won, encPrize, credit)` costs the same 55,000 as selecting a plaintext
constant. Publish `C_t` and the *rule* stays auditable while the level goes private,
which is V5's structure. It would also reduce leakage: `Δ totalWeight = winners × prize`
against known prizes 25/5/1 usually decomposes uniquely, and encrypted per-draw-varying
prizes give that equation more unknowns than equations.

The honest caveat is that one pot plus N simultaneous winners still draws N × prize, so
this bounds the clamp rather than removing it — `C_0 ≥ 4` makes the *first* clamp
impossible by construction, which is the 97.3% case. It needs a rewrite of what
`setTiers` and `winningsOf` mean. On the roadmap, not in this contract.

### Per-tier reserves were measured and rejected

The obvious fix, built before being argued against — `spikes/b0-tier-reserves.ts`:

| shape | HCU | per accrual | cold accruals/tx |
| --- | --- | --- | --- |
| 3 tiers, one reserve | 615,000 | 3,947,224 | **5** |
| 3 tiers, per-tier reserves | 2,229,000 | 5,561,224 | **3** |

40% of keeper throughput, and it does not fix the thing it looks like it fixes:
with a fixed prize, a dedicated tier-0 reserve still reaches `G` only after
`G/s₀` rounds. **The mismatch is the fixed prize, not the shape of the pot.**

## 5. Solving it

| a (every draw) | b (every 10) | G allowed | E | utilisation | P(clamp) |
| --- | --- | --- | --- | --- | --- |
| 2 | 10 | 19.4 | 4.00 | 57% | **32%** ✗ |
| 2 | 8 | 20.4 | 3.00 | 42% | 4.9% |
| **1** | **5** | **26.6** | **1.75** | **24.7%** | **4.7%** ✓ |

The first row is the configuration that *looks* right — a 100 cUSDC grand prize
using 57% of the harvest — and it carries a one-in-three chance of a silent zero
in the first sixteen hours.

**Shipped: `k = [100, 10, 1]`, `prizes = [25, 5, 1] cUSDC`.** The low utilisation
is not slack; it is the variance buffer. After one day the reserve holds ~256
cUSDC, ten grand prizes.

## 6. Simulated, because the 4.7% was an expected-path number

`spikes/y2-reserve-simulation.ts`, 20,000 trials of the real process:

| configuration | any clamp | tier-0 clamp | first clamp |
| --- | --- | --- | --- |
| **[25, 5, 1]** | 3.2–3.6% | 3.2% | median round 2, p90 round 4 |
| [100, 10, 2] (rejected) | 30.2% | 21.4% | median round 5, p90 round 21 |

The 10-, 50- and 288-round horizons report the same figure, which is the useful
part: **all of the risk is a startup transient and it is over in about four
rounds.** Robust to distribution — 20 and 100 equal participants move tier-0 clamp
from 3.2% to 3.9%.

## 7. The correction the live pool forced

The simulation gave round 1 a full harvest. It does not get one: the source is
deployed moments before the first draw, so the first harvest covers about zero
seconds. **Draw 1 of the live tiered pool said WIN tier 1 under the public rule
and credited the winner zero.**

Corrected, the figure is not 3.2% but **97.3%**, first clamp at round 1 in every
trial — because a sole depositor wins the ordinary tier with certainty and there
is nothing to pay from. No prize sizing fixes that.

**The fix is sequencing, not sizing.** The keeper now holds the first draw until
the source has accrued a full period, and logs that it is doing so. One line, no
contract change.

## 8. What an operator has to watch

```
break-even principal = E × 10000 × 365 days / (rateBps × period)
                     = 1.75 × 10000 × 31,536,000 / (100,000 × 1800)
                     = 3,066 cUSDC          against 12,401 held — 4.0× headroom
```

The keeper prints this every time it harvests, alongside the grand prize the
reserve must cover. The actual reserve is encrypted and cannot be read, so this
estimate is the only warning that exists — which is why the diagnostic silently
dying (it read `pool.prize()` after the pool grew tiers, and the catch swallowed
the error) was itself worth a fix.

**Tier sizes are only valid against a stated principal.** Most of the 12,401 is
the deployer's seed; withdrawing it during a submission window pushes utilisation
up and the warm-up out, silently.
