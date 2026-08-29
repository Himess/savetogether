# GhostKey — Step 1 findings

Recon, scaffold, and assumption verification. Every claim below is read from installed source at a stated path, or measured on live Sepolia with the output included. Nothing here is answered from training data.

- Date: 2026-08-26
- Network: Ethereum Sepolia (11155111)
- Holder / delegator: `0xF505e2E71df58D7244189072008f25f6b6aaE5ae`
- Session key / delegate: `0x9806E422444989E2F9EFB28f6491F682069c626f` (generated in step 1)
- RPC: Alchemy

---

## 1. Verdict table

| #   | Assumption                                                               | Verdict                                                    |
| --- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| A1  | `FHESafeMath.tryDecrease` exists, returns `(ebool, euint64)`             | **VERIFIED**                                               |
| A2  | `confidentialTransferFrom` returns the amount ACTUALLY moved             | **VERIFIED** — caveat: all-or-nothing, not partial         |
| A3  | Operator can pass a self-computed `euint64`, no `inputProof`             | **VERIFIED** — the guard is on `msg.sender`, not the token |
| A4  | An operator cannot user-decrypt the holder's balance                     | **VERIFIED** from ACL grants, and demonstrated live        |
| A5  | `IACL.delegateForUserDecryption(delegate, contractAddresses[], expiry)`  | **PARTIAL — the array form does not exist**                |
| A6  | A delegate can `userDecrypt` a delegator's handle with its OWN signature | **VERIFIED ON LIVE SEPOLIA**                               |
| A7  | `to` is a plaintext address; the transfer graph is public                | **VERIFIED**                                               |
| A8  | HCU limits and per-op euint64 costs                                      | **VERIFIED** from `HCULimit.sol`                           |
| A9  | EIP-5792 `wallet_sendCalls` support                                      | **PARTIAL** (timeboxed)                                    |
| —   | An official Sepolia confidential-wrapper _registry_ exists               | **NOT FOUND — see §6**                                     |

---

## 2. Evidence

### A1 — `FHESafeMath.tryDecrease` — VERIFIED

`@openzeppelin/confidential-contracts@0.5.3`, `utils/FHESafeMath.sol:34-43`:

```solidity
function tryDecrease(
  euint64 oldValue,
  euint64 delta
) internal returns (ebool success, euint64 updated) {
  if (!FHE.isInitialized(oldValue)) {
    if (!FHE.isInitialized(delta)) {
      return (FHE.asEbool(true), oldValue);
    }
    return (FHE.eq(delta, 0), FHE.asEuint64(0));
  }
  success = FHE.ge(oldValue, delta);
  updated = FHE.select(success, FHE.sub(oldValue, delta), oldValue);
}
```

Signature matches the assumption. Parameter names are `(oldValue, delta)`, not `(a, b)`.

Behaviour when `delta > oldValue`: `success = ge(oldValue, delta)` is false, so `updated = select(false, ..., oldValue)` returns **oldValue unchanged**. No revert, no underflow, no branch observable from outside. This is exactly the primitive GhostKey's budget needs.

Uninitialized inputs: both uninitialized returns `(true, oldValue)`; `oldValue` uninitialized with `delta` initialized returns `(eq(delta,0), asEuint64(0))` — success only when the delta is zero.

### A2 — `confidentialTransferFrom` returns the moved amount — VERIFIED, with a caveat

`token/ERC7984/ERC7984.sol:290-323`:

```solidity
function _update(address from, address to, euint64 amount) internal virtual returns (euint64 transferred) {
    ...
    (success, ptr) = FHESafeMath.tryDecrease(fromBalance, amount);
    ...
    transferred = FHE.select(success, amount, FHE.asEuint64(0));    // :306
```

`success` is `ge(fromBalance, amount)`, so an insufficient balance yields `transferred = 0`. The return value is load-bearing exactly as assumed.

