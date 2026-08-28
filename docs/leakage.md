# GhostPool — what an observer can learn

Self-contained: it repeats the facts it depends on, so it reads without the repo.

The claim this protocol makes is narrow and worth stating exactly: **an observer
cannot tell who won a draw.** It does not claim that nothing is observable. Three
things are, each is bounded below, and each is named here rather than left for a
reader to find.

The convention throughout is the one from GhostKey: a residual that is understood
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
