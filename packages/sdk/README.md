# @savetogether/sdk

Headless client for SaveTogether encrypted spending sessions on ERC-7984 confidential tokens.

No MCP server, no language model, no chat context. This package is usable on its own, and nothing in it imports from `@savetogether/mcp-server`.

## The problem

`ERC7984.setOperator(spender, until)` grants an operator unlimited spending authority, bounded only by time. OpenZeppelin's own documentation warns that setting an operator lets that address take all of your tokens.

SaveTogether adds the missing piece: an **encrypted spending budget**. Every transfer is clamped against it homomorphically — no revert, no plaintext comparison, no branch on an encrypted value. An observer cannot tell an accepted transfer from a rejected one; on live Sepolia, across 180 transactions, the FHE operation sequence and the HCU consumption are identical on every path (see `docs/step3-gate.md`).

## Terminology

Two principals, kept distinct everywhere in this codebase:

- **session client** — this process. Holds the keys, builds ciphertexts, submits transactions. It necessarily knows plaintext amounts, because it chose them.
- **model** — the language model driving it, in setups that have one. Sees only what the user typed and opaque references.

The word "agent" is never used alone, because it conflates the two and the privacy claim depends on the distinction.

## Install

```bash
pnpm add @savetogether/sdk ethers
```

## Two privacy tiers, not a flag

Delegation to the FHEVM ACL is required for exactly one capability: reading the holder's **balance**, which is only needed for reference amounts like "send half". Everything else — what was spent, what remains, what actually moved — is readable without it, because those are the module's own handles.

So the tiers are two **types**, and a reference amount simply does not compile on a session that cannot read the balance.

### Spend-only

The session client sees what it spent and what remains. It never sees what is in the wallet.

```ts
import { SaveTogetherClient, exact, osKeychainKeystore, revealAmount } from "@savetogether/sdk";
import { JsonRpcProvider, Wallet } from "ethers";

const provider = new JsonRpcProvider(RPC_URL);
const client = new SaveTogetherClient({
  provider,
  rpcUrl: RPC_URL,
  moduleAddress: GHOSTKEY_MODULE,
  keystore: osKeychainKeystore(),
});

const { session, ownerAuthorisations } = await client.openSession({
  owner: new Wallet(VAULT_KEY, provider),
  budgets: [{ token: cUSDC, amount: 500_000_000n }],
  recipients: [alice, bob],
  expiry: new Date(Date.now() + 7 * 86_400_000),
  readScope: "spend-only",
});

console.log(ownerAuthorisations); // 1

const result = await session.send({ token: cUSDC, to: alice, amount: exact(25_000_000n) });
switch (result.outcome) {
  case "sent":
    console.log("moved", result.amount);
    break;
  case "over-budget":
    console.log("that would exceed the session budget");
    break;
  case "insufficient-balance":
    console.log("the wallet does not hold that much");
    break;
}

// session.balance is not on this type. It does not compile.
```

### Balance-visible

Adds an ACL delegation, and with it the ability to read the holder's balance and use reference amounts.

```ts
const { session } = await client.openSession({ /* ... */ readScope: "balance-visible" });

if (session.tier === "balance-visible") {
  const balance = await session.balance(cUSDC);
  await session.send({ token: cUSDC, to: alice, amount: ref(balance).half().cap(100_000_000n) });
}
```

The session key signs the delegated decryption with its **own** key; the owner signs nothing for it. Verified live on Sepolia in step 1.

## Amounts are opaque by construction

An `AmountRef` carries no numeric field, refuses to stringify to anything numeric, and hands its plaintext only to `revealAmount` — which is named for what it does and takes a reason, so a leak is always a deliberate, greppable call.

```ts
const budget = await session.remaining(cUSDC);

`${budget}`; // "AmountRef(budget:0x8ea53303…)"
JSON.stringify({ budget }); // no number anywhere

await revealAmount(budget, { reason: "user asked how much is left" }); // 475000000n
```

Arithmetic stays in reference space and is resolved only at encrypt time:

```ts
ref(balance).half();
ref(balance).percent(2500);
ref(budget).minus(1_000n).cap(50_000n);
```

## Proof warming

Step 1 measured a 29s median end to end for one confidential transfer, of which **12.5s is client-side ZK proof generation** with near-zero variance — and it happens before any transaction exists. Start it the moment the intent is legible:

```ts
const prepared = session.prepare({ token: cUSDC, to: alice, amount: exact(25n) });
// ... user is still typing, or confirming ...
const result = await prepared.send(); // the proof is already done
```

`prepared.ready` settles when the proof exists. `prepared.abort()` throws it away.

## What the SDK enforces that the contract does not

The contract deliberately leaves three things to the client, and this package does them so the user gets a named cause rather than an opaque revert:

- **A zero amount is refused before encryption.** The contract reports it identically to an insufficient balance and spends no FHE operation trying to distinguish them. `ZeroAmountError`.
- **`token.isOperator(owner, module)` is checked before sending.** Operator grants lapse independently of the session, so a live session can still be unable to move anything. `OperatorNotGrantedError`.
- **`protocolStatus` is surfaced.** `send` never reverts on a budget or balance failure, but it can still revert because the FHEVM ACL is paused or a participant is deny-listed. `ProtocolUnavailableError`.

`session.readiness()` returns all of it at once, with reasons.

## Key custody

The session key is generated locally from raw entropy — no mnemonic is ever derived or written — encrypted at rest in Web3 Secret Storage v3, with the passphrase held in the OS keychain (macOS Keychain, Windows DPAPI, libsecret). Never an environment variable, never a config file, never a log line.

The key is _designed_ to be leakable: a leak costs at most the remaining encrypted budget, to addresses already on the allowlist, until the session expires. That is a bounded-loss argument, not licence to be careless.

The owner's vault key is never handled by this package. `openSession` takes a `Signer` and gives it back.

## One authorisation

Opening a session needs three owner-side actions: `setOperator` per token, `openSession`, and — only for the balance-visible tier — `delegateForUserDecryption` per token, batched through `IACL.multicall` when several tokens are in scope.

`ownerAuthorisations` in the result reports what actually happened rather than what was hoped for:

- with a browser wallet that supports EIP-5792, they are batched into one approval (`batched: true`)
- with a local key — which is how the SaveTogether product runs — the vault unlocks once and signs them in sequence without asking again (`batched: false`, still one authorisation)

## Not here, deliberately

- **No unwrap.** ERC-7984 → ERC-20 requires public decryption of the amount, which is a disclosure decision a session client must not make alone. It is outside session authority entirely.
- **No cross-token budget.** That needs a price oracle over encrypted amounts.
- **No gas sponsorship.** The session key sends its own transactions; the EOA nonce is the replay protection.
