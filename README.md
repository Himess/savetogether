# SaveTogether

**No-loss prize savings where your balance, your odds, and whether you won all stay encrypted.**

Deposit a confidential ERC-7984 token. Your principal is never at risk — only the
yield funds prizes. Every period a winner is drawn, weighted by how much you held
and for how long. Nobody can see your balance, your odds, or your result. Not other
depositors, not the keeper, not the pool.

Built on [Zama FHEVM](https://docs.zama.org/protocol) for the Developer Program,
Season 4.

| | |
| --- | --- |
| **Live** | **https://ghostpool-himess.vercel.app** |
| **Pool** | [`0x1d8A0d653027833E4e8eA4DE67B90512Aad7B85f`](https://sepolia.etherscan.io/address/0x1d8A0d653027833E4e8eA4DE67B90512Aad7B85f) |
| **Settles in** | cUSDC — Zama's own confidential USDC, [`0x7c5BF43B…3639`](https://sepolia.etherscan.io/address/0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639) |
| **Yield source** | [`0x15331b79…e8A5`](https://sepolia.etherscan.io/address/0x15331b79E80EF6606a1aD4C0b13F7EA49482e8A5) — a Steakhouse Confidential Prime replica, wired into the vault below |
| **Zama's vault batcher** | [`0x48758559…F53b`](https://sepolia.etherscan.io/address/0x48758559c14d4d92b4C74A99660B6a8dbe85F53b) — the pool's principal is in [batch 281](https://sepolia.etherscan.io/tx/0xeb71ffb5ad7165f88ec1b97a702cc261036da148bb1c9d684fc6dc262782de15) |
| **Session module** | [`0xE5c667c0…6Cf6`](https://sepolia.etherscan.io/address/0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6) |
| **Network** | Sepolia (11155111) |

---

## Talking to it

The pool has a second front door: you can just say what you want.

```
you    open a session with a 500 cUSDC budget
you    what's the draw status?
you    put half my balance in the pool
```

Connect a wallet, sign once, paste a URL into Claude's connector settings. No
terminal, no npm, no tab kept open.

### The key we hold cannot do more than the chain lets it

A server holds a session key. That is worth being precise about rather than
reassuring about, because "we store your key safely" is the sentence every
custodial product says right before it turns out not to be true.

We are not asking you to trust the storage. **Your wallet key never leaves your
browser** — the server has never held one and has no code path that accepts one.
What it holds is a session key whose authority is bounded on chain:

- every spend is clamped against an `euint64` **nobody can read**, including us
- an allowlist bounds where value can go
- an expiry bounds how long, capped at 24 hours
- **you close it from your own wallet**, needing nothing from us

The nearest thing to this in production is MoonPay's PayBox, which reaches a
comparable experience with MPC key shares in hardware enclaves plus a passkey,
built on a company acquired for roughly $100M. Their limits are enforced by their
policy layer — code they run, that you cannot inspect while it runs. Ours are
enforced by a contract, and **the limit itself is encrypted**: the clamp is
measured across 306 live samples with an identical operation sequence and
identical HCU whether a spend fits, exceeds the budget, or exceeds the balance.

And the part that is not reassuring: **a compromised server can spend up to the
remaining budget, to the addresses already on your allowlist, until you revoke.**
It cannot exceed the budget, cannot send anywhere else, cannot extend its own
expiry, and cannot touch anything outside the session. That is the bound. It is
not zero.

### What the server sees

It encrypts the amounts, so it sees them. Two cases, and they are not the same:

- **"deposit 200"** — you typed it, the model already has it, the server learning
  it adds no reader.
- **"deposit half my balance"** — a real loss. The server reads your balance to
  halve it. The reference mechanism still keeps the figure from the *model*; it
  does not keep it from *us*.

We asked whether that could be removed — whether the arithmetic could happen on
chain so no plaintext exists anywhere — and measured the answer. It can, it is
even cheaper, and it is **worse**: doing it publishes the *ratio*, which composes
with the public wrap into an exact amount, forever. The measurements are in
[`docs/spike-plaintext-removal-RESULT.md`](docs/spike-plaintext-removal-RESULT.md)
and the full disclosure table is in
[`docs/session-leakage.md`](docs/session-leakage.md) §6.

### The local install still works, and that is the point

```
savetogether init --rpc <url>
savetogether console
```

Same contracts, same SDK, same tools. Running it yourself is the fallback when
hosting is down — and more usefully, it is the reason the claims above are
checkable instead of promised. The server is not load-bearing, and you can prove
that by not using it.

---

## Try it in thirty seconds

1. Connect a wallet on Sepolia.
2. Press **Get 1,000** — the demo token has a public `mint`, so you fund yourself.
3. Press **Authorise**, then **Deposit**.
4. Press **Decrypt my balances** and sign once. Your position is readable by you and
   by nobody else.

### About the demo token

**The pool takes any ERC-7984 token.** The one deployed here is our own mock,
chosen so a first-time visitor can fund themselves in a single click.

The production path is Zama's deployed cUSDC
(`0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639`, with its underlying at
`0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF`), and both addresses are wired into
`frontend/lib/addresses.ts`. That path needs mint, approve and wrap before anything
happens — and we measured what it does when a precondition is missing: a bare
`execution reverted` with no reason attached. That is a poor first thirty seconds,
so it is not what the demo puts in front of you. The deposit screen supports it.

---

## The idea, and the one thing that makes it hard

A prize pool needs to pick a winner in proportion to each participant's weight.
With encrypted balances, the obvious construction — accumulate a running total,
find which range the random number lands in — needs a global ordering over
ciphertexts, and it does not survive people withdrawing mid-period.

**PoolTogether V5 does not do that, and never did.** Its `TierCalculationLib` gives
each user an independent pseudo-random number from `keccak256(drawId, vault, user,
…, winningRandomNumber)`, maps it uniformly into `[0, totalSupply)`, and compares
it against a zone scaled by that user's own time-weighted balance. Every user is
evaluated alone. There is no cross-user aggregation anywhere in the check.

That structure ports to FHE almost unchanged:

```solidity
threshold_i = uniform(keccak256(R, drawId, user), totalWeight)   // plaintext, public
isWinner_i  = FHE.gt(E(twab_i), threshold_i)                     // encrypted weight
credit_i    = FHE.select(isWinner_i, prize, 0)                   // encrypted result
```

`P(user i wins) = twab_i / totalWeight`, exactly the weighting the design calls for,
with one expected winner per draw. No prefix sums, no global ordering, no chunked
draw. The draw transaction is one call to `FHE.randEuint64()` and a KMS reveal —
**nothing per participant**.

---

## Nobody claims a prize, and that is a security property

The threshold above is a pure function of public inputs, so **a participant can
work out their own result off chain with no transaction at all.** They know their
own deposits and the timestamps are on chain.

A loser therefore has no reason to claim. Under rational behaviour only winners
would, and **"who claimed" would become "who won"** — the leak returns on the
cheapest observation available.

So there is no claim. `accrue(user, drawId)` is permissionless, unconditional and
idempotent, and a keeper runs it for every participant, winner or not. A losing
accrual and a winning one are the same transaction differing only in an encrypted
comparison. The prize compounds straight into the confidential balance, so there is
no separate withdrawal whose timing could be correlated with a draw.

---

### If you are the only depositor, you win every round

Worth saying before it is noticed, because it looks rigged and is not. The
threshold is drawn uniformly from [0, totalWeight), and a lone holder's weight IS
the total — so it is always above their threshold. That is the weighted draw
being correct: they hold all of the weight. Odds only start meaning anything once
somebody else is in.

Making a sole participant lose would be the wrong behaviour, not a fix.

## Where the prize comes from

Yield, on the pool's own deposits. Principal does not sit in the pool — it goes
to a yield source the moment it arrives, and `harvest()` moves what it has earned
into the reserve the prizes are paid from.

### The product this replicates, and what is actually ours

On mainnet, confidential USDC earns in **Steakhouse Confidential Prime**, a
Morpho vault. That vault is mainnet-only. So the shape of it was rebuilt on
Sepolia and the prize pool put on top — which is the whole idea: the earning
product already exists, and this adds *no-loss prize savings* to it.

`SteakhouseReplicaSource` is that replica, and it is deliberately one contract
doing two jobs, because an earlier design split them and had to ship the wrong
half:

| | |
| --- | --- |
| **The vault composition** | **Real.** `joinVault()` sends the pool's principal into Zama's deployed deposit batcher and real shares come back when their keeper dispatches the batch. |
| **The rate** | **Ours.** Zama's Sepolia vault has no yield adapter — measured, not assumed — so nothing about it appreciates. The APY is the replica's, and every screen that shows it says so. |

It is a replica in the same sense GhostLend's was: our contract, our rate,
labelled as a stand-in everywhere it appears. It is **not** the live mainnet
vault and is not affiliated with Steakhouse Financial or Morpho.

### The composition, on chain

The pool's principal is in **batch 281** of Zama's own batcher:

```
tx        0xeb71ffb5ad7165f88ec1b97a702cc261036da148bb1c9d684fc6dc262782de15
batcher   0x48758559c14d4d92b4C74A99660B6a8dbe85F53b
shares    0x13F7d34A4f0102734F19E3Ff16e068Fe194B28c4   (Confidential steakcUSDC)
```

Re-run it yourself with `npx hardhat run scripts/prove-vault-composition.ts
--network sepolia`.

**The pool settles in cUSDC because of that batcher, not for decoration.** Its
`toToken` is cUSDC — read off the chain — so a pool settling in its own token
could never join a batch, and the composition would be a diagram.

`joinVault()` sends **half** the principal, and both halves of that are
deliberate. Not the whole balance: this contract also holds the pot its yield is
paid from, and joining that would send the prize reserve into the vault and leave
the pool unable to pay anything. Not all the principal either: a batch is a round
trip on somebody else's clock and the source does not unwind shares on demand, so
the rest stays as the withdrawal buffer a real vault keeps, for the same reason.

Two things worth recording because the documentation says otherwise. The
batcher's `toToken` is `Confidential steakcUSDC (Mock)`, not the
`Confidential mvUSDC` that the address reference lists as cShare. And while every
step of a batch is documented as permissionless, our own `dispatchBatchCallback`
reverted — the batch settled because Zama runs a keeper, so there is an
operational dependency the docs do not mention.

## What we measured

Everything below is measured on live Sepolia, not inferred. `findings.md` has the
full accounting, including the measurements that came out wrong and why.

| | |
| --- | --- |
| FHE operation sequence, 306 accruals | **1 distinct — identical** |
| HCU, 306 accruals | **1 distinct — 2,023,192** |
| Execution gas | two values, four apart |
| Does that vary with the outcome? | **No** — Welch t = 1.03, df = 4.6, **p = 0.35** |
| Does it vary with the address? | **Yes** — 16% to 58% between addresses |

The address is a public input to the threshold, so gas varying with it discloses
nothing an observer does not already hold.

Getting to that took a correction worth reading: a chi-square over 306 pooled
observations crossed the significance threshold and looked like a real leak. It was
**pseudo-replication** — the samples were nineteen repeated measurements on each of
eight fixed addresses, not 306 independent ones. On the correct unit of analysis
the effect vanishes. `findings.md` §14.

### The rest of the numbers

| | |
| --- | --- |
| `accrue`, steady state | 2,582,192 HCU — 7 participants per transaction |
| One observation | 60,000 gas, 5.7% of a deposit |
| KMS reveal, live | 12.0 seconds |
| Local tests | 30 passing |

---

## What leaks

`docs/leakage.md` states three residuals with their bounds rather than claiming
none exist:

1. **Keeper liveness is a privacy property.** If the keeper skips someone, a
   standalone self-accrual is weak evidence they won. Narrowed by draining pending
   credits on every deposit and withdrawal.
2. **The aggregate reveal discloses a winner count, never an identity.**
3. **Deferred compounding puts mild transaction pressure on winners.** The weakest
   of the three: `winningsOf` is EIP-712 readable, so nobody has to transact merely
   to learn they won.

Public by construction: who deposited and when, `totalWeight` and `R` once per
draw, every participant's threshold, and the prize. Individual balances, weights,
outcomes and the reserve stay encrypted.

---

## Running it

```bash
npm install
npm test                      # 154 tests, local
npx hardhat run scripts/deploy-composed.ts --network sepolia
POOL=0x... npm run keeper     # harvests, reveals draws, accrues everyone

cd frontend && npm install && npm run dev
```

### Two numbers an operator has to know

**Break-even principal.** The reserve fills from `harvest()` and nothing else, so
a prize the reserve cannot cover credits the winner **zero** — and a declined
`tryDecrease` is indistinguishable from losing, by design. That makes underfunding
silent, and this pool ran for hours paying nothing before it was caught.

```
yield = principal × rateBps × elapsed / (10000 × 365 days)
break-even principal = prize × 10000 × 365 days / (rateBps × period)
```

At 1000%/yr, a **300s** round needs **~10,512 cUSDC** of principal behind a 1 cUSDC
prize; a **1800s** round needs **~1,752**. The keeper prints this number every time
it harvests, so the figure that has to be beaten sits next to the round that has to
beat it.

**Gas.** A full keeper round — harvest, open, reveal, accrue — is roughly 1.5M gas.
At 2 gwei that is ~0.003 ETH, so a 300-second cadence costs **~0.95 ETH a day** and
a 1800-second cadence **~0.16 ETH**. The deployed keeper runs at 1800s for exactly
this reason. Fund the keeper wallet accordingly: it stops silently when it runs
out, leaving the current draw Open and every later one blocked behind it.

Sepolia credentials go in `probe/secrets.json` (git-ignored) as
`{ "privateKey": "0x…", "sepoliaRpcUrl": "https://…" }`.

| | |
| --- | --- |
| `contracts/ConfidentialPrizePool.sol` | deposits, withdrawals, the TWAB record, the draw, accrual |
| `contracts/mocks/PrizePoolHarness.sol` | test-only: reveals a draw without the KMS |
| `scripts/keeper.ts` | self-healing driver — repairs before it advances |
| `scripts/demo-round.ts` | seeds six participants and runs one full round |
| `test/sepolia-*.ts` | the live measurements |

Built on GhostLend (Season 3, Builder Track second place) — its epoch reveal
machine, its self-healing keeper, and four KMS traps it paid to discover.

---

## What is not done

- **The frontend has not been exercised in a browser with a real wallet.** It
  type-checks, every panel is in the bundle, and the contract path under each is
  covered by tests and a live round — but connecting a wallet and signing a permit
  is a manual pass that has not happened.
- **`joinVault` is repeatable, and repeating it drains the withdrawal buffer.**
  It sends `FHE.shr(_principal, 1)` and does not decrement `_principal`, so the
  "half" is half of the same number every time, and the function is
  permissionless. Two calls move the whole principal; more calls reach the pot.
  Nothing is stolen — the batcher credits this contract and `claimShares`
  recovers the position — but the money becomes illiquid until batches settle,
  and *principal is withdrawable at any time* is a liquidity claim. Pinned by
  `test/withdraw-buffer.ts`. Live exposure today is small: the buffer is the
  900,000 cUSDC pot plus principal against ~12,600 of deposits, and `joinVault`
  has been called once. **The fix is to track what has been joined and bound the
  function; it needs a redeploy and has not been made.**
- **Withdrawal is all-or-nothing when the buffer is short.** ERC-7984's transfer
  clamps to zero rather than paying out partially, so asking for more than the
  source holds moves **nothing** and the transaction still succeeds. Nothing is
  lost — the position is untouched and a smaller ask goes through — but it is a
  silent failure with a cause the interface does not name.
- **The replica's yield is pre-funded, not earned.** The 900,000 cUSDC pot is
  where prizes come from; the rate decides how much, the pot decides for how
  long. Zama's Sepolia vault has no yield adapter, so the composition is real and
  the appreciation is not.
- **`euint128` for the cumulative accumulator is required, not optional.** A
  6-decimal balance of 1e12 held for a year overflows `2^64` in about seven months.
- **No confirmation-depth policy.** Fine on Sepolia; not on mainnet.
