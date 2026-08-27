# GhostKey — architecture

Every claim here links to the artifact that proves it. Where something is unverified, it says so.

---

## 1. The problem

`ERC7984.setOperator(spender, until)` grants an operator unlimited spending authority over the holder's confidential balance, bounded only by time. OpenZeppelin's own documentation puts it plainly: setting an operator lets that address take all of your tokens.

That is fine for a contract you audited. It is not fine for a process driven by a language model, which is exactly the case GhostKey exists for. What is missing is an **amount** bound — and an amount bound on a confidential token has to itself be confidential, or it leaks the thing the token was hiding.

---

## 2. Three authorities, kept apart

The design is one idea: the right to **move** value, the right to **read** it, and the right to decide **how much**, are three different powers and should be held by three different things.

| authority  | mechanism                                                  | who holds it                                          |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| **move**   | `token.setOperator(module, expiry)`                        | the module — it can move, it cannot read              |
| **read**   | `ACL.delegateForUserDecryption(sessionKey, token, expiry)` | the session key, and **only if the owner opts in**    |
| **amount** | `euint64 remaining` inside the module                      | nobody — it is encrypted and never decrypted on chain |

### Move without read is real, not aspirational

`setOperator` grants no FHE access at all: `ERC7984.sol:107-109` calls only `_setOperator`, which touches no ACL. Every grant on a balance handle in `_update` goes to the token and the holder — `FHE.allow(ptr, from)` at `:302`, `FHE.allow(ptr, to)` at `:315` — and never to the operator. `confidentialBalanceOf` returns the handle to anyone, but a handle without an ACL grant cannot be decrypted.

Demonstrated live rather than argued: in `spikes/delegation.ts`, a delegate holding no delegation asked the relayer to decrypt the holder's balance and got a 400. Then the delegation was granted and the same request succeeded, returning the same value the holder's own decryption returned. That negative control is what makes the positive result mean something.

### Read is optional, and it buys exactly one thing

ACL delegation is needed for **reading the holder's balance**, and for nothing else. What was spent, what remains, and what actually moved are all the module's own handles, granted to both the owner and the session key at every write — no delegation involved.

So there are two tiers, and they are two _types_ in the SDK rather than a flag, which means a reference amount like "send half" fails to compile on a session that cannot read the balance:

- **spend-only** — the session client sees what it spent and what is left, never what is in the wallet
- **balance-visible** — it can also read the balance, which is what makes "half" possible

Neither is degraded. Spend-only is a complete session that simply cannot answer one question.

### Amount is the part nobody sees

`euint64 remaining` per `(session key, token)`. Every transfer is clamped against it with `FHESafeMath.tryDecrease`, homomorphically. There is no revert, no plaintext comparison, and no branch on an encrypted value — because on FHEVM there cannot be one.

---

## 3. Why the transfer is executed even when it will move nothing

This is the part that carries the privacy claim, and it is worth stating precisely.

```solidity
(within, clamped) = FHESafeMath.tryDecrease(budget, requested);
amount            = FHE.select(within, requested, FHE.asEuint64(0));
FHE.allowTransient(amount, token);
sent              = IERC7984(token).confidentialTransferFrom(owner, to, amount);
refund            = FHE.sub(amount, sent);
newRemaining      = FHE.add(clamped, refund);
```

An over-budget request does not skip the transfer. It performs a **real** `confidentialTransferFrom` carrying an encrypted zero. Everything else is identical: same calls, same events, same storage writes.

| case          | `within` | `sent`    | resulting budget |
| ------------- | -------- | --------- | ---------------- |
| success       | true     | requested | decremented      |
| over budget   | false    | 0         | unchanged        |
| balance short | true     | 0         | **restored**     |

The third row is the one that leaks value if written wrong, and it is why the refund exists: the budget is debited before the transfer and given back when nothing moved.

**Both encrypted results are emitted**, granted to the owner and the session key, so a client can tell the two failures apart without anyone else learning which happened. That works because ACL `allow` gates on `isAllowed`, which accepts transient access (`ACL.sol:441-443`) — the module holds only transient access to `sent`, and can still make it persistently decryptable before the transaction ends.

`transferred` comes back with `allowTransient`, not `allow` (`ERC7984.sol:144`), so the module's access to it dies at end of transaction. Reconciliation therefore **must** happen in the same transaction. That is not a design preference; it forecloses the alternative.

**Evidence**: 180 live Sepolia transactions, 60 per path. Identical FHE operation sequence and identical HCU on every one; execution gas takes two values four apart, chi-square 0.374 against a critical 5.991, p = 0.83. The four gas lives in `HCULimit.checkHCUForFheGe`, outside this project. Full accounting in [`leakage.md`](./leakage.md); the run in [`step3-gate.md`](./step3-gate.md).

---

## 4. Why the operator route, and not a token hook

ERC-7984 has a hook framework — `ERC7984Hooked`, `ERC7984HookModule` — that would let a module intercept transfers at the token. It is the more elegant mechanism and GhostKey does not use it, for one reason: **it requires the token to cooperate.**

A hooked module only works on tokens deployed with hooks enabled and configured to point at it. That makes GhostKey a property of the token rather than of the user, and it excludes every confidential token already deployed — which is all of them.

The operator route works on any ERC-7984, unmodified, by the holder's decision alone. The cost is that the module cannot intercept a transfer the owner makes directly, which is precisely why the vault key must be separate from the session key (§5).

If a future token wants a tighter binding, the hook path remains open and this contract does not stand in its way.

---

## 5. Two keys, and why one would be pointless

