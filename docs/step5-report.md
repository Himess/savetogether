# SaveTogether — step 5 report

Self-contained: it repeats the facts it depends on, so it reads without the repo.

State: 82 unit tests passing, 17 SDK integration tests passing against live Sepolia, typecheck and lint clean across four packages. Head is `9196d5d`.

---

## 1. Task A — the gate at n = 180

The n = 20 result was underpowered and the criticism was right. Resampled at 60 per path, **180 live Sepolia transactions**:

| path          | n   | 891,568 | 891,572 | low-value rate |
| ------------- | --- | ------- | ------- | -------------- |
| success       | 60  | 18      | 42      | 30.0%          |
| over-budget   | 60  | 19      | 41      | 31.7%          |
| short-balance | 60  | 16      | 44      | 26.7%          |

```
chi-square              0.374 on 2 df (critical 5.991 at p=0.05), p = 0.83
mutual information      0.00151 bits per observation
Miller-Madow floor      0.00801 bits at N=180
cross-check x2/(2N ln2) 0.00150 bits
FHE op sequences        1 distinct   FheAdd x2 FheGe x2 FheIfThenElse x4 FheSub x3 TrivialEncrypt x2
HCU                     1 distinct   1,334,064
```

The apparent trend at n = 20 — 45% / 30% / 20% — collapsed. Chi-square fell from 2.927 to 0.374.

### Why this is stronger than "a larger sample"

**The measured mutual information is below the noise floor.** Miller–Madow bias at N = 180 is `(r-1)(c-1)/2N` = 2/360 nats = **0.00801 bits**, which is what a _perfectly independent_ process typically shows at this size. The measurement is 0.00151 — a fifth of it — so the bias-corrected estimate is negative. That is the signature of a true mutual information of zero with sampling noise landing low, not of a small leak.

**The design is powered to detect the effect it did not find.** 80% power at 2 df needs a non-centrality parameter of 9.63; at N = 180 that is Cohen's `w = 0.231`, which for three equal groups at a pooled rate of 29.4% corresponds to a spread of about **±13 percentage points**. The n = 20 run appeared to show ±12.5 points. So this is a _failure to detect a real effect of exactly that size_, not an underpowered shrug.

### What n = 180 cannot rule out

A genuine skew below ±13 points. Detecting ±3 points would need on the order of 3,000 samples. This is stated in `docs/leakage.md` §3 rather than left for a reader to work out.

Independently of that: `Session.maxTxCount` bounds how many observations one session yields. At the console's default of 50, a whole session has the power to detect only a spread of **±24 points or more** — four times larger than what is already excluded at n = 180.

---

## 2. The ordering audit across all ten tools

The `can_afford` bug was the visible edge of something worse.

### What the audit found

**No address argument was validated anywhere in the system.** `send(to)`, `addRecipient(to)` and `openSession(allowlist[])` all passed raw strings straight to ethers.

**`addRecipient` unlocked the vault before looking at its argument.** The order was `requireLive()` → **vault unlock** → pass `to` to the contract. So "add Mehmet to the list" — a thing a user says — cost the user a _physical console click_ and returned an ABI encoding error. That is worse than a wasted round trip; it spends a human action on an argument that was never going to work.

**`openSession` never checked its allowlist**, so a bad address there would burn an unlock and three transactions before failing.

### What was done

Addresses are validated first, everywhere, before any state check and long before any unlock. The messages name what is wrong:

- not an address → says so, and says names and ENS are not resolved
- right shape, bad checksum → says a character is probably mistyped, and to paste rather than hand-correct

**Names and ENS are refused rather than resolved.** Resolution is a chain call whose answer the user cannot check before signing, and this is the single argument where being wrong sends money to a stranger.

### Final state, all ten

