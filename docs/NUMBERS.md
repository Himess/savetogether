# Numbers of record

Every figure this project publishes, with **what produced it** and **when**. Regenerate
before submission; quote from here rather than restating.

This file exists because an audit found the same figure circulating in three or four
versions across the README, the deck, `rubric.md` and the site — tests as 200 / 207 /
154, accrual gas as four different numbers — and concluded, correctly, that *a reviewer
who finds three versions of one number stops trusting the ones that are right, and most
of them are right.*

**Read the method column.** Several disagreements here were never really disagreements:
they were a computed figure and a measured one, in different units, both correct, both
labelled as though they were the same thing.

Last regenerated: **4 September 2026**, against pool
`0x894F6492357277CF36e9973787663AE9F73387BE`.

---

## 1. The trap this file was written for: HCU is not gas

| figure | value | date | produced by | method |
|---|---|---|---|---|
| Solvency bit, **HCU** | 116,000 | 2026-09-03 | Zama's published HCU table | `FHE.ge(euint64, scalar)`, the operation alone |
| Solvency bit, **gas** | **+466,825** | 2026-09-04 | `openDraw` measured before/after on the same fixture | end-to-end transaction cost |

**Four times the estimate, and both numbers are right.** The HCU figure prices the FHE
operation. The gas figure is what a keeper actually pays, and it also carries a cold
`SSTORE` for `solventAt[drawId]`, an `FHE.allowThis`, and the `makePubliclyDecryptable`
call. Neither is wrong; quoting the first as though it were the second is.

**Rule.** An HCU number answers "will this fit in the 20M per-transaction budget". A gas
number answers "what does this cost to run". Never substitute one for the other, and
never publish an HCU figure as a cost to an operator.

---

## 2. Tests

| figure | value | date | produced by |
|---|---|---|---|
| Suite total | **212 passing, 1 pending** | 2026-09-04 | `npm test` — 118 (`test:pool`) + 94 (`test:session`) |

Previously published as 200 (badge), 154 (README) and 207 (deck) simultaneously. 207 was
correct before the CD redeploy added `cd-keeper-fee-and-acl.ts` (4) and a
`withdraw(max)` case (1).

---

## 3. Gas, measured on the harness

Same fixture, before and after the CD changes. Local harness with mocked FHE — see §4
for why these are not the operator's numbers.

| site | before | after | delta |
|---|---|---|---|
| `accrue` | 501,148 (win) / 501,136 (loss) | unchanged | **0** |
| `openDraw` | 331,881 | 798,706 | +466,825 |
| `withdraw` | 918,857 | 885,364 | −33,493 |

`accrue`'s winner/loser gap is **12 gas**, before and after — intrinsic calldata, not
outcome. That is the frozen-surface property, and it is checked by `test/frozen-surface.ts`
rather than asserted.

---

## 4. Gas, measured on Sepolia — and the figure that has no source

| figure | value | date | produced by |
|---|---|---|---|
| `accrueMany(1)` | **648,832 / 817,720 / 1,043,326** | 2026-09-04 | three live transactions on the new pool |
| `openDraw` | 893,808 | 2026-09-04 | `0x580d60af…` |
| `revealDraw` | 862,214 | 2026-09-04 | `0x31ce709c…` |
| `harvest` | 776,957 | 2026-09-04 | `0xa4ff6cb8…` |
| `withdraw(max)` | 1,932,505 | 2026-09-04 | `0xb883d112…` |
| Keeper, full round | **0.005915 ETH** | 2026-09-03 | `bundle/STATE-NOW.md` §6, the keeper's own spend |

> ### ⚠ `386,608` has no artifact, and live measurement contradicts it
>
> The README, `rubric.md` and the deck have quoted **386,608 gas per accrual**, and
> built a headline on it: *"a hundred participants is 38.7M gas per draw — over a
> block."*
>
> Searching every test, spike, script and output file for that number returns **one
> prose comment** in `scripts/seed-participants.ts`. Nothing produces it.
>
> The three live `accrueMany(1)` transactions above cost **648,832 to 1,043,326** —
> roughly 1.7× to 2.7× the quoted figure. The spread is expected and documented:
> accrual cost tracks the length of that account's observation history, never the
> outcome. The quoted constant is not.
>
> The O(participants) limitation is **real and unchanged** — that is the property, and
> it does not depend on the constant. What has to go is the specific number and the
> "38.7M gas per draw" arithmetic built on it. Replacing it needs a measured
> `accrueMany(1..7)` curve, which needs more participants than the live pool currently
> has (2). **Until that curve exists, cite the range above and the property, not a
> constant.**

> ### ⚠ Two citations do not survive being followed
>
> `docs/rubric.md` cites `test/storage-cost.ts` for the HCU and per-accrual gas figures.
> That file's own header says: *"the FHE operations inside these transactions are mocked
> here and their gas is NOT comparable."* It cannot produce those numbers and says so.

---

## 5. HCU budget

| site | HCU | ceiling | headroom |
|---|---|---|---|
| `accrue`, cold, 3 tiers | 3,947,224 | 20,000,000 | ~0 — 5 per transaction |
| `openDraw` | ~2,190,000 | 20,000,000 | **~17,800,000** |

**The structural fact.** Anything added to `accrue` costs keeper throughput linearly;
anything added to `openDraw` is effectively free. Every change accepted in the CD pass
lives in `openDraw`, and the one that would have cost a batch slot — the per-user clamp
counter, +188,000 HCU — was deferred for that reason and one more: it changes `accrue`'s
operation sequence, which would invalidate the 312-sample study in §6.

