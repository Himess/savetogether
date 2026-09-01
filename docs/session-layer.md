# SaveTogether

**An encrypted spending budget for ERC-7984 confidential tokens.** Hand a session a bounded amount it can spend, and let it spend without anyone — including the session — learning how much is left.

Every number below links to the artifact that produced it. Where something is unverified, it says so.

---

## The problem

`ERC7984.setOperator(spender, until)` grants an operator unlimited spending authority over your confidential balance, bounded only by time. OpenZeppelin's own documentation is blunt about it:

> Setting an operator lets that address take all of your tokens.

Fine for a contract you audited. Not fine for a process driven by a language model — which is the case this exists for. What is missing is an **amount** bound, and on a confidential token that bound has to itself be confidential, or it leaks the thing the token was hiding.

---

## What it does

Three authorities, held by three different things:

|            | mechanism                            | who holds it                             |
| ---------- | ------------------------------------ | ---------------------------------------- |
| **move**   | `token.setOperator(module, expiry)`  | the module — it can move, it cannot read |
| **read**   | `ACL.delegateForUserDecryption(...)` | the session key, **only if you opt in**  |
| **amount** | `euint64 remaining` in the module    | nobody — never decrypted on chain        |

Every transfer is clamped against the encrypted budget homomorphically. An over-budget request is not rejected: it performs a **real** transfer carrying an encrypted zero. Same call, same events, same storage writes, same cost. An observer cannot tell an accepted transfer from a refused one.

Two keys, both generated locally, no seed phrase derived at all:

- **vault key** — owns the funds, stays locked, unlocks **once** per session
- **session key** — bounded by the budget and a recipient allowlist, stays warm

If the vault key were the only key the budget would be decoration — an owner can always bypass the module and call `confidentialTransfer` directly. The split is what makes the budget real.

The console shows a count of vault unlocks. Opening a session is one. `wrap` and `add_recipient` each cost another, and the counter **goes up when they do** — which is the point: a number that never moves could be a constant with a label on it, and one that moves exactly when you authorise something is a measurement.

---

## The evidence

The central claim is that a successful transfer, an over-budget one and an unaffordable one are indistinguishable. **180 live Sepolia transactions, 60 per path:**

| path          | n   | 891,568 gas | 891,572 gas | low-value rate |
| ------------- | --- | ----------- | ----------- | -------------- |
| success       | 60  | 18          | 42          | 30.0%          |
| over-budget   | 60  | 19          | 41          | 31.7%          |
| short-balance | 60  | 16          | 44          | 26.7%          |

```
FHE operation sequence   identical on all 180   FheAdd x2 FheGe x2 FheIfThenElse x4 FheSub x3 TrivialEncrypt x2
HCU                      identical on all 180   1,334,064
chi-square               0.374 on 2 df (critical 5.991), p = 0.83
mutual information       0.00151 bits/observation — below the 0.00801-bit noise floor for this N
```

The two quantities that describe what the FHE layer _did_ are exactly identical. Execution gas takes two values four apart, and that four gas lives inside `HCULimit.checkHCUForFheGe` — the FHEVM's own cost accounting, outside anything this project controls.

An earlier run at 20 samples per path showed 45% / 30% / 20%, which reads as a trend. This design has 80% power to detect a spread of ±13 points — the spread that run appeared to show — and it did not detect it. That is a failure to find a real effect, not a shrug.

Full accounting: [`docs/leakage.md`](docs/leakage.md). The run: [`docs/step3-gate.md`](docs/step3-gate.md). Raw data: [`spikes/out/sepolia-distribution.json`](spikes/out/sepolia-distribution.json).

One-page versions: [`docs/evidence.html`](docs/evidence.html) reads; [`docs/evidence-card.html`](docs/evidence-card.html) is the same argument in a single 16:9 frame, sized to be screenshotted.

---

## Quickstart

```bash
npx savetogether init --rpc https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
npx savetogether console
```

`init` writes the Claude config, generates both keys, and prints an address. `console` opens a local page where you fund the vault and mint test tokens — setup does not need a conversation open, and you want the address before you have anything to say.

No manual JSON editing, no network switching, no browser extension, and no seed phrase: none is derived, so there is nothing to write down.

Then start Claude and talk to it.

---

## Two privacy tiers, chosen when you open a session

Delegation buys exactly one capability: reading your **balance**, which is only needed for reference amounts like "send half". What was spent, what remains and what actually moved are readable without it.

**spend-only** — the session client sees what it spent and what is left. Never what is in your wallet.

