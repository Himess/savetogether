# SaveTogether — what an observer can learn

Self-contained: it repeats the facts it depends on, so it reads without the repo.

The claim this protocol makes is narrow and worth stating exactly: **an observer
cannot tell who won a draw.** It does not claim that nothing is observable. Three
things are, each is bounded below, and each is named here rather than left for a
reader to find.

The convention throughout is the one from SaveTogether: a residual that is understood
and bounded is stated; a residual that is merely small is still stated.

---

## 1. The central claim, and how it is established

Nobody claims a prize in this protocol. `accrue(user, drawId)` is permissionless,
unconditional and idempotent, and a keeper runs it for every participant. A
losing accrual and a winning one are the same transaction, differing only in an
encrypted comparison.

**Why claiming was removed rather than made cheap.** The per-user threshold is
`uniform(keccak256(R, drawId, address), totalWeight)`, and every input to it is
public. A participant can therefore compute their own result off chain with no
transaction at all — they know their own deposits and the timestamps are on
chain, so withholding an ACL on their balance would change nothing. A loser then
has no reason to claim, only winners would, and **"who claimed" would become "who
won"**. The leak returns on the cheapest observation available. Removing the
action removes the signal.

What must hold for the replacement to work is that a winning `accrue` and a
losing one are indistinguishable on chain. That is a measurement, not an
argument, and it is reported in `findings.md` §12.

---

## 2. Residual one — keeper liveness is a privacy property

If the keeper accrues everyone, nothing is observable. If it skips someone, that
participant can call `accrue` for themselves — and a standalone self-accrual is
weak evidence they won, because a loser has less reason to bother.

**Bound.** The leak exists only when the keeper fails. In the claim design it was
present in the normal case, so this is a strictly weaker exposure, but it is not
zero.

**Narrowed.** `deposit` and `withdraw` each drain the caller's pending credits
first, so anyone the keeper missed is swept up silently by their next ordinary
action. A standalone self-accrual survives only at the intersection of "the
keeper failed", "the user has no other reason to transact", and "they want the
credit reflected now".

**Operationally:** accrual should be completed for every participant before the
next draw opens, and a shortfall should be visible rather than silent.

---

## 3. Residual two — the aggregate reveal discloses a count, never an identity

`totalWeight` is revealed once per draw, because the threshold must be mapped
into `[0, totalWeight)` in plaintext. Between two draws with no deposits and no
withdrawals, the change in the revealed total is `winners × prize`.

**What that discloses is how many accounts won. It never discloses which.**
Mapping a threshold to a participant requires their weight, and weights stay
encrypted.

**Bound.** Ordinary deposit and withdrawal traffic masks the difference, because
the total moves for those reasons too and the movements are encrypted
individually. A completely quiet period between two draws does not mask it.

**Why it is not fixed.** There is a structural repair — count the reserve inside
`totalWeight` so paying a prize leaves the sum unchanged — but it requires
excluding the reserve from its own win check, rescaling the probability mass
across the remaining participants, and tying reserve accounting into the TWAB
record. That is a redesign, and a count is a materially weaker disclosure than an
identity. **Deliberately not built.**

---

## 4. Residual three — deferred fold-in puts transaction pressure on winners

`accrue` writes no observation. The credit waits in `_pending` and reaches the
balance on the participant's next `deposit` or `withdraw`, which was going to
write an observation anyway. That is a real saving — an observation costs
955,032 HCU and three cold storage slots.

**The dimension that saving obscures:** the time-weighted balance is computed
from `balance`, not from `_pending`. So a winner who never transacts earns no
weight on their prize in the following draw. That creates pressure, on winners
specifically, to transact.

This is the same shape as the leak §1 removed — a voluntary action that only
winners have reason to take — and it is named here for that reason rather than
because it is severe.

**The direct leak is absent.** `_drain` is unconditional and runs on every
deposit and withdrawal; draining an encrypted zero is the same transaction as
draining a prize. What is observable is the decision to transact at all:
post-draw transaction rates would differ between winners and losers.

**Bound, and why it is the weakest of the three:**

- Deposits and withdrawals happen for ordinary reasons, so the signal sits inside
  ordinary traffic rather than standing alone.
- Nothing is at risk while a credit waits. It is recorded and cannot be lost.
- `winningsOf` is readable by EIP-712, so **no one has to transact merely to learn
  whether they won**. The pressure is on compounding, not on discovery, and a
  participant indifferent to one draw's worth of weight has no reason to act.

