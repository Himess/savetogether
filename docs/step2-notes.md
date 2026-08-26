# GhostKey — Step 2 notes

`GhostKeySession.sol`, its interface, and the test suite. What was decided, what the brief got wrong, what was measured.

- Date: 2026-08-26
- Contracts: `contracts/GhostKeySession.sol`, `contracts/interfaces/IGhostKeySession.sol`, `contracts/mocks/MockERC7984.sol`
- Tests: `test/GhostKeySession.ts` — 18 passing, 0 failing
- `pnpm compile`, `pnpm typecheck`, `pnpm lint` all pass

---

## 1. The headline: exact gas equality

Test 1 asserts that a successful transfer, an over-budget transfer, and an insufficient-balance transfer cost **identical** gas. They do.

```
    indistinguishability:
      success          gas 713134
      over-budget      gas 713134
      short-balance    gas 713134
```

Same number, not a bound. The test also asserts the event signature, the token topic, the recipient topic, and the payload size are identical across the three. It confirms the three paths really were three different outcomes by decrypting the budgets afterwards: 500 spent, 100 untouched, 1000 restored.

**Why it holds, structurally.** Every path runs the same operation sequence. There is no branch on an encrypted value anywhere, because there cannot be one. An over-budget request still performs a real `confidentialTransferFrom` — with an encrypted zero. And `FHE.select` and `FHE.add` mint a fresh handle on every path regardless of the encrypted condition, so `_remaining` is always written with a value that differs from what was there, and the same-value SSTORE discount never applies on any path.

**What the measurement does and does not cover.** These numbers come from `@fhevm/hardhat-plugin` mock mode. The ACL and the FHEVM executor are really deployed to the local chain and really execute — `ZamaConfig._getLocalConfig` exists precisely because chainid 31337 has its own deployed host contracts — so the ACL storage writes and executor calls in these figures are real EVM work. What is mocked is the FHE computation itself. Since the equality argument is about the operation sequence rather than the cost of any single operation, mock mode is the right place to assert it. **Confirming the same equality on Sepolia is still worth doing and is listed as an open item for step 5.**

Test 1's setup is deliberately symmetric so the result means something: three separate owners, three separate session keys, and a recipient warmed beforehand so `_balances[to]` is initialized on every path. Every storage slot each path touches is cold in the same way.

---

## 2. A real bug the tests caught

The design review had C2 right in principle and wrong in practice.

The plan was to emit `within` and `sent` with `FHE.allow` to the owner and the session key, so a client could tell a budget rejection from an insufficient balance. That was implemented. Tests 3 and 3b then failed with:

```
dapp contract 0xB7f8... is not authorized to user decrypt handle 0x00d9ba4a...
```

`userDecrypt` authorises against **both** the requesting account and the contract the handle is read through. The module held only _transient_ access to `within` and `sent` — granted by the executor for `within`, and by the token for `sent` — and transient access dies at end of transaction. Granting the two accounts was not enough; the module had to grant itself persistently as well.

Fix: add `FHE.allowThis(within)` and `FHE.allowThis(sent)` before the per-account grants.

Worth stating plainly: without those two lines the contract compiles, every budget test passes, and the emitted handles are permanently undecryptable. The two-failure-mode distinction — the thing C2 exists for — would have been silently broken. It was caught only because tests 3 and 3b decrypt the event fields rather than just checking the budget.

---

## 3. Design decisions taken

**`closeSession` does not zero the budgets.** The plaintext guards in `send` already reject every call once `expiry` is 0, and a session key can never be reused, so a stale budget handle is unreachable. Zeroing would cost one FHE operation and one storage write per funded token on a function that must stay cheap and unconditional — the session client has to be able to self-terminate even under gas pressure. Leaving the handle also keeps the final balance auditable by the owner afterwards. Justified in natspec on the function.

**A zero amount is rejected client-side, not on chain.** `requested == 0` produces `within = true, sent = 0`, which is identical to an insufficient balance. Distinguishing them on chain would cost an extra FHE operation for no benefit: the session client constructed the ciphertext and therefore knows its own plaintext. The natspec says this is a client obligation rather than describing it as an unresolvable ambiguity.

**`Session` packs into one slot** via sentinels rather than flags: `owner == 0` means the key was never used, `expiry == 0` means closed, `expiry <= block.timestamp` means lapsed. `owner` is never cleared, which is what makes the single-use key invariant structural rather than a convention. Test 8c pins it.

**No token allowlist as separate state.** `FHE.isInitialized(_remaining[key][token])` is the guard, which is the same check a separate allowlist would perform, without the extra storage. See §4.

**`increaseBudget` does not trust `tryAdd`'s failure value.** `FHESafeMath.tryAdd` returns zero on overflow, which would erase the budget rather than preserve it. The old value is reinstated explicitly with `FHE.select(ok, sum, current)`.

---

## 4. Amendments A1–A4, as implemented

