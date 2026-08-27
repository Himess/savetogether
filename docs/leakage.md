# GhostKey — what leaks

An honest inventory. Everything here is measured or read from source; nothing is asserted because it sounds right.

---

## 1. Public by construction

These are not defects and no amount of engineering removes them. ERC-7984 hides amounts, not activity.

|                              | why                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **that a transfer happened** | it is a transaction on a public chain                                                                                                                |
| **the recipient**            | `to` is a plaintext parameter in every ERC-7984 transfer variant, and `ConfidentialTransfer(from, to, transferred)` puts both endpoints in the clear |
| **the sender**               | same                                                                                                                                                 |
| **the token**                | the contract being called                                                                                                                            |
| **the time**                 | the block                                                                                                                                            |
| **the session's shape**      | expiry, transfer count, transfer cap and the allowlist are plaintext in `GhostKeySession`, deliberately, so they are auditable                       |

The allowlist is plaintext because encrypting it would be theatre: the recipients appear on chain the first time anything is sent to them.

**Sealed mode hides the amount and nothing else.** The tool description says so, and this document says so. A user who types an amount into the console rather than the chat has kept the number out of the model's context and out of the transcript — that is real, and it is the whole claim.

---

## 2. Confidential

|                                  | mechanism                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **the amount transferred**       | `euint64`, never decrypted on chain                                                                                                    |
| **the remaining budget**         | `euint64` in the module, granted only to the owner and the session key                                                                 |
| **the holder's balance**         | `euint64` in the token, granted only to the holder — and to a session key **only** if the owner opened the session with ACL delegation |
| **whether a transfer succeeded** | `within` and `sent` are encrypted handles; an observer sees neither                                                                    |

That last row is the interesting one, and §3 is about how well it holds.

---

## 3. The residual side channel, measured

A budget rejection, an insufficient balance and a successful transfer must be indistinguishable. On live Sepolia, two of the three observable quantities are **exactly identical** on every path, and the third is not quite.

### What is exactly equal

Across 60 live transactions, 20 per path (`docs/step3-gate.md`, `spikes/out/sepolia-distribution.json`):

```
FHE operation sequence   FheAdd x2  FheGe x2  FheIfThenElse x4  FheSub x3  TrivialEncrypt x2
HCU                      1,334,064
```

One distinct operation sequence and one distinct HCU value across all sixty. These are the quantities that describe what the FHE layer actually did, and they carry no information at all.

### What is not

Execution gas takes two values, four apart:

| path          | n   | 891,568 | 891,572 |
| ------------- | --- | ------- | ------- |
| success       | 20  | 9       | 11      |
| over-budget   | 20  | 6       | 14      |
| short-balance | 20  | 4       | 16      |

The variance is **not** in GhostKeySession, the token, or the ACL — a trace diff of two same-path transactions found 181 identical calls and exactly one differing by 4 gas, inside `HCULimit.checkHCUForFheGe`, the FHEVM's own cost accounting. No change to this project could remove it.

### The bound

**Chi-square 2.927 on 2 degrees of freedom** against a critical value of 5.991 at p = 0.05. The three distributions are not distinguishable.

**Mutual information between the path and the observed gas: 0.03539 bits per observation.**

That figure is an _upper_ bound in two senses, and both matter:

1. **Finite-sample bias inflates it.** The Miller–Madow bias of an empirical mutual information over an r×c table is `(r-1)(c-1) / 2N` nats — here `2 / 120` nats, or **0.024 bits**. Two thirds of the measured 0.0354 bits is the floor that pure sampling noise produces under _perfect_ independence. Bias-corrected, the estimate is ≈ **0.011 bits**, which is not distinguishable from zero at this sample size.
2. **The uncertainty it eats into is 1.585 bits.** Three outcomes, so `log2(3)`. Even taking the uncorrected 0.0354 bits at face value, an observer learns at most **2.2% of one transfer's outcome** from its gas.

### Why the transfer cap matters

A single observation is close to useless, so the real question is what an attacker learns from many. Two things bound that.

**The observations are independent transfers.** Watching one transfer tells you nothing extra about a different one — each has its own outcome and its own coin flip. So the per-transfer bound above does not accumulate into certainty about any particular transfer.

**The sample count is capped and public.** `Session.maxTxCount` is plaintext, fixed at session open, and enforced by the contract; `session_status` reports it. An attacker attempting to _detect_ a distributional difference at all is limited to that many samples. Scaling the observed effect — which is noise — from n = 60 to significance would need n ≈ 123 samples of the same skew. **A session opened with `maxTxCount` below roughly 120 cannot, even in principle, accumulate enough observations to reach p = 0.05 on an effect this size.**

That is not the reason the channel is safe. The reason is that the distributions are indistinguishable and the difference lives in a third-party contract's accounting. The cap is a second bound, and it is one the owner sets.

### Calldata

Total `gasUsed` also varies with the zero-byte count of the caller's own ciphertext — a fresh encrypted handle and input proof each time, 4 gas per zero byte and 16 per non-zero. That variance is generated by the session client _before_ the contract runs and cannot depend on an outcome the chain has not computed yet. It is excluded from every figure above by subtracting intrinsic calldata cost, and the gate asserts that the attribution closes.

---

## 4. What the model sees

Separate from the chain, and the reason the two principals are named distinctly everywhere.

|                            | default           | with an explicit action                                     |
| -------------------------- | ----------------- | ----------------------------------------------------------- |
| amounts                    | never             | a click on the local console, per call                      |
| balance                    | never             | a click, and only if the session was opened with delegation |
| remaining budget           | never             | a click                                                     |
| whether an amount fits     | yes, as a boolean | —                                                           |
| recipients, tokens, timing | yes               | —                                                           |

There is no configuration option that disables the reveal confirmation. Adding one would remove the only thing standing between "the model can ask" and "the model has it".

In sealed mode the model receives `{status, ok_ref, sent_ref}` and no number, ever — not even after the fact, because the reference is opaque and `revealAmount` needs a click.

---

## 5. Known limits

- **Biometric unlock is not implemented.** The vault key is encrypted at rest under the OS keychain (macOS Keychain, Windows DPAPI, libsecret) and unlocking requires a local human action at the console. A true Touch ID / Windows Hello prompt needs a native module per platform and is not here. The brief's preference order put biometric first; what is implemented is the second item, and this says so rather than implying otherwise.
- **`--dev-unlock` skips the human step.** It is hard-gated to chainId 11155111 and refuses to run anywhere else. Asserted in `test/mcp.ts`, including the case where the vault exists and is loadable.
- **A leaked session key costs the remaining budget**, to addresses already on the allowlist, until expiry. That is the designed bound, not an accident — but it is a real loss, and the budget and allowlist are the only things limiting it.
- **The operator grant outlives the session.** `token.setOperator(module, expiry)` is set outside `GhostKeySession` and expires on its own schedule. Closing a session does not clear it; the module simply has no live session to act under. `revoke_all` says this in as many words rather than implying the grant is gone.
