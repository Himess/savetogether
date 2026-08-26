# GhostKey — `packages/sdk` public API surface

Type signatures only. No implementation. For confirmation before building.

The contract is frozen at commit `882a2c7`; nothing below asks to reopen it.

---

## 0. Library choice: viem

**Recommendation: viem.** Three reasons that matter for this package specifically.

1. Step 3 requires the SDK to _take a signer interface, not own it_ (vault key handling is step 4). viem's `Account` is exactly that abstraction, already split into `LocalAccount`, `JsonRpcAccount` and custom accounts, so the boundary is the library's rather than one we invent.
2. Batching the three owner-side actions is an EIP-5792 `wallet_sendCalls` problem. viem ships first-class `sendCalls` / `getCapabilities` with the capability probe and the sequential fallback already modelled.
3. This is a package other people import. viem's tree-shaking and type inference matter far more in a consumed library than in a test harness.

**The risk, stated:** everything verified so far — the spikes, the contract tests, the Sepolia gate — runs on ethers via Hardhat, and the relayer SDK's own examples are ethers-flavoured. The coupling is thin (`createInstance` takes an RPC URL string; `userDecrypt` takes a signature string, and viem's `signTypedData` produces the same bytes), but it is unproven for this project. Mitigation: the spikes and contract tests stay on ethers, and the first SDK integration test against Sepolia is the thing that proves the viem path end to end. If it fights us, falling back to ethers costs a day, not a rewrite.

---

## 1. Two privacy tiers, enforced by the type system

Delegation is required for exactly one capability: reading the holder's balance, which is only needed for reference amounts. Rather than a boolean flag, the two tiers are two session types with different methods — so "send half" simply does not compile on a session that cannot read the balance.

```ts
/** Common to both tiers. */
interface SessionBase {
  readonly sessionKey: Address;
  readonly owner: Address;
  readonly module: Address;
  readonly tokens: readonly Address[];

  params(): Promise<SessionParams>;
  recipients(): Promise<readonly Address[]>;
  remaining(token: Address): Promise<AmountRef>;

  prepare(intent: SendIntent): PreparedSend;
  send(intent: SendIntent): Promise<SendResult>;

  addRecipient(to: Address): Promise<Hash>; // owner signer required
  removeRecipient(to: Address): Promise<Hash>; // owner OR session key
  increaseBudget(token: Address, amount: bigint): Promise<Hash>; // owner
  close(): Promise<Hash>; // owner OR session key

  readiness(): Promise<Readiness>;
}

/** No ACL delegation. Sees what it spent and what remains; never the wallet. */
interface SpendOnlySession extends SessionBase {
  readonly tier: "spend-only";
}

/** ACL delegation granted. Adds balance reads, and with them reference amounts. */
interface BalanceVisibleSession extends SessionBase {
  readonly tier: "balance-visible";
  balance(token: Address): Promise<AmountRef>;
  revokeBalanceAccess(): Promise<Hash>; // downgrades to spend-only on chain
}

type Session = SpendOnlySession | BalanceVisibleSession;
```

Neither tier is degraded. `SpendOnlySession` is a complete, useful session; it simply cannot answer "how much is in the wallet", which is a privacy property rather than a missing feature.

---

## 2. Amounts: plaintext requires an explicit, named call

`AmountRef` is an opaque reference to an encrypted quantity. It never carries plaintext, it never stringifies to plaintext, and no default path returns a `bigint`.

```ts
/** Opaque. Its plaintext is reachable only through `reveal`. */
declare const AmountRefBrand: unique symbol;
interface AmountRef {
  readonly [AmountRefBrand]: true;
  readonly handle: Hex;
  readonly token: Address;
  readonly source: "budget" | "balance" | "sent";
}

/** Arithmetic stays in ref space. Resolution happens at encrypt time. */
interface AmountExpr {
  half(): AmountExpr;
  percent(bps: number): AmountExpr;
  minus(other: bigint): AmountExpr;
  cap(max: bigint): AmountExpr;
}

function ref(r: AmountRef): AmountExpr;
function exact(value: bigint): AmountExpr;

/**
 * The ONLY path from a ref to a number. Named for what it does, so a leak is
 * always a deliberate call at a reviewable site — never a default, never a
 * property access, never a toString.
 */
function revealAmount(ref: AmountRef, opts?: { reason?: string }): Promise<bigint>;
```

A `SendIntent` therefore takes an expression, not a number:

```ts
interface SendIntent {
  readonly token: Address;
  readonly to: Address;
  readonly amount: AmountExpr;
}
```

`ref(...).half()` on a `SpendOnlySession` is a type error, because that session has no `balance()` to produce the ref.

---

## 3. Results mapped to the contract's truth table

```ts
type SendResult =
  | { outcome: "sent"; amount: bigint; hash: Hash; sent: AmountRef; within: true }
  | { outcome: "over-budget"; hash: Hash; sent: AmountRef; within: false }
  | { outcome: "insufficient-balance"; hash: Hash; sent: AmountRef; within: true };
```

Decoded by decrypting both event fields — `within` is an `ebool` and takes a different decrypt path from the `euint64` handles, so the two are fetched together and mapped once:

| `within` | `sent` | outcome                |
| -------- | ------ | ---------------------- |
| false    | 0      | `over-budget`          |
| true     | 0      | `insufficient-balance` |
| true     | n      | `sent`                 |

The `amount` on a successful result is already plaintext because the session client chose it — it is not a reveal of anything the client did not know.