**Not redesigned.** `accrue` is frozen for the equality run, and reopening it five
days from a deadline to close the weakest of three named residuals is the wrong
trade. It is written down instead, which is the standard this project holds
itself to.

---

## 5. What is public by construction

Not leaks — design decisions, listed so nothing looks like a discovery later.

| public                                    | why                                                             |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Who deposited, and when                   | deposits are ordinary transactions; `Deposited` carries the address |
| `totalWeight`, once per draw              | the threshold must be mapped into `[0, totalWeight)` in plaintext |
| `R`, once per draw                        | revealed through the KMS so the draw is auditable                |
| Every participant's threshold             | a pure function of the two above and their address               |
| The prize amount                          | fixed and plaintext; the reserve that funds it is encrypted      |
| That a participant was accrued            | the idempotence flag is plaintext, and accrual runs for everyone |

Individual balances, individual weights, individual outcomes, and the reserve
remain encrypted.

---

## 6. What ERC-7984 does not hide, and what follows

Every transfer variant in `ERC7984.sol` takes `address to` as a **plaintext**
parameter, and `_update` emits `ConfidentialTransfer(from, to, transferred)` at
line 322 with both endpoints in the clear. Only the amount is encrypted.

**Paying a winner by transfer would publish who won.** This is the source-level
reason the prize is an encrypted per-participant credit rather than a payment,
and it is not a matter of preference.

---

## 7. The vault leg publishes an exact aggregate

Measured 2026-09-03. This is a leak the pool itself does not create; it is inherited
from how Zama's deposit batcher settles, and this project's integration walks into it.

**What happens.** `SteakhouseReplicaSource.joinVault()` sends cUSDC into Zama's deposit
batcher. When the batch is dispatched, `dispatchBatchCallback(batchId, cleartextAmount,
proof)` carries the decrypted **aggregate** of that batch in cleartext calldata. With more
than one participant that aggregate hides everyone inside it. With exactly one, the sum of
one value is the value.

**Batch 286 had exactly one participant: this pool.** The chain therefore records that
SaveTogether supplied **6,000.000000 cUSDC** into the vault. Nine of the last ten deposit
batches on that batcher had a single participant, so this is the normal case rather than
an unlucky one.

Zama documents the property precisely, on
`docs.zama.org/protocol/confidential-vault/concepts/confidentiality`:

> **A lone depositor is fully revealed.** The dispatch gate is age-only, with no minimum
> participant count. A batch that reaches its minimum age with a single depositor reveals
> that depositor's exact amount when the aggregate is decrypted — the sum of one value is
> the value.

**What it costs, precisely.** No depositor's position is affected. Individual balances
never enter the batcher — only the pool's own supply does — so this discloses a
*pool-level aggregate*, in the same category as `totalWeight` (§3). Two differences
matter: `totalWeight` is published by our choice and defended in the README, this is not;
and this figure is more precise, being an exact cUSDC amount rather than a weight.

**Both mitigations were measured. Neither is shipped.**

| mitigation | measured cost | verdict |
|---|---|---|
| Wait for a batch that already has co-participants | 1 of 10 batches ever had more than one; expected wait **≈ 28 hours** per `joinVault` | unaffordable — the yield leg would stall |
| Pad the batch with encrypted-zero joins to an anonymity set of five | 1,271,270 gas and 0.001486 ETH per pad → **0.00594 ETH and four separately funded wallets** per join | roughly doubles the per-round cost (keeper burn is 0.005915 ETH/draw) and needs wallet infrastructure that does not exist |

Repeated joins from one address accumulate into a single position, so the padding wallets
cannot be reused within a batch. At this deployment's size neither pays for itself, so the
disclosure is the mitigation. Reproduce with the `Joined(uint256,address,bytes32)` logs on
`0x48758559c14d4d92b4C74A99660B6a8dbe85F53b` and by decoding `dispatchBatchCallback`
inside the operator's Multicall3 transactions.

---

## 8. A single balance change in a window is exactly recoverable from `totalWeight`

Confirmed on live data 2026-09-04, on draw 33 of the deployed pool. This is our own
measurement technique turned around: `STATE-NOW.md` §1 derives the pool's total
balance from `totalWeight / window` and uses it to validate a reading. The same
arithmetic recovers an individual.

### The near-miss, first — because almost right is indistinguishable from right

The first run of this attack filtered only `Deposited` and `Withdrawn`. It solved
**three** windows and printed all three with the same confidence:

| draw | solved | true | |
|---|---|---|---|
| 33 | **540.000000** | 540 | correct |
| 34 | 543.242947 | 250 | **wrong** |
| 36 | 219.000000 | 200 | **wrong** |

