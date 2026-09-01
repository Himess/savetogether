# Spike result — can the plaintext be removed entirely?

**Verdict: the mechanism works and is cheaper than what we ship. Do not build it.**

It removes a plaintext that only the local session client ever sees, and pays for
that by disclosing the *ratio* to everyone, permanently, in the clear. And for
SaveTogether specifically it does not even remove the tab, because the budget hop
still needs an encrypted input.

Run 30 August 2026. Everything below is measured on live Sepolia or on the local
mock, never computed. Raw data in `spikes/out/*.json`, harness in
`contracts/spikes/`, scripts in `spikes/`.

---

## R1 — the arithmetic is there  *(the gate)*

Read out of the installed `@fhevm/solidity` **0.11.1**, not from memory.

| operation | signature | file:line | HCU (euint64) | HCU source |
| --- | --- | --- | --- | --- |
| shift, plaintext amount | `shr(euint64 a, uint8 b)` | `FHE.sol:7559` | **34,000** | `HCULimit.sol:568` |
| shift, encrypted amount | `shr(euint64 a, euint8 b)` | `FHE.sol:7546` | **209,000** | `HCULimit.sol:586` |
| divide by a scalar | `div(euint64 a, uint64 b)` | `FHE.sol:6566` | **715,000** | `HCULimit.sol:263` |
| multiply by a scalar | `mul(euint64 a, uint64 b)` | `FHE.sol:6546` | 365,000 | `HCULimit.sol:~215` |
| multiply, ct × ct | `mul(euint64 a, euint64 b)` | `FHE.sol:3708` | 596,000 | `HCULimit.sol:~215` |
| remainder by a scalar | `rem(euint64 a, uint64 b)` | `FHE.sol:6576` | 1,153,000 | `HCULimit.sol:297` |

**Does any of it need a plaintext denominator?** Yes, and it is enforced rather
than merely conventional. `checkHCUForFheDiv` opens with

```solidity
if (scalarByte != 0x01) revert OnlyScalarOperationsAreSupported();
```

and there is no `div(euint64, euint64)` in `FHE.sol` at all. Division by an
encrypted denominator does not exist. This does not block the design —
`depositFraction(num, den)` has plaintext operands by construction — but it does
mean a fraction can never itself be a secret.

Shifting is 21× cheaper than dividing and reaches only powers of two. Both were
carried forward, because "half" is a shift and "a third" is not.

---

## R2 — what the paths cost, on live Sepolia

Four ways of moving value into a contract, one token (gUSDC, whole units),
identical bookkeeping in every path, so the spread is the mechanism and nothing
else. Correctness checked alongside cost: `_update` clamps rather than reverting,
so a path that moves the wrong amount does it quietly.

| path | what | txs | gas | FHE ops | HCU | moved the right amount |
| --- | --- | --- | --- | --- | --- | --- |
| **A** | `depositExternal(externalEuint64, proof)` — **what we ship** | 1 | **625,465** | 9 | 586,096 | yes |
| **B** | `token.confidentialTransferAndCall(pool, balanceHandle)` — deposit ALL | 1 | **823,637** | 20 | 1,758,160 | yes |
| **C** | `ACL.allow` + `depositShifted(handle, 1)` — half | 2 | **564,104** | 11 | 989,064 | yes |
| **D** | `ACL.allow` + `depositDivided(handle, 3)` — a third | 2 | **564,271** | 11 | 1,670,064 | yes |

Two independent runs agree within 25 gas on every row.

**C and D are cheaper than what we ship**, by about 10%, *including* the extra
ACL transaction. Verifying an input proof costs more than doing the arithmetic.

**Three things worth naming:**

1. **`div` and `shr` cost the same gas** — 505,911 vs 505,744 in the deposit
   transaction, 167 gas apart — while differing 21× in HCU. HCU is the
   coprocessor's off-chain budget and EVM gas is the chain's; they are not
   proxies for each other. For a single deposit neither is close to binding
   (20,000,000 per transaction).

2. **`VerifyInput` is not metered for HCU at all.** There is no
   `checkHCUForVerifyInput` in `HCULimit.sol`. Verifying an input proof costs EVM
   gas and zero HCU, which is why path A is the most expensive in gas and the
   cheapest in HCU.

