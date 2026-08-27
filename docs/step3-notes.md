# GhostKey — Step 3 notes: `packages/sdk`

Headless client for encrypted spending sessions. Usable with no MCP server and no language model; nothing in it imports from `@ghostkey/mcp-server` or assumes a chat context.

The decision log and the adversarial passes live in [`PROGRESS.md`](../PROGRESS.md). This file is the SDK's own record: what it exposes, what was verified live, and what is still open.

---

## 1. The gate, first

Step 3 opened with a gate: prove on live Sepolia that a successful transfer, an over-budget transfer and an insufficient-balance transfer are indistinguishable, before building anything on top of the claim.

It passes. 60 live transactions, 20 per path. The FHE operation sequence and the HCU consumption are **identical** on every path; execution gas takes two values four apart, with chi-square 2.927 against a critical 5.991 — not distinguishable. Full report in [`step3-gate.md`](./step3-gate.md), residual leak bounded in [`leakage.md`](./leakage.md).

Two things had to be built that the brief did not anticipate:

- **A per-path control.** Proving gas is not a _deterministic_ function of the path is weaker than proving it is _independent_ of it: a skewed distribution leaks without being deterministic. Ten sends on one fixed path produced both values; the three-path distribution comparison is what actually closes it.
- **Transient-failure retry.** The first 60-sample run died on sample 5 with `UND_ERR_CONNECT_TIMEOUT` from the Zama relayer. Recorded as a product requirement, not just a harness fix — a session client that dies on one relayer timeout is unusable.

---

## 2. What the SDK exposes

|                   |                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| session lifecycle | `openSession`, `resumeSession`, `close`, `addRecipient`, `removeRecipient`, `increaseBudget`                                                          |
| reads             | `params`, `tokens`, `recipients`, `remaining`, `canAfford`, `readiness` — and `balance` only on the balance-visible tier                              |
| sending           | `send`, and `prepare` for proof warming                                                                                                               |
| amounts           | `AmountRef`, `exact`, `ref`, `all`, `revealAmount`                                                                                                    |
| custody           | `osKeychainKeystore`, `memoryKeystore`                                                                                                                |
| errors            | `ZeroAmountError`, `OperatorNotGrantedError`, `ProtocolUnavailableError`, `SessionNotLiveError`, `RecipientNotAllowedError`, `BalanceNotVisibleError` |

### Two tiers are two types

`SpendOnlySession` has no `balance()`. `BalanceVisibleSession` does. `ref(balance).half()` therefore fails to **compile** on a session with no ACL delegation, rather than failing at runtime with a message about a delegation the caller never asked for.

Neither is degraded. Spend-only is a complete session that simply cannot answer "what is in the wallet" — a privacy property, not a missing feature. Both are exercised end to end against Sepolia.

### Amounts are opaque by construction

`AmountRef` carries no numeric field, and its resolver lives in a module-private `WeakMap` rather than on the instance — so a plaintext cannot be reached by reading a property, spreading the object, or JSON round-tripping it. `toString` and `toJSON` emit `AmountRef(budget:0x8ea53303…)`, asserted against a real handle in the Sepolia suite, so an accidental template interpolation cannot leak a value.

`revealAmount(ref, { reason })` is the only path to a `bigint`. It is named for what it does and takes a reason, so a leak is always a deliberate call at a site a reviewer can grep for.

### Proof warming is designed in

Step 1 measured 29s median end to end, of which 12.5s is client-side ZK proof generation with near-zero variance, occurring before any transaction exists. `prepare(intent)` starts it immediately and returns a handle; `ready` settles when the proof exists; `send()` submits. Measured in the Sepolia suite: the proof is the slow half and it happens first.

---

## 3. Verified live, not in mock mode

Every claim below is asserted in `test/sdk.sepolia.ts`, which imports `@ghostkey/sdk` through the workspace link rather than reaching into `src/`, so what runs is the surface a consumer gets.

- opening a session with **one** owner authorisation, and `ownerAuthorisations` reporting it
- readiness reporting the operator grant the open just made
- a successful send, with the budget decremented by exactly the amount
- an over-budget send reported as such, without a revert, with **the budget untouched**
- a zero amount refused before it reaches the chain
- a recipient outside the allowlist refused
- the spend-only tier having no `balance()` at runtime as well as at compile time
- the owner widening the allowlist mid-session, and the session then sending to the new address
- the session key narrowing its own scope
- proof warming, with the timings printed
- closing, and readiness going false afterwards
- the balance-visible tier reading the holder's balance through **delegated** decryption, with the session key's own signature
- a reference amount (`half`, `cap`) resolving without the caller seeing a number
- `AmountRef` staying opaque under interpolation and JSON
- a lapsed operator grant reported as `OperatorNotGrantedError` rather than an opaque revert

---

## 4. What the SDK enforces that the contract deliberately does not

The contract leaves three things to the client on purpose. The SDK does them so a user gets a named cause instead of a revert from inside a token they have never heard of.

- **Zero amounts are refused before encryption.** The chain reports a zero request identically to an insufficient balance and spends no FHE operation trying to distinguish them.
- **`token.isOperator(owner, module)` is checked before sending.** Operator grants lapse independently of `Session.expiry`.
- **`protocolStatus` is surfaced.** `send` never reverts on a budget or balance failure, but a paused ACL or a deny-listed participant will still stop it.

`readiness()` returns all of it at once, with reasons.

---

## 5. What turned out wrong in the brief

Detail in [`PROGRESS.md`](../PROGRESS.md); summarised here because they changed the code.

- **D1 — ethers, not viem**, reversing `step3-sdk-api.md`. §5.1 puts both keys on the machine, so there is no browser wallet for EIP-5792 to batch through and viem's main advantage does not apply to the product path. Everything verified in this repo runs on ethers. EIP-5792 is still implemented for consumers who do have a browser wallet.
- **D4 — Web3 Secret Storage v3, not EIP-2335.** EIP-2335 is the eth2 BLS keystore; a secp256k1 session key wants v3, which ethers implements natively. Substituted deliberately.
- **G1 — "one signature" is one vault unlock**, not one EIP-5792 batch.
- **G5 — the SDK generated a session key it could not pay for.** Found by its own integration test. The funding logic was in the MCP layer, so anyone using the SDK directly inherited the footgun; it now lives in `openSession`, with `DEFAULT_SESSION_GAS` and a `gasForSessionKey: 0n` escape.

---

## 6. Open for step 4 and beyond

1. **G6 — nothing reclaims a closed session key's gas.** Opening N sessions costs the vault N × 0.02 ETH, and closing does not sweep the remainder back. Fixable by having the session key sweep itself on close, at the cost of one more transaction in a flow whose claim is about how few there are. Left as a decision rather than taken.
2. **The relayer is not reliable.** `withRetry` exists in the spikes; the SDK should carry the same policy on `encrypt` and on decryption rather than leaving it to callers.
3. **EIP-5792 is implemented but unverified against a live wallet.** The product path does not use it, so it is untested by everything above.
4. **One session at a time.** The SDK can hold several; the MCP layer deliberately does not. If that changes, `resumeSession` is the entry point.