Nothing about the two wrong ones looked wrong. They carried the right number of
decimals, sat in a plausible range, and one of them even reported `exact: true`
against its own arithmetic. Only checking them against the depositors' real amounts
separated them from the correct one.

The cause: **`Claimed` moves a balance too.** `_drain` folds a pending credit into
the balance and pushes an observation, so a claim shifts `totalWeight` exactly as a
deposit does. An incomplete filter under-counts the events in a window, so a window
with two changes looks like a window with one, and the residual gets attributed
entirely to the event the filter happened to see.

With the complete filter, one window qualifies and it is exact. **The attack is easy
to get almost right, and an almost-right answer here is a confident wrong number
about somebody's balance** — which is worth stating before the arithmetic, because
anyone reproducing this will hit it.

### The equation

`totalWeight` is the sum of balance-seconds over the window, so for a window
containing one balance-changing event:

```
totalWeight_N = prevBalance × window + delta × (snapshotAt − eventTime)
```

Everything except `delta` is public:

| term | where it comes from |
|---|---|
| `window`, `snapshotAt` | `drawAt(N)` — published |
| `eventTime` | the block timestamp of the `Deposited` / `Withdrawn` / `Claimed` log |
| `prevBalance` | `totalWeight / window` of the previous revealed draw |
| `totalWeight_N` | published at reveal |

So `delta` is the only unknown, and the equation **solves rather than bounds**.

### Worked, on a real draw

```
draw 33: window 7500s, one deposit at +7476s
  carried-in balance : 19000 cUSDC      (from draw 32's totalWeight / window)
  totalWeight        : 142512960000000
  base if unchanged  : 142500000000000
  residual           :     12960000000
  residual / 24s     : 540.000000 cUSDC   — integer-exact
```

Cross-checked against that depositor's **own decrypted observation record**: their
balance moved `12,000 → 12,540`. Delta **540**. Recovered from public data alone,
to the unit. `scripts/x1-window-solve.ts` reproduces it.

### The exact conditions

It requires **all** of:

1. A window containing exactly **one** balance-changing event. `Claimed` counts —
   `_drain` folds a pending credit into the balance and pushes an observation, so a
   claim moves `totalWeight` exactly as a deposit does. A first pass that filtered
   only `Deposited`/`Withdrawn` mis-attributed the residual and produced wrong
   figures for two other draws; the complete filter left one window, and that one is
   exact.
2. The previous draw revealed, so `prevBalance` is available.
3. `prevBalance` dividing evenly into the previous window — otherwise integer
   truncation propagates and the answer is close but not exact.

With six depositors and a draw roughly every 44 minutes, most windows carry zero or one
event, so condition 1 is met often.

**But "often" is not the measured number, and the measured number is smaller.** Over the
run recorded in `out/x1-window-solve.json`: **12 balance-changing events, 1 solved
exactly.** All three conditions have to hold together, and conditions 2 and 3 — a
revealed predecessor and a previous balance that divides evenly into the previous window
— knock out most of the windows condition 1 lets through.

An earlier version of this paragraph said condition 1 being common made the attack
common. It does not: the attack is rare and *exact when it lands*, which is a different
and more useful claim. Rarity is also not a mitigation — nothing in the contract enforces
a minimum anonymity set, so the frequency is a property of how busy the pool happens to
be rather than of anything it guarantees.

### What it recovers, precisely

The **balance delta**, not the deposit amount. Those differ when a transaction moves
more than one thing: draw 33's 540 was a 500 cUSDC deposit plus a 40 cUSDC pending
credit that `deposit` drained in the same call. An observer learns 540 and cannot
split it — which narrows the disclosure slightly and does not remove it.

### The mitigation, honestly

The anonymity set is **the number of participants who change balance in the same
window**. It grows with participation and nothing in the contract enforces a minimum.
At six depositors it is frequently one.

**Not encrypting `totalWeight`.** That was measured at 8.3× and rejected because it
removes public auditability of the draw — the trade has not changed and this finding
does not change it. What changes is the honest statement of the boundary: the
aggregate is underdetermined **only when several people move in the same window**.

### Not fixed by batching deposits

Batching the pool's own deposits would protect a reveal that does not exist here — a
deposit enters as `euint64` and is never decrypted, which is precisely why Zama
batches and we do not need to. And against this finding it fails for Zama's own
documented reason: *"a lone depositor is fully revealed; the sum of one value is the
value."* A single-participant batch is a single-event window. Batching schedules
co-participants; it does not create them.