---

## 6. Confidentiality measurements

| figure | value | date | produced by | method |
|---|---|---|---|---|
| Indistinguishability samples | **312** (81 won, 231 did not) | 2026-09-04 | `test/c1-indistinguishability.ts` | **local**, full sample size |
| Within-draw separations | **0** | 2026-09-04 | same | distinct values 2/2, identical both sides |
| Live winner/loser pair | 684,273 = 684,273 | 2026-08 | `0x1ef0e39d…`, `0xc22520c2…` | **Sepolia**, one pair |
| Equality-clamp study | **180** (60 per path) | 2026-08 | `docs/architecture.md` §3 | three-path clamp |
| Accrual equality study | **306** | 2026-08 | `findings.md` §14 | 19 repeats on 8 addresses |

**The 312 study is local, not live.** The deck said "312 live accruals" until 4 September;
it is corrected. A Sepolia run at that sample size costs about **0.33 ETH** at tiered
accrual cost, which is why it runs locally. The *pair* above is live.

**306 and 180 are different studies.** The README once cited 306 for the clamp result;
306 is the accrual equality run, 180 is the clamp run.

**The pseudo-replication correction.** The 306-sample run first returned a chi-square over
threshold. The unit of analysis was wrong — 19 repeats on 8 fixed addresses, not 306
independent observations. Corrected: Welch **t = 1.03, df = 4.6, p = 0.35**. A null,
published after the significant result turned out to be an artifact.

---

## 7. Leakage

| figure | value | date | produced by |
|---|---|---|---|
| `totalWeight` window solve | **12 balance events, 1 solved exactly** | 2026-09-03 | `out/x1-window-solve.json` |
| Recovered amount | **540.000000 cUSDC**, integer-exact | 2026-09-03 | draw 33, cross-checked against the holder's own record |
| Same, on the redeployed pool | **12 events, 0 single-event windows, 0 solved** | 2026-09-04 | the live run on the Break screen |
| Cost of encrypting `totalWeight` | **8.3×** | 2026-08 | `spikes/a2-encrypted-total.ts` |
| Cost of a noise pad in `openDraw` | ~0.98M HCU | 2026-09-04 | costed, **not shipped** |
| `can_afford` binary search | **40 probes** ≈ log₂(10¹²) | 2026-08 | closed by `COARSE_BUCKET = 50,000,000` |

**"The common case" was an unsupported qualifier.** `docs/leakage.md` §8 said single-event
windows are common, and inferred the attack was. Conditions 2 and 3 knock out most of what
condition 1 lets through: **1 in 12**. Rare, exact when it lands, and rarity is not a
mitigation — nothing enforces a minimum anonymity set.

---

## 8. The pool, as deployed

| figure | value | date | produced by |
|---|---|---|---|
| Pool | `0x894F6492357277CF36e9973787663AE9F73387BE` | 2026-09-04 | `out/deployment.json` |
| Yield source | `0xB16EB979231A95C2Ad454Ebd456b4c5AD23811Ba` | 2026-09-04 | same |
| Session module | `0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6` | 2026-08 | unchanged by the redeploy |
| Vault batch | **301**, settled | 2026-09-04 | `out/cd-join-vault.json` |
| Tier prizes | 25 / 5 / 1 cUSDC | 2026-09-04 | `setTiers` |
| Tier k | 100 / 10 / 1 | 2026-09-04 | same |
| Keeper fee | 0.2 cUSDC per `accrueMany` **that does work** | 2026-09-04 | `keeperFee()` |
| `minPeriod` | 300 s | 2026-09-04 | `minPeriod()` — a **floor**, not a cadence |
| Observed cadence | **~41 min** (median of the last 8) | 2026-09-03 | the keeper waits on Zama's batcher |
| Clamp risk | 3.2–3.6% per configuration, **97.3% on a first draw** | 2026-08 | `docs/tier-derivation.md` §6, 20,000 trials |
| Keeper runway | 10.48 ETH ≈ **1,771 draws** ≈ 50 days | 2026-09-04 | balance ÷ 0.005915 |

**`minPeriod` is not the cadence.** Any statement of the form "a draw every five minutes"
is not what this deployment does. The floor is 300 s; the observed spacing is ~41 minutes,
because the keeper waits on Zama's batcher between rounds.

---

## 9. Figures that are correct and were checked

Stated so the ratio of warnings to figures is not mistaken for the ratio of wrong to
right. Each of these was followed to its artifact and held: the `can_afford` chain end to
end (40 probes, `COARSE_BUCKET`, the 37.512345 residue), **21** standalone experiments,
**17** MCP tools, the vault composition (`totalAssets` / `totalSupply`, ten settled
batches, share price 1.0), the tier math (`E[winners of tier t] = 1/k[t]`, the sole-holder
percentages, both break-even checks, 4.0×), and the 30.2% versus 3.2–3.6% simulation over
20,000 trials.

---

## How to regenerate

```bash
npm test                                              # §2
npx hardhat test test/frozen-surface.ts               # §3, and the winner/loser gap
npx hardhat run scripts/cd-exercise.ts --network sepolia   # §4 live gas
npx hardhat test test/c1-indistinguishability.ts      # §6
npx hardhat run scripts/x1-window-solve.ts --network sepolia  # §7
cat out/deployment.json                               # §8
```

Anything that cannot be regenerated by a command in this list does not belong in this
file.