| tool             | first argument check     | first state check     | verdict             |
| ---------------- | ------------------------ | --------------------- | ------------------- |
| `openSession`    | array lengths, allowlist | —                     | args only           |
| `list_assets`    | —                        | —                     | no args, no state   |
| `balance`        | `token`                  | `requireLive`         | OK                  |
| `remaining`      | `token`                  | `requireLive`         | OK                  |
| `can_afford`     | `token`, `amount`        | `requireLive`         | OK                  |
| `session_status` | —                        | `requireLive`         | no validatable args |
| `send`           | `token`, `to`, `amount`  | `requireLive`         | OK                  |
| `add_recipient`  | `to`                     | `requireLive`, unlock | OK                  |
| `wrap`           | `token`, `amount`        | unlock                | OK                  |
| `revoke_all`     | —                        | —                     | no args, no state   |

Twelve protocol tests, one per case, **all with no session open** — so a state-first implementation fails every one of them. The reasoning is written into the code beside `requireLive` so nobody tidies the ordering back.

---

## 3. Other untested layers

The protocol gap was a category, not a bug. Asking what else had _no_ coverage found two more, and one of them was broken.

### The keystore had no coverage and was broken on Windows

It is the **first thing that runs on a new machine**.

`Set-Content` appended a newline; `Get-Content -Raw` returned it; `ConvertTo-SecureString` rejected the result — and the read path caught the error and returned `null`. So the failure presented as _"no passphrase found"_.

**Every vault created on Windows was unopenable**, and the message sent the user off to create another one that also would be. Found by running the code by hand, because nothing exercised it.

Fixed three ways: trim on read, write with `-NoNewline`, and stop swallowing decryption failures — a blob that exists but will not decrypt is a different thing from one that was never stored, and reporting them identically is what made this invisible. Now exercised against whatever backend the host actually has (DPAPI here, Keychain on macOS, libsecret elsewhere), including an assertion that no mnemonic is derived or written.

### The console could be asked for a confirmation after it had stopped

The waiter was registered, nobody could answer it, and the tool call hung for the **full three-minute timeout** with no page to click on. It now fails immediately.

### Still uncovered, and named rather than fixed

**There is no way for a client to reconcile after a crash between submission and settlement.** The contract is atomic and `remaining()` tells the truth on restart, but the `Sent` event for that particular transfer sits on chain with no API to read it back. A `history()` method would close it. Its shape should be decided **after** E, because what a model asks for after a crash determines what the method needs to return.

### One more, incidental

Every multi-line patch attempted after a `git checkout` failed silently against CRLF — matching in the editor and not on disk. `.gitattributes` with `eol=lf` removes the trap.

---

## 4. Which doc sections are stubbed pending E

The brief's "F waits for E" was too coarse; E changes tool descriptions and nothing else.

**Written now** — none of these quote tool wording:

