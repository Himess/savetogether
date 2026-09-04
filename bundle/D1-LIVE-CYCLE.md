# D1 — the full required cycle, run live on Sepolia

> **SUPERSEDED BY A REDEPLOY — 4 September 2026.** Every transaction hash below is
> against the pool at 0xa9B69Dc9F9f4C4512c926ba9eA432eBcF0026631, which is no longer the live
> pool. The findings stand as a record of what was measured there; the hashes are
> history rather than pointers. The cycle was re-run against
> `0x894F6492357277CF36e9973787663AE9F73387BE` and the fresh results are in
> `out/d1-cycle.json`, `out/f3-fresh-wallet.json` and `out/f1-acl-sweep.json`.
>
> One finding here is CLOSED rather than merely restated: `pendingOf` was unreadable
> by its own owner, and on the redeployed pool the same sweep reports it READABLE.

The brief scores *"Do deposit, draw, claim, and withdraw produce the expected results
onchain?"* Before today, three of those had never run on this deployment: `Claimed` and
`Withdrawn` both had **zero** events since deploy, and no pool participant had ever
requested an unwrap. A judge testing it would have been the first person to try.

All of it now has. Run **2026-09-03**, signer `0xF505e2E71df58D7244189072008f25f6b6aaE5ae`,
scripts in `scripts/d1-*.ts`, raw results in `out/d1-*.json`.

---

## The transaction hashes

### Pass 1 — the whole cycle end to end (`scripts/d1-cycle.ts`)

