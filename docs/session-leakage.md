# SaveTogether — what leaks

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
| **the session's shape**      | expiry, transfer count, transfer cap and the allowlist are plaintext in `SaveTogetherSession`, deliberately, so they are auditable                       |

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

Across 180 live transactions, 60 per path (`docs/step3-gate.md`; raw file **(raw file not kept — see below)**):

```
FHE operation sequence   FheAdd x2  FheGe x2  FheIfThenElse x4  FheSub x3  TrivialEncrypt x2
HCU                      1,334,064
```

One distinct operation sequence and one distinct HCU value across all 180. These are the quantities that describe what the FHE layer actually did, and they carry no information at all.

### What is not

Execution gas takes two values, four apart:

| path          | n   | 891,568 | 891,572 | low-value rate |
| ------------- | --- | ------- | ------- | -------------- |
| success       | 60  | 18      | 42      | 30.0%          |
| over-budget   | 60  | 19      | 41      | 31.7%          |
| short-balance | 60  | 16      | 44      | 26.7%          |

The variance is **not** in SaveTogetherSession, the token, or the ACL — a trace diff of two same-path transactions found 181 identical calls and exactly one differing by 4 gas, inside `HCULimit.checkHCUForFheGe`, the FHEVM's own cost accounting. No change to this project could remove it.

### The bound

**Chi-square 0.374 on 2 degrees of freedom** against a critical value of 5.991 at p = 0.05. **p = 0.83.** The three distributions are not distinguishable.

**Mutual information between the path and the observed gas: 0.00151 bits per observation** — and that figure is _below the noise floor_, which is the strongest reading available.

The Miller–Madow bias of an empirical mutual information over an r×c table is `(r-1)(c-1) / 2N` nats: here `2/360` nats, or **0.00801 bits**. That is what a _perfectly independent_ process would typically show at this sample size. The measured 0.00151 bits is a fifth of it, so the bias-corrected estimate is negative — what you see when the true mutual information is zero and sampling noise happens to land low.

Cross-check: `chi² / (2N ln2)` = 0.00150 bits, agreeing with the direct computation.

Against 1.585 bits of outcome entropy (three outcomes, `log2(3)`), an observer learns **under 0.1%** of one transfer's outcome from its gas — and the honest reading is that they learn nothing measurable.

### What this sample size can and cannot rule out

Stated plainly, because "not distinguishable" and "no effect" are different claims and only one of them is supported.

**n = 180 has 80% power to detect a spread of about ±13 percentage points** between the extreme paths — Cohen's `w = 0.231`, from a non-centrality parameter of 9.63 at 2 degrees of freedom.

That number matters because of where it sits. An earlier run at n = 20 per path showed 45% / 30% / 20%, a spread of ±12.5 points, which reads as a trend to any sceptical eye. **This design is powered to detect precisely that effect, and it did not: the spread collapsed to 30.0% / 31.7% / 26.7% and chi-square fell from 2.927 to 0.374.** The apparent trend was sampling noise, and n = 180 is the sample size that says so rather than merely failing to contradict it.

**What it cannot rule out** is a genuine skew smaller than roughly ±13 points. Detecting a ±3 point skew would need on the order of 3,000 samples. So the honest statement is: any real effect is smaller than ±13 points, and the point estimate sits at essentially zero.

### The transfer cap, which is now an extra rather than a defence

Before the resample, the cap carried weight: with an apparent skew on the table it
mattered how many observations an attacker could gather. After n = 180 it does not.
The finding is that **there is nothing detectable to accumulate** — chi-square 0.374
at p = 0.83, mutual information below the noise floor. Presenting the cap as a second
line of defence would be mounting a guard against a concern the measurement already
dissolved.

It is worth having anyway, as an owner-set bound on a channel nobody has shown to
exist. `Session.maxTxCount` is plaintext, fixed at open, enforced by the contract,
and reported by `session_status`. At the console's default of 50, a whole session
yields 50 observations — enough power to detect only a spread of ±24 points or more,
which is four times larger than what n = 180 already excludes.

So: the channel is not measurable, and the cap means one session could not measure
it even if it were. Those are two statements in that order, and the first is the one
that matters.

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
| whether an amount fits     | yes, as a boolean, against a 50-token bucket | —                                |
| recipients, tokens, timing | yes               | —                                                           |

That boolean was an oracle: free, repeatable and caller-chosen, so forty calls binary-searched the exact budget. It now answers against the budget rounded down to a 50-token bucket, which is why the row says "bucket" rather than "yes". Written up in `docs/leakage.md` §9.

There is no configuration option that disables the reveal confirmation. Adding one would remove the only thing standing between "the model can ask" and "the model has it".

In sealed mode the model receives `{status, ok_ref, sent_ref}` and no number, ever — not even after the fact, because the reference is opaque and `revealAmount` needs a click.

---

## 5. Known limits

