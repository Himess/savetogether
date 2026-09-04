# SaveTogether — the Sepolia equality gate

Step 2's headline claim was backed by mock mode only. This is the live-chain check, run before any SDK code was written.

- Date: 2026-08-27
- Network: Ethereum Sepolia (11155111)
- Module: [`0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6`](https://sepolia.etherscan.io/address/0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6)
- Token: [`0xCFf87b42b916f7aA0F61CD060C9f48772F303D37`](https://sepolia.etherscan.io/address/0xCFf87b42b916f7aA0F61CD060C9f48772F303D37)
- Script: `spikes/sepolia-equality.ts` — `pnpm spike:sepolia-gate`
- Raw data: `spikes/out/sepolia-equality.json` **(raw file not kept — see below)**

**Resampled at n = 180.** The original run at 20 samples per path was underpowered: it showed 45% / 30% / 20% and chi-square 2.927, which is "not distinguishable" only in the weak sense of not having the power to see an effect that size. At 60 per path the spread collapses to 30.0% / 31.7% / 26.7% and chi-square falls to **0.374, p = 0.83**. Details in §2; the bound and the power statement live in [`leakage.md`](./leakage.md) §3.

**The literal gate criterion — execution gas identical across paths — does not hold.** Two values appear, four gas apart, on every path. The rest of this document establishes what that difference is and is not.

---

## 1. What was measured

Three quantities per send, because gas alone is not the whole claim:

1. **Execution gas** — `gasUsed` minus intrinsic calldata cost (4 per zero byte, 16 per non-zero). Total `gasUsed` is the wrong quantity: the caller's encrypted amount and input proof are fresh ciphertext whose zero-byte count varies at random.
2. **The FHE operation sequence** — counted from the executor's own events in the receipt. Evidence one layer below gas, at the FHE layer itself.
3. **HCU** — computed from those measured op counts times the per-op costs read from `HCULimit.sol`. HCU is accumulated in transient storage with no event and no view, so it cannot be read back after a transaction; the op counts are measured, only their prices are read from source.

Setup is symmetric: three separate owners, three separate session keys, a recipient warmed beforehand so `_balances[to]` is initialized on every path.

**Token note.** The gate deploys its own `MockERC7984` rather than using the live cUSDC wrapper. "Mock" here means an open-mint test token, not a mocked FHE stack — the ACL, coprocessor, relayer, proofs and gas metering are all real Sepolia. `MockERC7984` extends the same OpenZeppelin `ERC7984`, so `_update` is byte-identical to the wrapper's. Absolute gas would differ with the wrapper; the equality across paths is driven by `_update` and would not.

---

## 2. Results

### Two of the three quantities are exactly equal

Across all 22 transactions:

```
FHE operation sequence, every path, every run:
  FheAdd x2   FheGe x2   FheIfThenElse x4   FheSub x3   TrivialEncrypt x2

HCU, every path, every run:
  1,334,064
```

The HCU figure matches the analytic estimate from the step-2 design review **exactly**. That estimate is now confirmed rather than assumed.

### Execution gas takes two values

| run  | success | over-budget | short-balance |
| ---- | ------- | ----------- | ------------- |
| 1    | 891572  | **891568**  | 891572        |
| 2 R1 | 891572  | 891572      | **891568**    |
| 2 R2 | 891572  | 891572      | **891568**    |
| 2 R3 | 891572  | 891572      | 891572        |

The low value appears once on `over-budget` and twice on `short-balance`, and in one round not at all. It does not track the path.

### The control settles it

Ten sends on a **single** path — same session, same amount, same recipient, outcome constant across all ten:

```
 1  891572     6  891572
 2  891568     7  891572
 3  891568     8  891572
 4  891572     9  891568
 5  891568    10  891572
```

**Six at 891572, four at 891568.** One fixed path produces both values. Since the outcome is identical in all ten samples and the gas is not, the gas cannot be a function of the outcome. HCU was 1,334,064 in all ten.

---

## 3. Where the four gas is

Localised by comparing `callTracer` traces of two **same-path** transactions — one at each value. 181 calls each, identical tree shape, and exactly one call differs.

```
                                          lo(891568)   hi(891572)   delta
  SaveTogetherSession   0x7af5a8e3                896752       896756      +4
  FHEVMExecutor     0x1391547f                 30365        30369      +4
    HCULimit        0xc277a936                 14962        14966      +4

  aggregate by target
    ACL                                       468761       468761       0
    MockERC7984                               306652       306652       0
    InputVerifier                             165522       165522       0
```

`0xa10998783c8cf88d886bc30307e631d6686f0a22` identifies itself as HCULimit: `getVersion()` returns `"HCULimit v0.1.0"` and `getFHEVMExecutorAddress()` returns the coprocessor address. The deployed version matches the local package's version constants, so there is no drift between the source read here and the code that ran.

Selector `0xc277a936` is `checkHCUForFheGe(uint8,bytes1,bytes32,bytes32,bytes32,address)` — the deployed signature carries a trailing `address` the local 0.10.0 source does not, which is why it did not match the source-derived selectors at first. Its six arguments confirm the operation:

```
arg0  5                        FheType.Uint64
arg1  0                        scalarByte — ciphertext against ciphertext
arg2  ...aa36a705 00           lhs, euint64
arg3  ...aa36a705 00           rhs, euint64
arg4  ...aa36a700 00           result, EBOOL
arg5  0xe5c667c0...            SaveTogetherSession, the caller
```

Two encrypted 64-bit operands and a boolean result: this is the budget comparison inside `FHESafeMath.tryDecrease`.

**So the four gas is not in SaveTogetherSession, not in the token, not in the ACL.** It is inside the FHE cost accountant's own bookkeeping, and the only thing that differs in its inputs is the byte values of freshly generated ciphertext handles.

### The mechanism is not identified

The leading candidate is the ternary at `HCULimit.sol:1410`:

```solidity
uint256 totalHCU = opHCU + _max(_getHCUForHandle(op1), _getHCUForHandle(op2));
```

A Solidity ternary compiles to asymmetric branches that can differ by a few gas, which is the right location and the right magnitude. **But the hypothesis has a hole and is not being asserted:** `_getHCUForHandle` reads transient storage keyed by the handle, and both operands should read zero — `remaining` was produced in a previous transaction, and `requested` comes from `verifyCiphertext`, which has no HCU entry. That would make the branch deterministic, which it plainly is not.

Pinning the exact opcode needs a struct-log trace of that frame. It was not done, because the conclusion does not depend on it and the evidence for the conclusion is already conclusive.

---

## 4. What this does and does not establish

**Established.** An observer cannot classify the outcome of a `send` from its gas. Ten samples of one fixed path produce both observed values; the outcome is constant while the gas is not. The FHE operation sequence and the HCU consumption — the two quantities that actually describe what the FHE layer did — are identical across every path and every run.

**Not established.** That execution gas is a constant. It is not. It is a two-valued quantity whose variance lives in a third-party accounting contract and is uncorrelated with anything SaveTogether does.

**Not affected.** SaveTogetherSession's own frame, the token's `_update`, and every ACL grant are bit-identical between the two values. Nothing in the contract under review varies.

---

## 5. Proposed gate criterion

The original criterion — execution gas exactly equal across paths — is falsified on live Sepolia, and no change to SaveTogetherSession could satisfy it, because the variance is in `HCULimit`. Three candidate replacements, in order of how much they claim:

**(a) Distributional equality.** The set of execution-gas values observed on each path must be identical across paths, and a same-path control must reproduce the full spread. This is what the data supports today, and it is the honest formulation of "an observer learns nothing".

**(b) Layer equality plus a bounded residual.** Hard equality on the FHE operation sequence and on HCU; execution gas must agree to within a stated bound (currently 4 gas) _and_ the same-path control must reproduce that spread. This keeps a hard assertion on the two quantities that describe the computation, and treats the EVM residual the way the calldata residual is already treated.

**(c) Keep hard equality and exclude the HCULimit frame.** Subtract the `checkHCUFor*` call costs from execution gas and assert equality on the remainder. Sharpest, but it requires a trace per transaction, which makes the gate slow and coupled to a third-party contract's internals.

**Recommendation: (b).** It asserts hard equality exactly where the claim lives — the FHE layer — keeps the gas residual bounded and explained rather than waved away, and requires the control run that makes the "no leak" argument falsifiable. (a) is weaker without the control and identical to (b) with it. (c) buys precision at a cost in fragility.

**This has not been applied.** The gate still fails as written. The criterion is the reviewer's call, not the implementer's.

### On the two raw files this document cites

`spikes/out/sepolia-equality.json` and `spikes/out/sepolia-distribution.json` **are not
in the repository.** The script that produced them, `spikes/sepolia-equality.ts`, still
is; the JSON was never committed, because `spikes/out/` was ignored at the time and the
files did not survive.

Marked rather than quietly repointed, and rather than regenerated. Re-running the gate
means 180 live Sepolia transactions and would produce a **different** dataset — the
figures quoted above describe the run that happened, not a run that could be made to
happen now. Pointing them at `out/equality-a/b/c.json` would be worse still: those are
the accrual-equality arms, a different study with 134, 24 and 160 samples.

So the numbers here are supported by this document and by the transaction hashes in it,
and not by a file you can open. That is a weaker claim than the rest of this repository
makes, and it is stated rather than hidden — the same treatment `docs/shots/` gets.