3. **Path B costs more than A**, despite carrying no proof, because
   `_transferAndCall` performs a second `_update` for the refund leg — 20 FHE
   operations against A's 9.

**One bug found on the way, worth keeping:** the receiver callback must grant the
*token* access to the `ebool` it returns. Without it the transfer reverts with
`ACLNotAllowed(retval, token)` from `FHEVMExecutor.sol:37`, because
`_transferAndCall` computes `FHE.select(success, 0, sent)` on a handle it was
never allowed to touch. The interface says so in a NOTE; the note is easy to read
past and the failure is a bare `execution reverted` through `estimateGas`.

---

## R3 — the frozen surface is untouched

`accrue`, `_snapshotCumulative`, `_cumulativeAt`, `thresholdFor`, `_uniform`.
Answered three ways, weakest first, against two copies of the pool that differ
only by an added `depositShifted`.

**1. Source.** Each frozen function extracted by brace matching and hashed:

```
accrue                 98da2cd6d0c3ec4c  identical  39 lines
_snapshotCumulative    fa54fcce31659c9d  identical  13 lines
_cumulativeAt          f6d16ce31479f6f4  identical   9 lines
thresholdFor           1486ad59e4ff7e32  identical   6 lines
_uniform               171dd89500dfcc95  identical  10 lines
```

**2. Bytecode.** Metadata trailer stripped. Baseline 12,923 bytes, variant 13,700
(+777). Shared prefix 24 bytes, shared suffix 66. **Almost everything moved** —
adding a function rewrites the dispatcher and every jump destination after it, so
byte-level identity is not achievable and is not the right test.

**3. Gas — the one that settles it.** The 306-sample result is a claim about
execution cost being indistinguishable between a winning accrual and a losing
one, so both were run on both contracts, same state, same sequence:

```
baseline  426105 / 426093
variant   426105 / 426093
delta          0 /      0
```

Identical, including the 12-gas intra-pool spread between the two arms. A
fractional deposit path can sit beside the frozen surface the way `harvest()`
does. **R3 passes.**

---

## R4 — what still leaks, read off the chain

This is where it dies, and the finding is stronger than the brief anticipated.

The brief expected `depositAll()` to *reveal a fact* and `depositFraction(1,2)`
to *reveal a fraction*. Both are true, but understate it: the ratio is not merely
revealed, it is **provable from public data by anyone, forever**. The calldata
names the very handle a public view function returns.

Measured by pulling each transaction's calldata and comparing it against
`confidentialBalanceOf(sender)` at the preceding block:

| path | calldata | names the holder's balance handle | what an observer can prove |
| --- | --- | --- | --- |
| **A** — what we ship | 356 bytes | **no** | nothing about the ratio |
| **B** — deposit all | 132 bytes | **yes** | "deposited 100% of holdings" |
| **C** — shift | 68 bytes | **yes**, plus plaintext `0x…01` | "deposited exactly half" |
| **D** — divide | 68 bytes | **yes**, plus plaintext `0x…03` | "deposited exactly a third" |

C and D also require a **public `ACL.allow(handle, pool)` transaction first**,
which announces the intent one block ahead of the deposit.

### Compared with what an observer already holds

The public transfer graph gives who, to whom, and when. Amounts are encrypted, so
today an observer sees *"alice deposited into the pool at T"* and stops.

The ratio changes the shape of the problem. Amounts stop being independent
unknowns and become a system of equations in one variable. **Any single absolute
that leaks anywhere propagates through the entire chain.** And in this protocol
one does leak, by design: wrapping is a public action on a public amount
(§9.5). So

> alice wraps 500 USDC — public, on chain, permanent
> alice deposits "all" — the observer now knows her position is exactly 500
> alice withdraws "half" twice — the observer now knows it is exactly 125

Today that chain is broken at the first link, because the deposited amount is
independent of the wrapped one. The fractional design welds it shut. This is
worse than a leak of one amount: it is a leak that **compounds with every
operation the user performs**, and it cannot be revoked afterwards.

---

## R5 — does it actually remove the tab? No.

Traced for *"put half my balance in the pool"* under this design, without
assuming the conclusion.

**The pool leg is genuinely plaintext-free:**

1. read `confidentialBalanceOf(sessionKey)` — a public view, returns an opaque
   `bytes32`, no plaintext
2. sign `ACL.allow(handle, pool)` — a signature over public arguments
3. sign `pool.depositShifted(handle, 1)` — a signature over public arguments