**Caveat that changes step-2 design.** This is _all-or-nothing_, not best-effort: on an insufficient balance it moves `0`, it does not move as much as it can. GhostKey's budget accounting must therefore treat a transfer as binary, and must not assume it can debit a partial amount.

### A3 — Operator can pass a self-computed `euint64` — VERIFIED, with a correction

`ERC7984.sol:140-146`:

```solidity
function confidentialTransferFrom(
  address from,
  address to,
  euint64 amount
) public virtual returns (euint64) {
  require(
    FHE.isAllowed(amount, msg.sender),
    ERC7984UnauthorizedUseOfEncryptedAmount(amount, msg.sender)
  );
  require(isOperator(from, msg.sender), ERC7984UnauthorizedSpender(from, msg.sender));
  euint64 transferred = _transfer(from, to, amount);
  FHE.allowTransient(transferred, msg.sender);
  return transferred;
}
```

The proof-free overload exists. Two corrections to the assumption:

1. The `require` checks `FHE.isAllowed(amount, msg.sender)` — the calling module, not the token. The module satisfies this automatically for a handle it computed. `FHE.allowTransient(amount, address(token))` is still required, but for a different reason: so the _token_ can compute on the handle inside `_update`. Both grants are needed; they are not the same grant.
2. **The returned handle is `allowTransient`, not `allow` (line 144).** The module's access to `transferred` dies at the end of the transaction. Any budget decrement that consumes the return value **must happen in the same transaction**. This is a hard constraint on the step-2 contract shape.

### A4 — An operator cannot read the holder's balance — VERIFIED

Argued from ACL grants rather than the docs sentence.

`setOperator` (`ERC7984.sol:107-109`) calls only `_setOperator`. It grants no FHE/ACL rights of any kind.

Every ACL grant touching a balance handle in `_update`:

```
:296  FHE.allowThis(ptr)      totalSupply       -> token
:301  FHE.allowThis(ptr)      sender balance    -> token
:302  FHE.allow(ptr, from)    sender balance    -> holder
:310  FHE.allowThis(ptr)      totalSupply       -> token
:314  FHE.allowThis(ptr)      recipient balance -> token
:315  FHE.allow(ptr, to)      recipient balance -> recipient
```

No grant to `msg.sender` on any balance handle. `confidentialBalanceOf` returns the handle to anyone, but a handle without an ACL grant cannot be decrypted — demonstrated live by the negative control in §3, where the relayer returned 400 for a delegate holding no delegation.

Move authority and read authority are therefore genuinely separable. The architecture's core premise holds.

### A5 — ACL delegation API — PARTIAL, the assumed signature does not exist

The assumption was `delegateForUserDecryption(delegate, contractAddresses[], expiry)`. That array form is **not an ACL function**. Verified two ways.

Source, `@fhevm/solidity@0.11.1`, `lib/Impl.sol:356` (IACL interface):

```solidity
function delegateForUserDecryption(
  address delegate,
  address contractAddress,
  uint64 expirationDate
) external;
function revokeDelegationForUserDecryption(address delegate, address contractAddress) external;
function getUserDecryptionDelegationExpirationDate(
  address delegator,
  address delegate,
  address contractAddress
) external view returns (uint64);
```

Deployed bytecode. ACL proxy `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D`, EIP-1967 implementation `0xf4f793e6a2ef47de60a94c0bc412292da5f7ab98`, 10,137 bytes runtime. Selector presence in the dispatch table:

| Function                                                             | Selector     | Deployed   |
| -------------------------------------------------------------------- | ------------ | ---------- |
| `delegateForUserDecryption(address,address,uint64)`                  | `0x04f61a95` | PRESENT    |
| `revokeDelegationForUserDecryption(address,address)`                 | `0x669e6316` | PRESENT    |
| `getUserDecryptionDelegationExpirationDate(address,address,address)` | `0x3f462dbe` | PRESENT    |
| `delegateForUserDecryptions(address,address[],uint64)`               | `0xe01473c1` | **ABSENT** |
| `revokeDelegationsForUserDecryption(address,address[])`              | `0x42597dae` | **ABSENT** |
| `multicall(bytes[])`                                                 | `0xac9650d8` | PRESENT    |
| `paused()`                                                           | `0x5c975abb` | PRESENT    |
| `isAccountDenied(address)`                                           | `0x9edc01ec` | PRESENT    |