---

## 4. Proof warming, designed in rather than retrofitted

Step 1 measured a 29s median end to end, of which 12.5s is client-side proof generation with near-zero variance, occurring before any transaction exists. The API lets a caller start that work the moment intent is legible.

```ts
interface PreparedSend {
  /** Resolves when the ZK proof is generated and registered. */
  readonly ready: Promise<void>;
  /** Submits. Awaits `ready` internally if it has not settled. */
  send(): Promise<SendResult>;
  /** Discards the prepared input; the caller changed their mind. */
  abort(): void;
}
```

Typical use: call `prepare` as soon as the token, recipient and rough amount are known; call `send()` when the user confirms. Perceived latency collapses toward block time.

---

## 5. Opening a session: three owner actions, one signature where possible

```ts
interface OpenSessionRequest {
  readonly owner: Account;
  readonly budgets: ReadonlyArray<{ token: Address; amount: bigint }>;
  readonly recipients: readonly Address[];
  readonly expiry: Date;
  readonly maxTxCount?: number;
  /** Choosing this is choosing the privacy tier. */
  readonly readScope: "spend-only" | "balance-visible";
}

interface OpenSessionResult {
  readonly session: Session;
  readonly calls: readonly Hash[];
  readonly batched: boolean; // false when EIP-5792 was unavailable
}

function openSession(client: GhostKeyClient, req: OpenSessionRequest): Promise<OpenSessionResult>;
```

Internally, three owner-side actions:

1. `token.setOperator(module, expiry)` — once per token
2. `module.openSession(params, inputProof, sessionKeySignature)` — one call, all tokens, one `createEncryptedInput` and one proof
3. `ACL.delegateForUserDecryption(sessionKey, token, expiry)` — **only when `readScope` is `balance-visible`**; singular form, batched through `IACL.multicall(bytes[])` when several tokens are in scope, since the array form does not exist on the ACL

Submitted as one `wallet_sendCalls` batch when the wallet advertises the capability, sequentially otherwise, with `batched` reporting which happened. The session key is generated locally and signs the open via `module.openSessionDigest(...)` — the contract view, not a locally reconstructed EIP-712 payload. Test B1f exists to catch drift between the two, but only if the SDK actually calls the view.

---

## 6. Readiness: the failures the contract deliberately does not prevent

`send` never reverts on a budget or balance failure. It can still fail for reasons outside the module, and the SDK should name them rather than surfacing an opaque revert.

```ts
interface Readiness {
  readonly ok: boolean;
  readonly sessionLive: boolean; // expiry, closed, txCount
  readonly operatorGranted: boolean; // token.isOperator(owner, module) — lapses independently
  readonly aclPaused: boolean; // from module.protocolStatus
  readonly keyDenied: boolean;
  readonly moduleDenied: boolean;
  readonly reasons: readonly string[];
}
```

`operatorGranted` is read directly from the token via `isOperator(owner, module)`. Per the step-3 decision, the contract is not reopened to bundle this — three reads are cheap, and a frozen tested contract is worth more than one saved round trip.

Client obligations enforced here rather than on chain:

- **A zero amount is rejected before encrypting.** The contract cannot distinguish it from an insufficient balance and deliberately spends no FHE op trying. `send` throws `ZeroAmountError` before touching the network.
- **`operatorGranted` is checked before sending**, so a lapsed operator grant reports as itself instead of reverting inside the token.

---

## 7. Client construction and key custody

```ts
interface GhostKeyClientConfig {
  readonly chain: Chain;
  readonly transport: Transport;
  readonly module: Address;
  readonly relayerUrl?: string; // defaults to the SDK's Sepolia config
  readonly keystore: SessionKeystore;
}

function createGhostKeyClient(config: GhostKeyClientConfig): GhostKeyClient;
```

The session key never leaves the process in plaintext:

```ts
interface SessionKeystore {
  /** Generates, encrypts (EIP-2335) and persists. Returns the address only. */
  create(label: string): Promise<Address>;
  /** Loads and decrypts into an in-memory account. */
  load(address: Address): Promise<LocalAccount>;
  list(): Promise<readonly StoredSessionKey[]>;
  destroy(address: Address): Promise<void>;
}

/** Default: EIP-2335 JSON on disk, passphrase in the OS keychain. */
function osKeychainKeystore(opts?: { dir?: string; service?: string }): SessionKeystore;
```

Never a plaintext env var, never a config file, never logged. The key is _designed_ to be leakable — a leak costs at most the remaining budget, within the allowlist, until expiry — but that is a bounded-loss argument, not licence to be careless.

The owner's key is never handled: `openSession` takes an `Account`, and step 4 supplies it.

---

## 8. Terminology in the exported surface

`session client` and `model` per A3. The word "agent" appears in no exported type, no parameter, no doc comment. Nothing in this package imports from `packages/mcp-server`, and nothing assumes a chat context — that separation is what makes GhostKey infrastructure rather than a demo, and it is what makes an upstream proposal to OpenZeppelin or Zama credible.

---

## 9. What is deliberately absent

- **No unwrap.** ERC-7984 → ERC-20 requires public decryption of the amount; that is a disclosure decision a session client must not make alone. Not in the contract, not in the SDK.
- **No cross-token budget.** It would need a price oracle over encrypted amounts.
- **No owner-key custody.** Step 4.
- **No gas sponsorship.** The session key sends its own transactions; the EOA nonce is the replay protection.