- **vault key** — owns the funds. Stays locked. Unlocks once, at the local console, to open a session.
- **session key** — bounded by the encrypted budget and the recipient allowlist. Stays warm and sends its own transactions.

If the vault key were the only key, the encrypted budget would be decoration: an owner can always bypass the module and call `confidentialTransfer` directly. **The split is what makes the budget real.**

Both are generated locally from raw entropy — no mnemonic is derived, held, or written, so there is nothing for a user to write down and nothing for anyone to find. Both stay on the machine, encrypted at rest with a passphrase in the OS keychain.

A session key is designed to be leakable. A leak costs at most the remaining encrypted budget, to addresses already on the allowlist, until expiry. That is a bounded loss by construction, and it is the whole point of the two-tier split.

### One authorisation

Opening a session takes three owner-side transactions: `setOperator` per token, `openSession`, and — only on the balance-visible tier — `delegateForUserDecryption`. The user authorises **once**: the vault unlocks, signs all three, and locks again.

The console counter therefore reads `Vault unlocks this session`, not "signatures". Three signatures, one authorisation, and the counter names the one the user experiences. `OpenSessionResult.ownerAuthorisations` reports what actually happened rather than what was hoped for.

For SDK consumers who _do_ have a browser wallet, the same three calls batch into one approval via EIP-5792 `wallet_sendCalls`, with a sequential fallback. The product does not use that path — there is no browser wallet in it — and that path is **not verified against a live wallet**.

---

## 6. Session lifecycle

```
openSession(sessionKey, expiry, maxTxCount, tokens[], budgets[], recipients[], proof, signature)
  → one storage slot of plaintext parameters
  → euint64 budget per token, from ONE encrypted input under ONE proof
  → recipients as a one-based index map, so removal is swap-and-pop
```

**Session keys are single-use for all time.** `owner` is never cleared, so a closed key cannot be reopened. That is not tidiness: ACL delegations live in the ACL, not in this contract, so a reopened key would silently carry a stale grant into a new session.

**The key must consent by signature.** The session key travels in mempool calldata, so without proof of consent anyone could resubmit a pending open with the same key, take ownership, and make the honest call revert — permanently burning that key for the cost of gas. An EIP-712 signature from the session key, bound to one owner, closes it. `chainId` and `verifyingContract` live in the domain separator, which is what makes a signature useless on another chain or deployment.

**Closing sweeps the gas back.** Since a session key can never be reused, whatever gas is left on it after a close is stranded forever. `close()` returns it to the owner, signed by the session key, best-effort — the close is awaited first and stands whatever the sweep does.

---

## 7. What the model sees

The MCP layer keeps two principals distinct, and the word "agent" appears nowhere in this codebase on its own because it conflates them:

- **session client** — the process. Holds the keys, builds ciphertexts, knows plaintext amounts because it chose them.
- **model** — sees only what the user typed and opaque references.

By default the model never sees an amount. `balance` and `remaining` return an opaque reference. `reveal: true` requires a click on the local console, every call, and there is no setting that disables it. `can_afford` answers the common question with a boolean instead.

**Sealed mode** puts the amount input on the console: the user types it, the session client encrypts it, and the model receives `{status, ok_ref, sent_ref}` — no number, and none afterwards either.

**No `unwrap` tool.** Going back to ERC-20 requires public decryption of the amount, which is a disclosure decision a session must not make for the user.

---

## 8. Latency, and why the first reply is instant

One confidential transfer is about 29 seconds end to end on Sepolia. The breakdown is what matters:

| phase                      | median | note                                                               |
| -------------------------- | ------ | ------------------------------------------------------------------ |
| encrypt + prove + register | 12.5s  | client-side, near-zero variance, **before any transaction exists** |
| submit → mined             | 8.8s   | Sepolia block time, irreducible                                    |
| coprocessor settlement     | ~2.5s  | polls succeeded on attempt 1 in every run; effectively free        |
| decrypt                    | ~2.5s  |                                                                    |

Proof generation is the slow half and it does not depend on the chain, so the SDK exposes `prepare()` to start it the moment intent is legible and `send()` to submit later. Measured through the SDK's own API in the Sepolia suite: `proof 12.1s, submit+settle 32.5s`.

Measurements in [`../findings.md`](../findings.md) §3.

---

## 9. Package layout

```
contracts/          GhostKeySession.sol, its interface, a mock ERC-7984 for tests
packages/sdk        headless client — no MCP, no model, no chat context
packages/console    the localhost page, run inside the MCP process
packages/mcp-server the tool surface, the vault, and the CLI
spikes/             live-chain measurements; every figure in the docs comes from here
```

The SDK importing nothing from the MCP server is deliberate and enforced by review: it is what makes GhostKey infrastructure rather than a demo, and it is what would make an upstream proposal to OpenZeppelin or Zama credible.

---

## 10. Versions everything was verified against

|                                        |                                                   |
| -------------------------------------- | ------------------------------------------------- |
| `@fhevm/solidity`                      | 0.11.1                                            |
| `@fhevm/host-contracts`                | 0.10.0                                            |
| `@openzeppelin/confidential-contracts` | 0.5.3                                             |
| `@zama-fhe/relayer-sdk`                | 0.4.1                                             |
| Hardhat                                | 2.28.x (the FHEVM plugin peer-requires ^2, not 3) |
| solc                                   | 0.8.27, optimizer 800, viaIR, cancun              |

Sepolia system contracts, cross-verified between the Solidity config and the JS SDK, are listed in [`../findings.md`](../findings.md) §4.