Batching is still one transaction, but through `multicall`, not a batch entrypoint. `Impl.sol:817-845` builds the calldata array and calls `IACL.multicall(calls)`; for a single address it skips straight to the singular call.

Naming trap worth recording: the library wrapper is `FHE.revokeUserDecryptionDelegation` (`FHE.sol:9452`) but the ACL function it calls is `revokeDelegationForUserDecryption`. The names are transposed.

**Three constraints from the natspec at `FHE.sol:9440-9451` that affect design:**

1. **At most one delegate OR revoke per block** for a given `(delegator, delegate, contractAddress)` tuple. Reverts with `IACL-AlreadyDelegatedOrRevokedInSameBlock`. A session cannot be opened and closed in the same block, and a session-rotation flow must not try to revoke and re-delegate the same tuple atomically.
2. **The ACL is pausable.** `paused()` is present in the deployed bytecode; delegation reverts with `PausableUpgradeable-EnforcedPause` while paused.
3. **Revoke requires an active delegation**, else `IACL-NotDelegatedYet`.

Also note `isAccountDenied(address)` exists — there is a deny list, and a denied session key is a state GhostKey should surface rather than fail opaquely.

Expiry is `uint64` UNIX seconds. `FHE.sol:9408` provides an overload defaulting to `type(uint64).max` for a non-expiring delegation.

### A6 — Delegated user decryption — VERIFIED ON LIVE SEPOLIA

This was flagged as the single most important assumption, so it was proven with a script against the live chain, with a negative control, not by reading docs.

`spikes/delegation.ts`, output verbatim:

```
delegator (holder)   0xF505e2E71df58D7244189072008f25f6b6aaE5ae
delegate  (session)  0x9806E422444989E2F9EFB28f6491F682069c626f
context   (token)    0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639
ACL                  0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D

  PASS  handle exists                 0x8ea53303ffc9179db51b96a8d7b480c2fa64e25183ff0000000000aa36a70500
  PASS  no delegation before test     expiry=0
  PASS  REFUSED without delegation    status 400 @ https://relayer.testnet.zama.org/v2/delegated-user-decrypt
  PASS  delegateForUserDecryption     block 11571970  gas 55635
  PASS  ACL records the delegation    expiry=1788365706 (expected 1788365706)
  PASS  DELEGATE DECRYPTED            value=61116149001
  PASS  holder's own userDecrypt      value=61116149001
  PASS  values agree                  delegate=61116149001 holder=61116149001

A6: VERIFIED
```

The negative control matters: before the delegation the same delegate, with the same handle and its own signature, was refused by the relayer. So the positive result is the delegation working, not pre-existing access.

Delegation costs **55,635 gas**. Cheap enough that per-token delegation at session open is not a design concern.

SDK surface used (`@zama-fhe/relayer-sdk@0.4.1`, `lib/node.d.ts:718,721`):

```ts
createDelegatedUserDecryptEIP712(publicKey, contractAddresses[], delegatorAddress, startTimestamp, durationDays)
delegatedUserDecrypt(handleContractPairs, privateKey, publicKey, signature, contractAddresses[], delegatorAddress, delegateAddress, startTimestamp, durationDays, options?)
```

The delegate signs the EIP-712 payload with its own key; `delegatorAddress` is passed as data, not signed over by the delegator. Confirmed by the fact that the delegator signed nothing in the passing run.

### A7 — Transfer graph is public — VERIFIED

Every transfer variant in `ERC7984.sol` takes `address to` as a plaintext parameter (lines 112, 127, 140, 149, 169), and `_update` emits `ConfidentialTransfer(from, to, transferred)` at line 322 with both endpoints in the clear. Only the amount is encrypted. Counterparty privacy is out of scope for ERC-7984 and GhostKey should not imply otherwise in its copy.