No `createEncryptedInput`, no WASM proof generation, no browser. A hosted service
holding a session key could do all of this blind.

**The budget leg is not, and that is the blocker.** SaveTogether's deposit is two
hops: the owner's funds move to the session key through the module's
budget-bounded `send`, and only then into the pool. And `SaveTogetherSession.send`
takes `externalEuint64 encAmount, bytes inputProof` (`SaveTogetherSession.sol:203`).
Making it accept a handle instead would require:

- `FHE.isAllowed(handle, sessionKey)` on the **owner's** balance handle, which
  the token grants only to the owner. The owner would have to sign an `ACL.allow`
  before every single transfer — which is precisely the thing a session exists to
  avoid; and
- changing `send`, whose 60-transaction Sepolia indistinguishability result
  (chi-square 2.927 against a critical 5.991) was measured on that exact code.

So the plaintext does not disappear. It moves one hop upstream and stays there.
**The tab requirement survives**, and R5's answer to its own question is no.

### The corollary that is actually worth something

The asymmetry is instructive. A fractional **withdrawal** needs no grant at all,
because the pool wrote the position handle itself with `allowThis` and already
has the access. One transaction, no ACL grant, and no handle in the calldata:

```
withdrawShifted(1)   gas 864,808   1000 -> 500
withdraw(encrypted)  gas 944,769   1000 -> 500
saving               79,961 gas, and one plaintext
```

Cheaper, simpler, correct. It still discloses the ratio in the clear, so R4
applies to it unchanged — but it is the one place where the idea costs nothing
structurally, and it is the natural home for a "withdraw everything" button if we
ever decide the ratio is an acceptable disclosure for an exit.

---

## Verdict

**Not viable.** Not because the arithmetic is missing — it is all there, and
cheaper than what we ship — but because the trade runs the wrong way.

| | today | fractional |
| --- | --- | --- |
| who sees the plaintext | the local session client, once | nobody |
| who learns the ratio | nobody | everyone, permanently, provably |
| does it remove the tab | — | **no** — the budget hop still needs an encrypted input |
| gas | 625,465 | 564,104 |
| frozen surface | — | untouched, delta 0 |

We would be trading a plaintext with one reader, held on the user's own machine,
for a public ratio with unlimited readers that composes with the public wrap into
an exact amount. And we would not even get the thing we were buying, because
`send` still needs a ciphertext and it is frozen.

**Recommendation: drop it, and keep the local install.** The local install has an
honest answer to "who sees the amount" — the software on your own machine, the
same answer a wallet gives — and it is the answer the leakage document already
defends.

**Keep two things from this:**

1. `withdrawShifted` is strictly better than the encrypted-input withdrawal on
   every axis except the ratio disclosure. If a "withdraw everything" affordance
   is ever wanted, this is how to build it, and R4 is the argument to have first.
2. The measurement method. Widths were read from the **result handle's type
   byte** rather than off the source, which removes exactly the degree of freedom
   that let §10.2's two errors cancel in §11.1. Transcribing the HCU table by
   hand still went wrong three times — `add`/`sub` scalar as 87,000 when they are
   133,000, `ge` scalar as 87,000 when it is 116,000, and `Cast`/`TrivialEncrypt`
   as 100–200 when both are 32. None of them changed the verdict, which is
   exactly why they were easy to miss.

---

## Reproducing

```
npx hardhat run  spikes/r2-measure.ts   --network sepolia   # the four paths
npx hardhat run  spikes/r2-hcu.ts       --network sepolia   # ops and HCU
npx hardhat run  spikes/r3-frozen.ts                        # source + bytecode
npx hardhat test spikes/r3-gas.ts                           # accrue, both pools
npx hardhat run  spikes/r4-leak.ts      --network sepolia   # calldata disclosure
npx hardhat test spikes/r5-withdraw.ts                      # the withdraw case
```

Nothing here is merged. `contracts/spikes/` holds scratch copies of the pool that
exist only so the two variants can be compiled side by side; the shipped
`ConfidentialPrizePool` was never edited, and its deployed bytecode hashes
`893e93b23f6e2b384ad28fd0c17e5c1b37dc0545a430fed93f89c21c5a71ebf1` before and
after the spike. The live pool was not touched. 38 pool tests still pass.
