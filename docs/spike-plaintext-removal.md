# Spike — can the plaintext be removed entirely?

**Status: NOT STARTED. Scheduled for 31 August 2026.** M5 and the video come
first, and the sequence has not changed.

Research only. No production code, no contract change, no deployment. Spikes and
measurements are expected; an implementation is not. The decision comes after the
numbers.

`findings.md` is the source of truth and overrides anything here that
contradicts it.

## The question

`createEncryptedInput` needs a plaintext, so whoever encrypts sees the amount.
That forces a choice: encrypt in the browser (a tab must stay open) or encrypt on
a server (the server sees the number, which is the product's whole claim).

There may be a third option. The contract already holds the balance as `euint64`,
so a relative amount could be computed on chain and never exist in the clear
anywhere:

```solidity
depositAll()                              // no amount parameter at all
depositFraction(uint8 num, uint8 den)     // or a shift, if division is unavailable
```

If this works there is no plaintext in the browser, on any server, or in the
model's context — and the tab requirement disappears with it.

For contrast: MoonPay's PayBox solves the same UX problem with MPC key shares in
hardware enclaves plus a passkey, on top of a company acquired for about $100M.
They can let their server see amounts because their chains are transparent and
there is no amount privacy to lose. Ours is the product. That is why the question
matters here and not there.

## R1 — fractional arithmetic on a ciphertext  *(the gate)*

Establish what is actually available in the installed `@fhevm/solidity`. **Read
the source; do not answer from memory.**

- `FHE.shr(euint64, uint8)` — halves, quarters, eighths
- `FHE.div` / `FHE.mul` by a plaintext scalar, and what they cost
- Whether any of it needs a plaintext denominator

Report exact signatures with `file:line` and the HCU cost of each.

**If the arithmetic is not there, stop and report.** Everything below depends on
it and half an hour should settle it.

## R2 — what it would cost

Measure `depositAll()` and a fractional deposit on live Sepolia against the
harness, not by calculation. §11.1's lesson stands: a figure that lands near the
truth because two errors cancel supports nothing.

Compare against the current deposit path, so the change's price and its purchase
are both visible.

## R3 — does it touch the frozen surface?

`accrue`, `_snapshotCumulative`, `_cumulativeAt`, `thresholdFor`, `_uniform`. The
306-sample equality result depends on these staying byte-identical.

If a fractional deposit path can sit beside them the way `harvest()` does, say so
with the same filtered-diff check used for the yield integration. If it cannot,
that is close to disqualifying and must be said plainly.

## R4 — what still leaks

A parameterless `depositAll()` discloses that the user deposited their entire
balance — a fact, not an amount, but a fact. `depositFraction(1,2)` discloses the
fraction. Work out precisely what each variant reveals and how that compares with
what an observer already holds from the public transfer graph.

## R5 — does it actually remove the tab?

Trace the full path for *"put half my balance in the pool"* under this design and
confirm no step needs a client-side plaintext or a client-side encryption. If a
signature is still required from somewhere, name where. Do not assume the
conclusion.

## Verdict

A plain recommendation with the numbers behind it. Three outcomes are all
acceptable:

- **Viable** — works, costs little, touches nothing frozen. Then implement.
- **Viable but expensive** — state the cost so it can be weighed against the tab.
- **Not viable** — say why. Drop the idea and keep the local install, which works
  today.

**A negative result is a good result.** Do not shape the answer toward the
design; the point of measuring is that we might throw it away.

## Constraints

- No changes to `ConfidentialPrizePool` or `SaveTogetherSession` outside a scratch harness
- No deployment to the live pool
- Nothing merged
- Timebox: a few hours, gated on R1