### A8 — HCU limits and costs — VERIFIED

`@fhevm/host-contracts@0.10.0`, `contracts/HCULimit.sol`:

```
:50   MAX_HOMOMORPHIC_COMPUTE_UNITS_DEPTH_PER_TX =  5,000,000
:54   MAX_HOMOMORPHIC_COMPUTE_UNITS_PER_TX       = 20,000,000
```

Per-op cost, `euint64`, read from the `checkHCUFor*` branches:

| Operation               | scalar operand | both ciphertext |
| ----------------------- | -------------- | --------------- |
| `add`                   | 133,000        | 162,000         |
| `sub`                   | 133,000        | 162,000         |
| `le`                    | 119,000        | 149,000         |
| `ge`                    | 116,000        | 152,000         |
| `select` (`IfThenElse`) | —              | 55,000          |

**Estimated budget for one clamped GhostKey transfer** (all ciphertext-ciphertext):

| Where                                             | Ops                     | HCU           |
| ------------------------------------------------- | ----------------------- | ------------- |
| Module: `tryDecrease(remaining, requested)`       | `ge` + `sub` + `select` | 369,000       |
| Token: `tryDecrease(balance, amount)`             | `ge` + `sub` + `select` | 369,000       |
| Token: `transferred = select(success, amount, 0)` | `select`                | 55,000        |
| Token: `add(balance[to], transferred)`            | `add`                   | 162,000       |
| **Total**                                         |                         | **≈ 955,000** |

That is 4.8% of the per-tx ceiling, and the dependent chain is roughly six ops deep, far under the 5,000,000 depth limit. **HCU is not a binding constraint** for a single session transfer, and there is room for roughly 20 of them in one transaction if batching ever becomes desirable.

### A9 — EIP-5792 — PARTIAL (timeboxed to 30 minutes)

`wallet_sendCalls`, `wallet_getCallsStatus`, `wallet_showCallsStatus`, and `wallet_getCapabilities` are the four methods. Reported support as of March 2026 includes MetaMask, Coinbase Wallet, Rainbow, and Trust Wallet. I did not verify any of these against a live wallet build — that is the open part.

Fallback path: call `wallet_getCapabilities` first; when batching is absent, fall back to sequential `eth_sendTransaction` calls with per-call confirmation. GhostKey's own value proposition reduces the need for this — the point of a session is that the per-transaction signature disappears — so EIP-5792 matters mainly for the _session-open_ flow (approve + setOperator + delegate), which is three calls the user would otherwise sign one by one.

---

## 3. Latency measurements

`spikes/latency.ts`, 5 runs, live Sepolia, Alchemy RPC, real cUSDC transfers.

| phase                      | min    | median     | max    | n   |
| -------------------------- | ------ | ---------- | ------ | --- |
| encrypt + proof + register | 12.21s | **12.46s** | 12.55s | 5   |
| submit to mined            | 3.47s  | 8.83s      | 16.70s | 5   |
| settle + first decrypt     | 4.70s  | 4.97s      | 5.57s  | 5   |
| settlement (derived)       | 2.28s  | 2.52s      | 2.78s  | 5   |
| decrypt (warm)             | 2.41s  | 2.45s      | 2.80s  | 5   |
| **END TO END**             | 23.21s | **29.10s** | 37.37s | 5   |

**How we know when the coprocessor has settled: we don't need to.** There is no settlement event. The method used was to poll `userDecrypt` on the new balance handle until the first success. In all five runs that succeeded on **attempt 1** — the ciphertext was already computed by the time the transaction was mined and one decrypt round trip had completed. The 2.5s "settlement" figure is derived by subtracting a warm decrypt from the first decrypt and is at the level of network noise. Treat coprocessor settlement as free.

**UX implication.** 29s median puts this firmly in optimistic-response territory, not synchronous. But the breakdown says exactly where to attack it, and the answer is favourable:

- 12.5s is client-side proof generation, with near-zero variance (12.21–12.55s), and it happens **before any transaction exists**. It can be started the moment user intent is legible — while they are still typing — and cached.
- 8.8s median is Sepolia block time. Irreducible, and it is the honest floor.
- ~2.5s settlement and ~2.5s decrypt are small and can overlap with rendering.

So the chat interface should acknowledge immediately, warm the proof in the background, and surface the result on mine. Perceived latency lands near block time rather than near 29s. This is a design conclusion the measurement supports; it is not something to guess at.

Caveat: proof generation time is machine-dependent. 12.5s is this machine. Slower client hardware moves the dominant term, and the SDK bundles encryption, proof generation, and relayer registration inside one `encrypt()` call, so they cannot be attributed separately without instrumenting the SDK.

---

## 4. Sepolia addresses and registry usage

FHEVM system contracts. Cross-verified between two independent sources — the Solidity config and the JS SDK — which agree exactly on ACL and KMS.

| Component                   | Address                                      | Source                                       |
| --------------------------- | -------------------------------------------- | -------------------------------------------- |
| ACL                         | `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` | `ZamaConfig.sol:68` **and** SDK — agree      |
| KMSVerifier                 | `0xbE0E383937d564D7FF0BC3b46c51f0bF8d5C311A` | `ZamaConfig.sol:70` **and** SDK — agree      |
| Coprocessor / Executor      | `0x92C920834Ec8941d2C77D188936E1f7A6f49c127` | `ZamaConfig.sol:69` (absent from SDK config) |
| InputVerifier               | `0xBBC1fFCdc7C316aAAd72E807D9b0272BE8F84DA0` | SDK `SepoliaConfig`                          |
| Decryption verifier         | `0x5D8BD78e2ea6bbE41f26dFe9fdaEAa349e077478` | SDK `SepoliaConfig`                          |
| Input-verification verifier | `0x483b9dE06E4E4C7D35CCf5837A1668487406D955` | SDK `SepoliaConfig`                          |
| Gateway chain id            | `10901`                                      | SDK                                          |
| Relayer                     | `https://relayer.testnet.zama.org`           | SDK (v2 endpoints observed live)             |

ACL implementation behind the proxy: `0xf4f793e6a2ef47de60a94c0bc412292da5f7ab98`.

Confidential wrappers currently reachable, read live by `spikes/registry.ts`:

| Label | Wrapper                                      | Symbol/dec      | Underlying                                              |
| ----- | -------------------------------------------- | --------------- | ------------------------------------------------------- |
| cUSDC | `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639` | `cUSDCMock` / 6 | `USDCMock` `0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF` |
| cWETH | `0x46208622DA27d91db4f0393733C8BA082ed83158` | `cWETHMock` / 6 | `WETHMock` `0xff54739b16576FA5402F211D0b938469Ab9A5f3F` |

Faucet path: the underlying `USDCMock` has a public mint, so test balances are self-service. Wrap through the `ERC7984ERC20Wrapper` interface to obtain the confidential balance.

---

## 5. Scaffold state

```
ghostkey/
├─ contracts/CompileCheck.sol           compile placeholder only
├─ packages/{sdk,mcp-server,console}/   package.json + tsconfig + stub
├─ spikes/{_shared,accounts,delegation,latency,registry}.ts
├─ spikes/out/*.json                    machine-readable spike results
├─ test/  docs/
├─ hardhat.config.ts  tsconfig.json  eslint.config.mjs  .solhint.json  .prettierrc
├─ .env.example  (.env gitignored, verified with git check-ignore)
└─ findings.md
```

`pnpm compile` succeeds (7 files, evm target cancun, 40 typings). `pnpm spike:accounts`, `spike:delegation`, `spike:latency`, `spike:registry` all run end-to-end against live Sepolia.

`GhostKeySession.sol` is deliberately not written. It is step 2.