**balance-visible** — it can also read your balance, so "send half" works.

Neither is degraded. In the SDK they are two _types_, so a reference amount does not compile on a session that cannot read the balance.

---

## What the model sees

Never a plaintext amount by default. Balances and budgets come back as opaque references; revealing one requires a click on the local console, **every time**, and there is no setting that turns the confirmation off.

**Sealed mode** puts the amount input on the console. You type it, the session client encrypts it, and the model receives only whether it went through.

What sealed mode does **not** hide, said plainly: that a transfer happened, the token, the recipient, and the time. ERC-7984 hides amounts, not activity, and recipients are public on chain regardless.

---

## The tool surface

> **Pending.** The tool descriptions are the product's real interface and they have not yet met their user — no model has read them and chosen among them. They will be revised against observed behaviour before this section is written. See [`docs/step5-notes.md`](docs/step5-notes.md) when it lands.
>
> The current surface is ten tools, documented in [`packages/mcp-server/README.md`](packages/mcp-server/README.md). There is deliberately **no `unwrap`**: returning to a public balance requires publicly decrypting the amount, which is a disclosure decision a session must not make on your behalf.

---

## Latency

One confidential transfer is about 29 seconds end to end on Sepolia. The breakdown is what matters:

| phase                      | median                                                           |
| -------------------------- | ---------------------------------------------------------------- |
| encrypt + prove + register | 12.5s — client-side, **before any transaction exists**           |
| submit → mined             | 8.8s — block time, irreducible                                   |
| coprocessor settlement     | ~2.5s — effectively free; polls succeeded first try in every run |

Proof generation is the slow half and does not depend on the chain, so the SDK starts it the moment intent is legible and submits later. Measured through the SDK's own API: `proof 12.1s, submit+settle 32.5s`.

---

## Packages

|                                              |                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------- |
| [`contracts/`](contracts)                    | `SaveTogetherSession.sol` and its interface                             |
| [`packages/sdk`](packages/sdk)               | headless client — no MCP, no model, no chat context                 |
| [`packages/console`](packages/console)       | the localhost page                                                  |
| [`packages/mcp-server`](packages/mcp-server) | the tool surface, the vault, the CLI                                |
| [`spikes/`](spikes)                          | live-chain measurements; every figure in these docs comes from here |

The SDK imports nothing from the MCP server. That separation is what makes this infrastructure rather than a demo.

---

## Limits

Stated here rather than buried, because the ones that matter are the ones a reader would otherwise have to find.

- **The MCP has never been driven by a model.** Every test is deterministic code calling the SDK, or a client calling tools by name. Whether a model reading these descriptions picks the right tool is the largest untested surface in the system.
- **Biometric unlock is not implemented.** Key material sits under the OS keychain and every vault signature needs a local human action, but there is no Touch ID or Windows Hello prompt — that needs a native module per platform.
- **A leaked session key costs the remaining budget**, to allowlisted addresses, until expiry. That is the designed bound, not an accident, and it is why the two-tier split exists.
- **ACL grants already issued cannot be revoked retroactively.** Revoking read access is forward-looking; anything already decrypted is already known.
- **Closing a session does not clear the operator grant.** It expires on its own schedule, and `revoke_all` says so rather than over-promising.
- **No confirmation-depth policy.** A reorganised `send` has moved nothing, but the client may already have said it succeeded.
- **EIP-5792 batching is implemented but unverified** against a live wallet. The product path does not use it.
- **Sepolia only.** `--dev-unlock` is hard-gated to chain 11155111 and refuses to run anywhere else.

Full threat model: [`docs/threat-model.md`](docs/threat-model.md).

---

## Documentation

|                                                |                                                             |
| ---------------------------------------------- | ----------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md) | the three authorities, why the operator route, why two keys |
| [`docs/leakage.md`](docs/leakage.md)           | what leaks, what does not, and the measured bound           |
| [`docs/threat-model.md`](docs/threat-model.md) | attacker by attacker, including the passes that found bugs  |
| [`docs/step3-gate.md`](docs/step3-gate.md)     | the indistinguishability gate, in full                      |
| [`findings.md`](findings.md)                   | step-1 assumption verification against live Sepolia         |
| [`PROGRESS.md`](PROGRESS.md)                   | the build log, decisions and product gaps                   |

---

## License

MIT. Note that `@fhevm/solidity` ships under BSD-3-Clause-Clear; depending on it is fine, vendoring it into an MIT repo is the thing to check.
