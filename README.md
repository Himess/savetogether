# GhostPool

**No-loss prize savings where your balance, your odds, and whether you won all stay encrypted.**

Deposit a confidential ERC-7984 token. Your principal is never at risk — only the
yield funds prizes. Every period a winner is drawn, weighted by how much you held
and for how long. Nobody can see your balance, your odds, or your result. Not other
depositors, not the keeper, not the pool.

Built on [Zama FHEVM](https://docs.zama.org/protocol) for the Developer Program,
Season 4.

| | |
| --- | --- |
| **Pool** | [`0x307e2D1eA71C73FD4358622933880868BbCe05D0`](https://sepolia.etherscan.io/address/0x307e2D1eA71C73FD4358622933880868BbCe05D0) |
| **Token** | [`0x056AC066e0770A7BE08eCAc73C09f811B067fc46`](https://sepolia.etherscan.io/address/0x056AC066e0770A7BE08eCAc73C09f811B067fc46) |
| **Network** | Sepolia (11155111) |

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
npm test                      # 30 tests, local
npx hardhat run scripts/deploy.ts --network sepolia
POOL=0x... npm run keeper     # reveals draws, accrues everyone

cd frontend && npm install && npm run dev
```

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
- **Yield is mocked.** Zama's Confidential Vault is deployed on Sepolia
  (`0x6AB54988261AEC573a2CA13cF802d3B1114f864C`) but the staging instance has no
  yield adapter, so it generates none. The plug-in point is a real address rather
  than a hypothetical.
- **`euint128` for the cumulative accumulator is required, not optional.** A
  6-decimal balance of 1e12 held for a year overflows `2^64` in about seven months.
- **No confirmation-depth policy.** Fine on Sepolia; not on mainnet.