Licensing: the repo is MIT. Note that `@fhevm/solidity` ships under **BSD-3-Clause-Clear** (`ZamaConfig.sol:1`), and `@fhevm/host-contracts` should be checked before any redistribution of Zama sources. Depending on them is fine; vendoring them into an MIT repo is the thing to look at.

---

## 6. Blockers and open questions

Blunt, as requested.

**1. A5's signature is wrong in the architecture doc.** The array form `delegateForUserDecryption(delegate, address[], expiry)` does not exist on the ACL — not in the interface, not in the deployed bytecode. Use the singular form, and use `IACL.multicall(bytes[])` when several token contexts must be delegated in one transaction. This is a small change but it is in the middle of the read-authority flow, so it has to be right before step 2.

**2. The returned `transferred` handle is transient, not persistent.** `ERC7984.sol:144` uses `FHE.allowTransient(transferred, msg.sender)`. The budget decrement must therefore be computed and stored inside the same transaction as the transfer. This forecloses any design that transfers first and reconciles the budget in a later transaction. It is the single most design-relevant discovery in this step after A6.

**3. One delegate-or-revoke per block per tuple.** Session rotation cannot revoke and re-delegate the same `(delegator, delegate, token)` tuple atomically. Either rotate to a fresh session key (different tuple, no conflict), or accept a two-block rotation. I would pick the fresh key — it is also better hygiene.

**4. `SepoliaConfig` does not exist in `@fhevm/solidity@0.11.1`.** The docs and every tutorial say to inherit `SepoliaConfig`; the package exports `ZamaEthereumConfig`, which dispatches on chainid across mainnet, Sepolia, and local. The first compile failed on exactly this. Docs lag code, as predicted.

**5. Transfers are all-or-nothing, not best-effort.** A2's return value is `select(success, amount, 0)`. GhostKey cannot present "sent what it could" as a behaviour, and the MCP server's phrasing back to the user must not imply partial sends.

**6. No confidential-wrapper registry was found.** The prompt assumed an official Sepolia registry to enumerate pairs from. I did not find one, and the wrappers actually in use are named `cUSDCMock` / `USDCMock` — mocks, not a curated Zama-operated set. I did not exhaustively search Zama's deployment records, so I am recording this as **unresolved, not disproven**. Until it is settled, `spikes/registry.ts` is a discovery shim over a known list rather than a real registry client. **This needs a decision before step 3**, because the SDK was specified as registry-driven: either a registry exists and we find it, or we define our own token list format and the "no hardcoded addresses" rule becomes "no addresses hardcoded in code, one config file instead".

**7. A9 is unverified against live wallets.** Support was read from documentation, within the agreed timebox. If the session-open flow depends on batching three calls into one approval, that needs a real wallet test before it goes in a demo.

**8. Proof generation dominates and is client-hardware dependent.** 12.5s of a 29s median is local ZK proof work. On a slower client it gets worse, and it is the one term the protocol cannot help with. The mitigation — warm the proof early — should be designed into the SDK from the start rather than bolted on.

---

## 7. Exact dependency versions

Pinned, as installed and used for every measurement above.

| Package                                | Version                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `@fhevm/solidity`                      | 0.11.1                                               |
| `@fhevm/hardhat-plugin`                | 0.4.2                                                |
| `@fhevm/mock-utils`                    | 0.4.2                                                |
| `@fhevm/host-contracts`                | 0.10.0 (transitive, via hardhat-plugin)              |
| `@zama-fhe/relayer-sdk`                | 0.4.1                                                |
| `@openzeppelin/confidential-contracts` | 0.5.3                                                |
| `@openzeppelin/contracts`              | 5.6.1                                                |
| `encrypted-types`                      | 0.0.4                                                |
| `hardhat`                              | ^2.28.6                                              |
| `ethers`                               | ^6.16.0                                              |
| `typescript`                           | ^5.9.3                                               |
| node                                   | v22.13.0                                             |
| pnpm                                   | 9.12.0                                               |
| solc                                   | 0.8.27, optimizer 800 runs, viaIR, evmVersion cancun |