|                        |                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture.md` | the three authorities; why the operator route rather than the ERC-7984 hook framework; why one key would make the budget decoration; why the transfer runs even when it moves nothing |
| `docs/threat-model.md` | attacker by attacker, and it lists the passes that **found** something rather than only the defences that held                                                                        |
| `docs/leakage.md`      | final pass with the n = 180 figures, the noise-floor comparison and the power statement                                                                                               |
| `README.md`            | everything except the tool surface                                                                                                                                                    |
| `docs/evidence.html`   | the screenshot-able one-pager                                                                                                                                                         |

**Stubbed, explicitly and with the reason visible:**

- **`README.md` → "The tool surface"** carries a note saying the descriptions have not yet met their user and will be revised against observed behaviour. It points at `packages/mcp-server/README.md` for the current ten and states the one thing that will not change: there is no `unwrap`.
- **The quickstart transcript** — the README has the two setup commands, but no worked conversation, because what the conversation looks like is E's output.
- **`docs/step5-notes.md`** does not exist yet. It is where E's before/after belongs.

---

## 5. Setup flow, so E can be run

`savetogether console` opens the page with no chat client attached. Funding a vault and minting test tokens is setup, and setup should not need a conversation open — you want the address before you have anything to say.

The console gained a vault panel (address, gas, network, copy) and a mint control for test tokens. **Confidential balances are deliberately absent from the page**: reading one is a decryption, and a decryption is the act this product exists to make deliberate.

Minting signs with the vault, so it raises a real unlock prompt even though the user is already standing at the console. That is the rule holding, not an oversight — and it happens before any session exists, so it does not touch the unlock counter.

**Note:** `/mnt/skills/public/frontend-design/SKILL.md` does not exist on this machine. The console was designed without it.

---

## 6. Task B and C, as delivered

**B — the counter.** Now reads `Vault unlocks this session`. The field was renamed too (`signatures` → `vaultUnlocks`), not just the label, so the wrong word cannot drift back. Every README and doc was audited for the same substitution.

Also caught in passing: `Number(null)` is `0`, so `null` was being silently accepted as "uncapped" by the console's cap endpoint. Junk must be rejected, not interpreted as the most permissive setting.

**C — the sweep.** `close()` returns the session key's leftover gas to the owner, signed by the session key, best-effort: the close is awaited first and stands whatever the sweep does. The reserve is computed from `maxFeePerGas` so the sweep cannot price itself out between estimate and inclusion. `revoke_all` reports what came back, or says plainly that it is stranded.

**D — the cap.** On the console, not in a tool call, so a chat client cannot talk a user into a wider one. Default 50, chosen against the leakage bound, with that sentence printed beside the control.

---

## 7. Task G

**Done:**

- `docs/evidence.html` — the gate table, op-sequence and HCU equality, the noise-floor comparison, the power statement, and the trace diff localising the four gas to `HCULimit`.
- **`--dev-unlock` verified end to end:** unlocks without a click on Sepolia; refuses on mainnet _even with a loadable vault_ (the gate is on chain id at unlock time, not at construction, so a provider swapped after startup cannot slip past); and with neither a console nor a TTY it declines rather than proceeding.

**Waiting for E:** the demo script. The order that shows the argument depends on how the model actually behaves — which tool it reaches for when asked for "half", whether it understands the spend-only refusal from the error alone.

---

## 8. What remains

1. **Task E.** The MCP has never been driven by a model. This is the largest untested surface in the system and it is not a code path — it is the product's actual interface. It needs a chat client and a human at the console.
2. The demo script, after E.
3. `history()` for crash reconciliation, shaped by what E shows.
4. EIP-5792 batching is implemented and **unverified against a live wallet**. The product path does not use it.
5. No confirmation-depth policy anywhere. Acceptable on Sepolia; not on mainnet.

---

## 9. What I would push back on

**The brief's `open_session` signature has no `maxTxCount`.** I originally argued this on leakage grounds — the cap as a second independent bound on the timing channel. **That argument is now retired:** at n = 180 there is no measurable channel for the cap to bound, and presenting it as a defence would be guarding against a concern the measurement dissolved. The cap is an owner-set extra, and `docs/leakage.md` §3 now says so in that order.

What survives is smaller and is not about leakage: a session with no cap has no ceiling on how much it can do before its TTL expires, and a user who never opens the console never sets one. The default of 50 is the only thing between them and that. Worth deciding whether the first session open should require the console once regardless — not to bound a side channel, but so the ceiling is a choice somebody made.

~~**"One vault unlock" is doing a lot of work in the pitch.**~~ **Withdrawn — the sign was backwards.**

I filed the counter's increments as a presentational risk to be managed. They are the opposite. A counter that never moves proves nothing; it could be a constant with a label on it. One that moves **exactly when the owner authorises something and never otherwise** is a measurement, and the fact that `wrap` and `add_recipient` each cost another unlock is what demonstrates the counter is wired to the thing it claims to count.

Acted on rather than merely conceded: each unlock now records what it bought, and the console renders the breakdown — `1 session · 1 recipient added · the vault locked again after each` — so an increment reads as attributable rather than as drift. Four tests execute the shipped `renderStatus` pulled out of the served page, because a test against a copy of that logic would pass while the page said something else.