**A1 — token guard.** `require(FHE.isInitialized(_remaining[msg.sender][token]))` before the external call. The reasoning in the design review had a real gap: an uninitialized budget prevents _spending_ but not _calling_, and `send` grants the token transient ACL access via `FHE.allowTransient(amount, token)` immediately before invoking it. Without the guard, a compromised session key could name any address and get both an ACL grant and a call to it. `isInitialized` is a pure zero-check on the handle (`FHE.sol:90-92`), so this costs no HCU. Test A1 covers it. `nonReentrant` is kept as well — the guard eliminates arbitrary contracts, the reentrancy guard covers a hostile token the user registered themselves.

**A2 — exact gas equality.** Done, §1.

**A3 — terminology.** `session client` and `model` are used throughout the interface and contract natspec. The word "agent" appears nowhere on its own. The distinction is defined once at the top of `IGhostKeySession`.

**A4 — multi-token `openSession` in one transaction.** `SessionParams` carries parallel `tokens` and `budgets` arrays and a single shared `inputProof`. Test 5 confirms the SDK side: one `createEncryptedInput` with two `add64` calls produces `handles.length === 2` under one proof, and both budgets are funded in one transaction. Practical ceiling per session: `FHE.fromExternal` consumes **no HCU** (there is no `checkHCUFor*` entry for `verifyCiphertext` in `HCULimit.sol`), so the limit is calldata and EVM gas, not the FHE budget. Duplicate tokens are rejected with `DuplicateToken`.

---

## 5. HCU: estimated vs measured

Analytic estimate from the design review, unchanged by implementation:

| side            | operations                                                              | HCU           |
| --------------- | ----------------------------------------------------------------------- | ------------- |
| module          | `tryDecrease` 369,000 + `select` 55,000 + `sub` 162,000 + `add` 162,000 | 748,000       |
| token `_update` | `tryDecrease` 369,000 + `select` 55,000 + `add` 162,000                 | 586,000       |
| both            | `trivialEncrypt` × 2                                                    | 64            |
| **total**       |                                                                         | **1,334,064** |

6.7% of the 20,000,000 per-transaction ceiling; roughly six operations of sequential depth against the 5,000,000 depth limit.

**Not measured.** Mock mode does not meter HCU — `HCULimit` accounting is not exercised by the plugin's local deployment in a way the test can read back. Test 10 therefore asserts on the operation shape via EVM gas (`send()` at 735,444 gas, bounded at 3,000,000) and the HCU figure stands as an analytic estimate only. **Measuring real HCU on Sepolia is an open item for step 5**, alongside the gas-equality confirmation.

The estimate is unchanged by the two `allowThis` calls added in §2: `FHE.allowThis` is an ACL write, not an FHE operation, so it costs EVM gas but no HCU.

---

## 6. Nothing else in the design review turned out wrong

The storage layout, the `send` ordering, the truth table, and all five conflicts held up under implementation. The refund arithmetic behaves exactly as the table predicted, verified by decryption in tests 1, 3, 3b and 11:

| case          | `within` | `sent`    | resulting `remaining` | test  |
| ------------- | -------- | --------- | --------------------- | ----- |
| success       | true     | requested | decremented           | 1, 2  |
| over budget   | false    | 0         | unchanged             | 1, 3b |
| balance short | true     | 0         | **restored**          | 1, 3  |

Test 11 pins the global invariant across a pseudo-random sequence of eight sends straddling the budget boundary: `received + remaining == initialBudget` exactly, and `received <= initialBudget`.

---

## 7. Open questions for step 3

1. **Sepolia confirmation of gas equality and HCU.** The structural argument is sound and mock mode agrees, but the headline claim deserves live evidence. Needs three funded owner EOAs.
2. **Zero-amount rejection is a client obligation.** The SDK must enforce it; the contract deliberately does not. If the SDK forgets, users get told "insufficient balance" when they asked to send nothing.
3. **`within` is an `ebool`.** The SDK decrypts it with `FhevmType.ebool`, a different call from the `euint64` handles. Two decrypt paths in one result object.
4. **Delegation is optional and the SDK must model it as such.** ACL delegation is required for exactly one capability: reading the holder's _balance_, needed only for reference amounts like "send half". Everything else — what was spent, what is left, what actually moved — is readable from this module's own handles with no delegation at all. The privacy tier the SDK should expose is: _the session client sees what it spent and what remains, but not what is in the wallet._
5. **`protocolStatus` should be surfaced in the client's error path.** `send` never reverts on a budget or balance failure, but it can still revert because the ACL is paused or has deny-listed a participant. The view exists so the client reports the real cause instead of an opaque failure.
6. **Operator expiry is not tracked by this contract.** `token.setOperator(module, expiry)` is set outside the session and can lapse independently of `Session.expiry`. A session whose operator grant has expired will revert inside the token rather than fail gracefully. The SDK should check both, or step 3 should decide whether the contract ought to expose a combined readiness view.