**Toolchain constraint worth pinning down:** `@fhevm/hardhat-plugin@0.4.2` peer-requires `hardhat: ^2.0.0` — **not Hardhat 3** — and pins `@zama-fhe/relayer-sdk` and `@fhevm/mock-utils` to exact versions. Upgrading Hardhat is not available to us until the plugin moves.

**Version delta noted:** GhostLend runs `@openzeppelin/confidential-contracts` 0.5.1; GhostKey installs 0.5.3. All A1–A4 and A7 evidence above is read from 0.5.3.

**Plugin gap:** `@fhevm/hardhat-plugin` exposes `initializeCLIApi`, `createEncryptedInput`, `userDecryptEuint`, and `publicDecrypt`, but **no delegation helper** — grep for `delegat` in its `dist/` returns nothing. All delegated decryption must go through the raw relayer SDK, as `delegation.ts` does.

---

## 8. Addendum — two ACL facts verified during the step-2 design pass

Neither question was asked in step 1, and the step-2 contract shape depends on both. Recorded here so `findings.md` stays the single source of truth.

### 8.1 Transient access is sufficient to issue a persistent grant

`@fhevm/host-contracts@0.10.0`, `ACL.sol:441-443` and `:191-201`:

```solidity
function isAllowed(bytes32 handle, address account) public view virtual returns (bool) {
  return allowedTransient(handle, account) || persistAllowed(handle, account);
}

function allow(bytes32 handle, address account) public virtual whenNotPaused {
  if (isAccountDenied(msg.sender)) revert SenderDenied(msg.sender);
  if (!isAllowed(handle, msg.sender)) revert SenderNotAllowed(msg.sender);
  $.persistedAllowedPairs[handle][account] = true;
  emit Allowed(msg.sender, account, handle);
}
```

`allow()` gates on `isAllowed`, which accepts transient. So a module holding only transient access to a handle — which is all `ERC7984.sol:144` ever grants for `transferred` — can still make that handle persistently decryptable before the transaction ends.

Two consequences recorded at the same time:

- `allow()` is `whenNotPaused` and reverts `SenderDenied` for a deny-listed caller. A function that "never reverts" on a budget or balance failure can still revert for these protocol reasons. The public claim must be narrowed accordingly.
- **Granting the two reader accounts is not sufficient.** `userDecrypt` authorises against both the requesting account _and_ the contract the handle is read through, so the module must also grant itself with `FHE.allowThis`. Omitting it compiles, passes every budget test, and leaves the emitted handles permanently undecryptable. Found by test, not by reading. See `docs/step2-notes.md` §2.

### 8.2 Computed handles are auto-granted to the computing contract

`FHEVMExecutor.sol` calls `acl.allowTransient(result, msg.sender)` after each operation (`:677`, `:701`, `:726`, `:818`, `:841`). A contract therefore holds transient access to every handle it computes, with no explicit grant.

This closes the grant chain for a clamped transfer: the module computes `amount` and is auto-granted; it grants the token transiently so the token can compute on it; the token's `require(FHE.isAllowed(amount, msg.sender))` passes on that transient grant; the token returns `sent` with `allowTransient` back to the module; the module computes the refund and the new budget, auto-granted again, then issues persistent grants per §8.1.

Corroboration that this is real rather than inferred: `ERC7984._update` relies on it — `transferred = FHE.select(...)` at `:306` followed by `FHE.allowThis(transferred)` at `:321` with no grant in between, in production code.

### 8.3 Consequence for the step-1 HCU estimate

The ~955,000 HCU figure in §2 (A8) was computed for a clamp-and-transfer flow with no refund path. The implemented `send` adds `select` + `sub` + `add`, bringing the real figure to **1,334,064 HCU** — still only 6.7% of the 20,000,000 ceiling. The per-op costs in §2 are unchanged and correct; only the operation count was understated. `FHE.allowThis` and `FHE.allow` are ACL writes, not FHE operations, and cost EVM gas but no HCU.