| # | step | hash | gas |
|---|---|---|---|
| 1 | **deposit** 500 cUSDC | [`0xf6fbd169…1109`](https://sepolia.etherscan.io/tx/0xf6fbd169e117cefda236d71c4e0e827d01ea769f42ff70eee88eb48ecda01109) | 2,222,241 |
| 2a | **openDraw** (draw 33) | [`0x4bfc1e78…b204`](https://sepolia.etherscan.io/tx/0x4bfc1e782d693a960e8a97747b982619c7e2213a4bb783feb3f50519e250b204) | 394,124 |
| 2b | **revealDraw** (KMS) | [`0xcc6712d7…3e97`](https://sepolia.etherscan.io/tx/0xcc6712d72a35142539bfce0a2ee0b4a708ba7adb75f8474ed72d8bbd91503e97) | 383,943 |
| 2c | **accrue** | [`0x4608be2d…b168`](https://sepolia.etherscan.io/tx/0x4608be2d0a79bf17accfce7a8b90f67bba35c948d570b3bfe2c609230870b168) | 681,662 |
| 3 | **claim** | [`0x7e5fe3cf…2a2e`](https://sepolia.etherscan.io/tx/0x7e5fe3cfcf504b277c010a4d99695c312d57dc8e73256ef9d293cb757e0b2a2e) | 627,719 |
| 4 | **withdraw** 250 cUSDC | [`0x2d7ded28…0c0b`](https://sepolia.etherscan.io/tx/0x2d7ded28c6ec1e23cef248754b0c9321a996108813e9ea3d0ee7295dea410c0b) | 2,019,903 |
| 5 | **unwrap** 100 cUSDC → USDC | [`0xe751fbf5…678a`](https://sepolia.etherscan.io/tx/0xe751fbf5d4bada982b2c3340fecee10f62f39ef56b9c34742853919e3345678a) | 592,539 |

**7/7 succeeded.** The KMS returned the public decryption of `R` and `totalWeight` in
**4.8 s**.

### Pass 2 — `claim` proven to move value (`scripts/d1-claim-proof.ts`)

Pass 1's `claim` succeeded but drained nothing, because `deposit` calls `_drain` too and
had already folded the credit in three steps earlier. **A transaction that succeeds while
doing nothing is not evidence that the path works**, so pass 2 ran draws until the account
actually won, then claimed against a real pending credit.

| step | hash | gas |
|---|---|---|
| harvest | [`0x75731ed3…bb28`](https://sepolia.etherscan.io/tx/0x75731ed30c4814dd1dc506168c2ba73bbfd3a43f899b02666cc0302d5158bb28) | 744,388 |
| openDraw (draw 35) | [`0xb59ab124…1a53`](https://sepolia.etherscan.io/tx/0xb59ab12480702cb7fc131705be39afc1401adfb96ed429ed2929f62a3d351a53) | 387,280 |
| revealDraw | [`0x3f804883…d499`](https://sepolia.etherscan.io/tx/0x3f804883b402eb1ed6b27800a06518a3a822fec20fb5dbada76cf6aa6e62d499) | 383,931 |
| accrue | [`0x1ef0e39d…edc1`](https://sepolia.etherscan.io/tx/0x1ef0e39d5d30790963c57030a050fbc480932a86e0527429b449f41ed6bbedc1) | 684,273 |
| **claim** | [`0x42743cf9…e3e0`](https://sepolia.etherscan.io/tx/0x42743cf9421110ad11a8a81c783d1926bc2a2fbc62907d409510ba776eb7e3e0) | 627,719 |

```
draw 35: r=4154070485184136625  totalWeight=6481440000000  myThreshold(ordinary)=3367411022544
  *** WON: winnings 40 -> 41 cUSDC ***
  claim: position 12290 -> 12291 cUSDC
  claim moved exactly 1.000000 cUSDC into the balance
```

---

## What each step actually did, in decrypted numbers

Every figure below was decrypted with the signer's own key, before and after each step.
Nothing is inferred from the absence of a revert.

| after | position | winnings | wallet cUSDC | wallet USDC |
|---|---|---|---|---|
| before | 12,000 | 40 | 70,338.148996 | 700.246912 |
| deposit 500 | **12,540** | 40 | 69,838.148996 | 700.246912 |
| draw 33 + accrue | 12,540 | 40 | 69,838.148996 | 700.246912 |
| claim (pass 1) | 12,540 | 40 | 69,838.148996 | 700.246912 |
| withdraw 250 | **12,290** | 40 | **70,088.148996** | 700.246912 |
| unwrap 100 | 12,290 | 40 | **69,988.148996** | 700.246912 |
| draw 35 + accrue | 12,290 | **41** | 69,988.148996 | 700.246912 |
| claim (pass 2) | **12,291** | 41 | 69,988.148996 | 700.246912 |

- **Deposit**: +540, not +500 — 500 deposited plus the 40 pending credit that `deposit`
  drained on the way in. That is `_drain` doing its job, and it is why pass 1's `claim`
  had nothing left to do.
- **Withdraw**: position −250, wallet +250, exactly. Balanced to the unit.
- **Unwrap**: wallet cUSDC −100 immediately; **USDC unchanged** (see below).
- **Claim (pass 2)**: position +1, exactly the tier-2 prize.

---

## Two things this run found

### 1. `pendingOf(user)` is not readable by the user — and looked readable only by accident

After the deposit, `pending` stopped decrypting for its own owner, in every later snapshot.
The cause is an ACL gap, in two places:

`accrue` (`ConfidentialPrizePool.sol:895-897`) grants the user access to winnings but not
to pending:

```solidity
FHE.allowThis(nextPending);
FHE.allowThis(nextWinnings);
FHE.allow(nextWinnings, user);   // <- nextPending gets no user grant
```

and `_drain` (`:1011-1012`) re-initialises it with a contract-only grant:

```solidity
_pending[user] = FHE.asEuint64(0);
FHE.allowThis(_pending[user]);   // <- again, no user grant
```

It read as `40 cUSDC` in the pre-flight only because FHEVM handles are deterministic in
their inputs: while `_pending` and `_winnings` had accumulated the identical sequence of
`paid` values from zero, `tryAdd(_pending, paid)` and `tryAdd(_winnings, paid)` produced
the **same handle** — so the `FHE.allow(nextWinnings, user)` grant covered it. The first
`_drain` set `_pending` to a fresh zero handle, the two diverged, and the accidental grant
was gone.

Consequence: any UI or SDK call reading `pendingOf` after a user's first deposit,
withdrawal or claim gets a decryption failure rather than a number. The value is genuinely
zero at that point so no money is affected, and `winningsOf` — which the screens actually
display — is granted correctly. The fix is one line in each place:

```solidity
FHE.allow(nextPending, user);        // in accrue
FHE.allow(_pending[user], user);     // in _drain
```

This is the same class of defect as the AA1 weight leak, in the opposite direction: AA1
granted too much, this grants too little.

### 2. The unwrap is requested but had not settled 40 minutes later

The unwrap transaction succeeded and debited 100 cUSDC from the wallet immediately. The
USDC has **not** arrived: `700.246912` before, `700.246912` forty minutes later, delta
exactly `0.0`.

This is the asynchronous half of the wrapper — `unwrap` files a request, and the underlying
only moves when someone calls `finalizeUnwrap` with a KMS decryption proof. It is the same
dependency recorded as **Z2** in `ZAMA-DOCS-BUNDLE.md`: permissionless in the code,
operator-driven in practice.

**It is latency, not breakage.** Unwraps demonstrably do complete on this wrapper — 16 USDC
transfers out of it in the scanned window, to third parties as well as to Zama's own
batcher:

```
2026-09-03T11:17:48Z  -> 0x96b5Cabc…  2091.00002 USDC
2026-09-03T11:40:00Z  -> 0x96b5Cabc…  1000.0 USDC
2026-09-03T12:16:00Z  -> 0x96b5Cabc…  1000.0 USDC
2026-09-03T13:21:00Z  -> 0x48758559…   500.0 USDC
```

But the Wrap screen currently tells the user the USDC "arrives when it settles" without
saying that settlement is someone else's transaction on an unbounded schedule. Forty
minutes with no state visible to the user is the gap between what the screen promises and
what the chain does.

---

## One hypothesis raised and then falsified

Draw 34 credited nothing while the ordinary-tier threshold sat at 98.9 % of `totalWeight`,
which looked like the README's documented silent under-payment — a win the reserve could not
fund, credited zero and indistinguishable from a loss.

It was not. `scripts/d1-why-no-credit.ts` decrypts the account's own weight via `weightFor`
and reproduces the contract's comparison in the clear:

```
draw 34: r=7454850309418129409  totalWeight=6508440000000
my weight over the window: 4156440000000   (63.86% of the window)

tier  threshold                 weight > threshold?
  0   69206957740674            no
  1   52956078390283            no
  2   6437377792438             no

VERDICT: (a) ORDINARY LOSS. Weight cleared no tier; crediting zero is correct.
```

An ordinary loss with the machine working exactly as specified. Recorded because the script
that settles the question is now in the repository, and the same script will distinguish
the two cases the next time a draw pays nothing — which is the check the silent-shortfall
limitation has never had.

---

## What this leaves open

- **Withdrawal was not tested against a short buffer.** 250 cUSDC was well inside the
  source's liquidity, so the clamp-to-zero path — ask for more than the pool has liquid and
  the transaction succeeds while moving nothing — was not exercised live. It is pinned in
  `test/withdraw-buffer.ts` locally.
- **The unwrap has not completed.** Re-check `0x9b5Cd13b…dFfF` balance for
  `0xF505e2E7…E5Ae`; it should rise by 100 USDC when Zama's operator finalises.
- **The run used the deployer**, which is also the pool owner and the keeper. It proves the
  paths work; it does not prove they work for an address with no privileges. Every function
  exercised is permissionless in the source, and `claim` and `accrue` are callable by anyone
  for anyone, so no privileged path was taken — but a fresh-wallet run would be stronger
  evidence and is the obvious next step.
