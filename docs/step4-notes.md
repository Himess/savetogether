# SaveTogether — Step 4 notes: `packages/mcp-server` and `packages/console`

The chat surface, and the one page that exists because some things must not happen in chat.

The decision log and the adversarial passes live in [`PROGRESS.md`](../PROGRESS.md). This file records what was built, what the brief got wrong, and what is still open.

---

## 1. The two-tier wallet

- **vault key** — owns the funds, stays locked, unlocks once per session open
- **session key** — bounded by the encrypted budget and the allowlist, stays warm

If the vault key were the only key the encrypted budget would be decoration: an owner can always bypass the module and call `confidentialTransfer` directly. The split is what makes the budget real, and it is not collapsible.

Both are generated locally **from raw entropy rather than `Wallet.createRandom()`**, so no mnemonic is ever derived, held, or written. The brief says no seed phrase is shown to the user; this makes there be nothing to show.

At session open the vault unlocks once, signs `setOperator` and `openSession` (and `delegateForUserDecryption` on the balance-visible tier), funds the session key, and locks again. `Vault.lock()` is called immediately afterwards, in the same function, so an exception between them cannot leave a decrypted key resident.

---

## 2. The unlock never touches chat

A passphrase typed into a conversation enters the model's context and the transcript, permanently. So it is never asked for there.

Implemented order: key material at rest under the OS keychain (macOS Keychain, Windows DPAPI via a stdin-fed PowerShell call, libsecret), with the **authorisation** being a click on the localhost console, or a confirmation read from the controlling TTY when no console is running.

Neither can be driven by the model. A tool call cannot click a button, and the terminal fallback reads from the TTY rather than stdin — stdin belongs to the MCP transport. There is no tool that accepts a passphrase, so there is no path from a conversation to an unlock at all.

**Not implemented: a true biometric prompt.** Touch ID and Windows Hello need a native module per platform. The brief's preference order puts biometric first; what exists is the second item, and [`leakage.md`](./leakage.md) §5 says so rather than implying otherwise.

**`--dev-unlock`** skips the human step for recording a demo. It is gated on the chain id **at unlock time**, not at construction, so a provider swapped after startup cannot slip past it. `test/mcp.ts` asserts the refusal on mainnet, including the case where the vault exists and is loadable — so the test would fail if the gate were merely ordered after the key load rather than before it.

---

## 3. The tool surface

Ten tools, matching §5.3. **No `unwrap`**: going back to ERC-20 needs public decryption of the amount, which is a disclosure decision a session must not make for the user. `wrap`'s description explains why, so the model can answer rather than shrug.

### What the model may see

Never a plaintext amount by default. `balance` and `remaining` return an opaque reference id. `reveal: true` opens a confirmation on the local console — **every call**, with no configuration option that disables it. Adding one would remove the only thing standing between "the model can ask" and "the model has it".

`can_afford` exists so the common question — does this fit? — can be answered with a boolean rather than a number.

### Sealed mode

`send(..., "sealed")` opens an input on the console. The user types the amount, this process encrypts it, and the model receives `{status, ok_ref, sent_ref}` — no number, and none afterwards either, because the reference is opaque and revealing it needs another click.

What sealed mode does **not** hide is stated in the tool description and in `leakage.md`: that a transfer happened, the token, the recipient, the time. Recipients are public on chain regardless. Sealed mode hides the amount and nothing else, and does not pretend otherwise.

### Prompt injection

Every chain-sourced string is untrusted input written by whoever deployed the contract. `sanitiseChainText` strips C0/C1 controls, zero-width characters and bidirectional overrides — the last of these matters most, since a right-to-left override can make one address render as a different address — caps the length, and **flags** injection-shaped text rather than silently passing it. Tool descriptions tell the model that anything inside an `<untrusted>` envelope is data and never an instruction.

The sanitiser is the third layer and the cheapest. The first two carry the weight: an injection that succeeds _completely_ still cannot move value to an address the owner did not name, or beyond the budget the owner set.

Token symbols come from local config, not from the chain, so the names the user types are not injectable at all.

---

## 4. The console

One page on 127.0.0.1, ephemeral port, behind a one-time token minted at startup and printed to stderr. Runs inside the MCP process rather than as a second daemon, so there is no IPC to get wrong and nothing to start separately.

The largest element is the unlock counter, and it counts **vault unlocks, not signatures**. With both keys local the vault signs three transactions after one unlock — `setOperator`, `openSession`, and `delegateForUserDecryption` on the balance-visible tier — so a counter labelled "signatures" would have been false. It reads `ownerAuthorisations` from the SDK rather than a hardcoded 1. `add_recipient` and `wrap` increment it, because they genuinely need the vault.

Three failure modes were designed rather than defaulted:

- **An unanswered prompt resolves as denied**, not approved. The failure mode of nobody watching must be that nothing happens.
- **A request without the token gets 403**, so another local process cannot drive the console. Tested.
- **CSP is `default-src 'none'`** with `frame-ancestors 'none'` and no remote origins, so the page cannot be framed and loads nothing it did not ship with.

---

## 5. What turned out wrong in the brief

Detail in [`PROGRESS.md`](../PROGRESS.md).

- **G2 — `wrap` needs the vault.** §5.3 lists it beside the session-key tools, but `ERC7984ERC20Wrapper.wrap(address,uint256)` takes a plaintext amount and moves a public balance the owner holds. It is `approve` plus `wrap`, signed by the vault, and it increments the unlock counter.
- **G3 — the transfer cap is not a tool argument.** §5.3's `open_session` has five parameters and no `maxTxCount`. Left as specified; `session_status` reports the cap, and `leakage.md` §3 explains why setting one is worth doing — it bounds an observer's sample count. Belongs on the console.
- **G4 — biometric unlock is not implemented.** §2 above.
- **D5 — the low-level MCP `Server`, not `McpServer.registerTool`.** `registerTool` infers each handler's argument type from a zod shape, and that mapped type exhausts TypeScript's instantiation budget on any schema containing an **array**, and the compiler's heap on a nested `z.object`. Six workarounds failed. The schemas are now hand-written JSON Schema validated with zod explicitly — more code, and the exact JSON the model sees lives in one place next to the prose explaining it. A test asserts the schema and the validator agree, which is the hazard that swap introduces.
- **D6 — `revoke_all` does not clear the operator grant**, and says so instead of letting the word "revoke" over-promise.

---

## 6. Open for step 5

1. **End-to-end against a live chat client.** Needs a human at the console by construction — that is the design, not a gap, but it means no automated test covers the full loop.
2. **G3 — a `maxTxCount` control on the console.**
3. **G6 — reclaiming a closed session key's leftover gas.** Every session costs the vault 0.02 ETH and nothing gives it back.
4. **`npx savetogether init` is untested end to end.** It writes the Claude config by merging rather than overwriting — deliberately, since that file usually has other servers in it — but nothing asserts the merge.
5. **The starter token list is a single Sepolia mock.** `docs/leakage.md` and `findings.md` §6 both record that no curated wrapper registry exists on Sepolia; the config format is ours and adapts if one appears.