- **Biometric unlock is not implemented.** The vault key is encrypted at rest under the OS keychain (macOS Keychain, Windows DPAPI, libsecret) and unlocking requires a local human action at the console. A true Touch ID / Windows Hello prompt needs a native module per platform and is not here. The brief's preference order put biometric first; what is implemented is the second item, and this says so rather than implying otherwise.
- **`--dev-unlock` skips the human step.** It is hard-gated to chainId 11155111 and refuses to run anywhere else. Asserted in `test/mcp.ts`, including the case where the vault exists and is loadable.
- **A leaked session key costs the remaining budget**, to addresses already on the allowlist, until expiry. That is the designed bound, not an accident — but it is a real loss, and the budget and allowlist are the only things limiting it.
- **The operator grant outlives the session.** `token.setOperator(module, expiry)` is set outside `SaveTogetherSession` and expires on its own schedule. Closing a session does not clear it; the module simply has no live session to act under. `revoke_all` says this in as many words rather than implying the grant is gone.

---

## 6. What the hosted server sees

Everything above describes a session client running on the user's own machine.
Hosting moves that process onto a server, and **the process that encrypts an
amount necessarily knows it**. That is not a weakness of the encryption; it is
where the plaintext has to exist for `createEncryptedInput` to have anything to
encrypt. The spike in `docs/spike-plaintext-removal-RESULT.md` asked whether the
plaintext could be removed entirely and the answer was no — not for a hosted
budget, because `SaveTogetherSession.send` takes an `externalEuint64` and the change
that would let it take a handle costs the owner a signature before every
transfer.

So the honest table, in the same register as §4:

|                                    | local install               | hosted                            |
| ---------------------------------- | --------------------------- | --------------------------------- |
| the model                          | never, without a click      | **unchanged** — never, no click available |
| the chain                          | ciphertext only             | **unchanged** — ciphertext only   |
| the session client                 | your machine                | **our server**                    |
| an amount you typed in chat        | your machine                | our server (the model had it too) |
| an amount you did NOT type ("half") | your machine                | **our server. This is a real loss.** |

Two rows deserve separating rather than being averaged into one claim.

**Absolute amounts leak nothing new.** "Deposit 200" was already in the
conversation, and the model has it whether or not we host anything. The server
learning 200 adds no reader who did not already have it.

**Relative amounts are a genuine loss.** "Put half my balance in" is resolved by
the session client: it reads the balance, halves it, encrypts the result. Locally
that arithmetic happens on your machine and the number exists for microseconds in
a process you control. Hosted, the server learns your balance and your deposit,
and it learns them for every user of the service. The reference mechanism still
keeps the figure away from the **model** — that part is unchanged and is what
`pool_deposit` claims — but it does not keep it away from **us**.

`pool_deposit` used to say the amount "never left this machine". That sentence is
true of a local install and false of a hosted one, and it has been replaced with
the narrower claim that holds in both: the figure was encrypted before it reached
the chain, and the model was never given it.

### What bounds the server, since it is not blindness

- every spend is clamped against an `euint64` nobody — including the server — can
  read
- the recipient allowlist bounds where value can go
- the expiry bounds how long, at a 24-hour ceiling
- the owner closes the session from their own wallet, needing nothing from us

**Claude does not know. The chain does not know. The server does.** That is the trade —
a sentence instead of six screens, in exchange for some trust in an operator, bounded by
the encrypted budget, the allowlist and the 24-hour expiry. Splitting the session client
across MPC shares would widen this: a version where the server cannot see it either. Not
built, and "widen" is the honest verb — encrypting an amount requires somebody to hold it
in the clear, so shares divide the knowledge rather than removing it.

**A compromised server can spend up to the remaining budget, to the allowlisted
addresses, until the owner revokes.** It cannot exceed the budget, cannot send
elsewhere, cannot extend its own expiry, and never held a wallet key. That is the
bound; it is not zero, and describing it as zero would be a lie.

### The indirection held while the code was broken

Measured 2026-09-05, and it is the strongest evidence in this document because
nobody arranged it.

The reference resolver was broken: `balance` minted `bal_haauwfru` and
`pool_deposit` accepted only `bal_<digits>`, so the documented path into the pool
refused its own reference. A hosted session was asked to deposit half a balance,
could not, and had three ways to proceed anyway:

1. **Pass `bal_1`,** which the error message itself suggests. That is feeding an
   identifier it was never given into a function that moves money.
2. **Reveal the balance and compute half.** Forbidden by the tool description, and
   the exact thing the indirection exists to prevent — the figure would then be in
   the transcript.
3. **Name a round figure.** Inventing an amount.

It took none of them, said why for each, and reported the bug instead. Nothing
moved: transfers still 0, no authorisation, no partial state.

**That is the point worth extracting.** The safety property here did not depend on
the code being correct. A broken resolver is exactly the circumstance in which a
model is most tempted to improvise, because the legitimate path is closed and the
illegitimate ones look like helpfulness. The descriptions say what a reference is
FOR, and that survived the mechanism that implements it failing.

It is one observation and not a proof: a different model, or the same one under a
different prompt, may improvise. The bound that does not depend on judgement is
still the encrypted budget and the allowlist. But a design whose safety survives its
own defects is worth distinguishing from one that has never been tested against them.

Fixed in `packages/mcp-server/src/refs.ts` — one module mints and recognises, and
`test/mcp-protocol.ts` asserts the round trip without needing a chain.

### The local path is the control

The local install still works and is not a legacy path. It is the fallback when
hosting is down, and more importantly it is the evidence that the server is not
load-bearing: the same contracts, the same SDK, the same tool surface minus three
tools that need a wallet. Anyone who does not want a server in the loop can run
the same product without one, and the fact that they can is what makes the hosted
claims checkable rather than promised.
