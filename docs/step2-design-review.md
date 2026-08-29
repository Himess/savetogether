# GhostKey — Step 2 design review, before writing Solidity

Terminology note: this document predates the `session client` / `model` distinction adopted in step 2 (A3); its wording has been brought into line, since the rule applies to every file.

This is the pre-implementation answer to the step-2 brief: storage layout, the exact `send` flow, and everything in the brief that conflicts with what was verified. No Solidity has been written yet.

Self-contained on purpose — it repeats the step-1 facts it depends on, so it can be read without the repo.

---

## 0. Context in one paragraph

GhostKey adds an **encrypted spending budget** to ERC-7984 confidential tokens on Zama's FHEVM. ERC-7984's `setOperator(spender, until)` grants unlimited spending authority bounded only by time; GhostKey clamps every transfer against an `euint64 remaining` budget homomorphically — no revert, no plaintext, no leakage, so an observer cannot tell an accepted transfer from a rejected one. Three authorities stay separate: move (`token.setOperator`), read (`ACL.delegateForUserDecryption`), amount (the budget, inside the module).

Step 1 verified the assumptions against installed source and live Sepolia. Relevant results carried into this document:

- **A6 VERIFIED live** — a delegate can `userDecrypt` a delegator's handle with its own EIP-712 signature. 55,635 gas. Negative control passed (the relayer returned 400 before the delegation existed).
- `ERC7984.confidentialTransferFrom(from, to, euint64)` returns the amount **actually** moved, computed as `transferred = FHE.select(success, amount, 0)` where `success = ge(fromBalance, amount)` — so it is **all-or-nothing**, never partial.
- The returned handle is granted with `FHE.allowTransient`, not `FHE.allow` (`ERC7984.sol:144`).
- The ACL delegation API is **singular only**: `delegateForUserDecryption(address delegate, address contractAddress, uint64 expirationDate)`. The array form is absent from the deployed bytecode.
- HCU limits: 20,000,000 per tx, 5,000,000 sequential depth.
- euint64 op costs (ciphertext-ciphertext): `add` 162,000 · `sub` 162,000 · `le` 149,000 · `ge` 152,000 · `select` 55,000 · `trivialEncrypt` 32.

Versions everything below was read from: `@fhevm/solidity` 0.11.1, `@fhevm/host-contracts` 0.10.0, `@openzeppelin/confidential-contracts` 0.5.3, `@zama-fhe/relayer-sdk` 0.4.1, Hardhat 2.28.x, solc 0.8.27 (viaIR, optimizer 800, cancun).

---

## 1. Two verifications the step-1 report does not contain

Both were checked for this design pass because the step-2 shape depends on them, and neither question was asked in step 1. **They belong in `findings.md` as an addendum.**

### 1.1 Transient access is sufficient to grant persistent access — C2 depends on this

The brief requires emitting both the `within` and `sent` handles with ACL granted to the owner and the session key, so the client can tell a budget rejection from an insufficient balance. But the module only ever holds **transient** access to `sent` (that is C1). Can a contract with transient-only access issue a persistent grant?

Yes. `@fhevm/host-contracts@0.10.0`, `ACL.sol`:

```solidity
// :441-443
function isAllowed(bytes32 handle, address account) public view virtual returns (bool) {
  return allowedTransient(handle, account) || persistAllowed(handle, account);
}

// :191-201
function allow(bytes32 handle, address account) public virtual whenNotPaused {
  if (isAccountDenied(msg.sender)) revert SenderDenied(msg.sender);
  if (!isAllowed(handle, msg.sender)) revert SenderNotAllowed(msg.sender);
  $.persistedAllowedPairs[handle][account] = true;
  emit Allowed(msg.sender, account, handle);
}
```

`allow()` gates on `isAllowed`, and `isAllowed` accepts transient. So `FHE.allow(sent, owner)` from inside the same transaction works, and the emitted handle stays decryptable afterwards. **C2's two-handle design is viable.**

Note what else that snippet shows, which matters for conflict 3 below: `allow()` is `whenNotPaused` and reverts `SenderDenied` for a deny-listed caller.

### 1.2 Computed handles are auto-granted to the computing contract

`FHEVMExecutor.sol` calls `acl.allowTransient(result, msg.sender)` after every operation (`:677`, `:701`, `:726`, `:818`, `:841` — the op-family helpers). So a contract automatically holds transient access to any handle it computes.

This closes the grant chain end to end:

1. Module computes `amount = FHE.select(...)` → module gets transient access automatically.
2. Module calls `FHE.allowTransient(amount, token)` → passes `ACL.sol:244` because the module is allowed.
3. Token's `require(FHE.isAllowed(amount, msg.sender))` passes — `msg.sender` is the module, transient counts.
4. Token computes on `amount` inside `_update` — it has transient access from step 2.
5. Token returns `sent` with `allowTransient(sent, module)`.
6. Module computes `refund`/`newRemaining` → auto-granted.
7. Module issues persistent grants via §1.1.

Corroborating evidence that this is real rather than inferred: `ERC7984._update` itself relies on it — it computes `transferred = FHE.select(...)` at `:306` and calls `FHE.allowThis(transferred)` at `:321` with no explicit grant in between, and that code runs in production.

---

## 2. Storage layout

`Session` packs into exactly one slot by using sentinels instead of separate flags.

```solidity
struct Session {
    address owner;       // 160  — 0 means this key was NEVER used (one-shot guard, conflict 5)
    uint48  expiry;      //  48  — 0 means closed; <= block.timestamp means expired
    uint24  maxTxCount;  //  24  — 0 means unlimited
    uint24  txCount;     //  24
}                        // = 256 bits, one slot

mapping(address sessionKey => Session)                           private _sessions;
mapping(address sessionKey => mapping(address token => euint64)) private _remaining;
mapping(address sessionKey => mapping(address to => bool))       private _allowed;
mapping(address sessionKey => address[])                         private _allowlist; // enumeration for views
```

Three notes on the choices:

**No `closed` bool.** `expiry == 0` carries it, and `owner != address(0)` carries "this key has been used at some point". A live session necessarily has `expiry > block.timestamp`, so the three states are unambiguous. This is what makes the struct fit one slot, and it makes the one-shot key invariant fall out for free.

**No token allowlist.** A token with no budget has an uninitialized `_remaining`. `FHESafeMath.tryDecrease` on an uninitialized `oldValue` with an initialized `delta` returns `(FHE.eq(delta, 0), FHE.asEuint64(0))` — so `within` is false for any non-zero amount. The budget itself gates which tokens are reachable; a separate allowlist would be redundant state.

**`uint24` bounds.** 16,777,215 transactions per session, and `uint48` expiry is good past the year 8,000,000. Both are beyond any real use and buy the single slot.

---

## 3. The `send` flow

```
send(token, to, encAmount, proof)          // nonReentrant — see conflict 1

  ── checks (plaintext; reverting HERE is correct) ──────────────────
  s = _sessions[msg.sender]
  require s.owner  != 0                              // no session for this key
  require s.expiry != 0                              // closed
  require s.expiry >  block.timestamp                // expired
  require s.maxTxCount == 0 || s.txCount < s.maxTxCount
  require _allowed[msg.sender][to]                   // recipient not on the allowlist

  ── effects, BEFORE the external call ──────────────────────────────
  s.txCount += 1

  ── FHE: clamp against the budget ──────────────────────────────────
  requested         = FHE.fromExternal(encAmount, proof)   // bound to (this, msg.sender)
  (within, clamped) = FHESafeMath.tryDecrease(_remaining[msg.sender][token], requested)
                                                    // ge 152k + sub 162k + select 55k
  amount            = FHE.select(within, requested, FHE.asEuint64(0))        // 55k
  FHE.allowTransient(amount, token)                 // the token must compute on it

  ── interaction ────────────────────────────────────────────────────
  sent = IERC7984(token).confidentialTransferFrom(s.owner, to, amount)
         // token: require isAllowed(amount, this)      -> transient, ok
         //        require isOperator(s.owner, this)
         //        _update: tryDecrease 369k + select 55k + add 162k
         //        returns `sent`, allowTransient to us  (C1)

  ── reconcile IN THE SAME TRANSACTION (C1) ─────────────────────────
  refund       = FHE.sub(amount, sent)              // 162k — zero when fully sent
  newRemaining = FHE.add(clamped, refund)           // 162k
  _remaining[msg.sender][token] = newRemaining

  ── ACL ────────────────────────────────────────────────────────────
  FHE.allowThis(newRemaining)
  FHE.allow(newRemaining, s.owner);  FHE.allow(newRemaining, msg.sender)
  FHE.allow(within,       s.owner);  FHE.allow(within,       msg.sender)
  FHE.allow(sent,         s.owner);  FHE.allow(sent,         msg.sender)

  emit Sent(msg.sender, token, to, within, sent)
```

The three `FHE.allow` pairs at the end are only legal because of §1.1.

### Truth table

| case                     | `within`  | `sent`    | `refund`  | resulting `remaining`                         |
| ------------------------ | --------- | --------- | --------- | --------------------------------------------- |
| success                  | true      | requested | 0         | `clamped` (decremented)                       |
| **budget exceeded**      | **false** | 0         | 0         | unchanged — `tryDecrease` returned `oldValue` |
| **balance insufficient** | **true**  | **0**     | requested | restored to its prior value                   |
| `requested == 0`         | true      | 0         | 0         | unchanged                                     |

Walking the two failure rows:

- _Budget exceeded._ `within = false`, so `amount = select(false, requested, 0) = 0`. The token still executes: `tryDecrease(balance, 0)` succeeds, `transferred = 0`. `refund = 0 - 0 = 0`, and `clamped` is already the untouched `oldValue`, so the budget is correctly unchanged.
- _Balance insufficient._ `within = true`, so `clamped = remaining - requested` and `amount = requested`. The token returns `sent = 0`. `refund = requested - 0 = requested`, and `newRemaining = (remaining - requested) + requested = remaining`. **The budget is restored** — this is the path that leaks value if it is written wrong.

The important structural point: **a budget-exceeded call still makes a real `confidentialTransferFrom` call**, with an encrypted zero. That is precisely what makes it indistinguishable from a successful one — same call, same events, same topics.

---

## 4. Conflicts with the step-2 brief

Numbered by severity. Items 1 and 2 change what gets written.

### Conflict 1 — CEI is structurally inverted; `nonReentrant` is required, not optional

Not mentioned in the brief.

The budget write `_remaining[...] = newRemaining` **must** come after the external call, because it depends on `sent`, which only exists after the token returns. That is interactions-then-effects by construction, and C1 forbids the alternative (deferring reconciliation to a second transaction).

The `token` address is chosen by the session key, so it is not trusted input. A hostile token can re-enter `send` and spend a _different_ token's budget while the first call's budget write is still pending.

`s.txCount += 1` is moved before the external call, which is as far as checks-effects-interactions can be pushed. The budget cannot follow it. **A reentrancy guard on `send` is therefore load-bearing, not defensive styling.** This is the most significant addition to the brief.

### Conflict 2 — the HCU estimate is too low, and test 10 would assert against the wrong number

The brief says to assert "with margin against the ~955k step-1 estimate". That figure was computed for a simpler flow — clamp plus transfer, with **no refund path**. The real `send` adds a select, a sub and an add.

| side              | operations                                                              | HCU             |
| ----------------- | ----------------------------------------------------------------------- | --------------- |
| module            | `tryDecrease` 369,000 + `select` 55,000 + `sub` 162,000 + `add` 162,000 | 748,000         |
| token (`_update`) | `tryDecrease` 369,000 + `select` 55,000 + `add` 162,000                 | 586,000         |
| both              | `trivialEncrypt` × 2                                                    | 64              |
| **total**         |                                                                         | **≈ 1,334,064** |

(`tryDecrease` expands to `ge` 152,000 + `sub` 162,000 + `select` 55,000 = 369,000.)

That is 6.7% of the 20,000,000 per-transaction ceiling and roughly six operations of sequential depth against a 5,000,000 limit — comfortable either way. But the test bound should be **~1.6M**, not ~1M.

### Conflict 3 — "never reverts" is not absolute, and the public claim needs narrowing

The brief says `send` must "**never revert on budget or balance failure** — that is the entire point." True as written, and the design honours it. But `send` _can_ revert for reasons outside the module's control:

- `ACL.allow()` is `whenNotPaused` (`ACL.sol:191`) — a paused ACL reverts the whole call.
- `ACL.allow()` reverts `SenderDenied` if the module is on the ACL deny list (`:192-194`).
- `confidentialTransferFrom` reverts if `isOperator(owner, module)` is false, or if the input proof is malformed.

All of these are correct reverts. The point is only that the README and any public thread must claim **"never reverts on a budget or balance failure"** rather than the unqualified "never reverts", or the first person to pause the ACL makes the claim false. The `paused()` / `isAccountDenied(sessionKey)` view the brief already asks for is the right diagnostic surface for exactly this.

### Conflict 4 — C2 defines two failure cases; there are three

C2 says: budget exceeded ⇒ `within` false; balance insufficient ⇒ `within` true and `sent` zero. Correct. But `requested == 0` also yields `within = true, sent = 0`, which is byte-identical to the balance-insufficient case.

Separating them would need an extra FHE operation, which the brief explicitly rules out ("do not spend extra FHE ops deriving a combined status") — and rightly so. Recommendation: reject a zero amount client-side in the MCP layer, and document the ambiguity in the natspec so nobody later reports "insufficient balance" to a user who asked to send nothing.

### Conflict 5 — a session key must be single-use forever, not merely "fresh"

C4 requires a fresh session key per session, and makes the key the session identifier. That is right, but it needs an invariant rather than a convention.

ACL delegations live in the ACL contract, not in GhostKeySession. If a closed session's key can be reopened, the stale `delegateForUserDecryption` grant from the previous session is still live on the ACL and silently carries into the new one.

`openSession` must therefore revert when `_sessions[key].owner != address(0)` — i.e. a key is consumed permanently at first use, whether or not the session was later closed. The storage layout above already encodes this: `owner` is never cleared, only `expiry` is zeroed on close.

---

## 5. Notes that are not conflicts

**The delegation boundary is narrower than the brief's framing.** The brief observes that `remaining` is the module's own handle (so `FHE.allow(remaining, sessionKey)` suffices, no delegation) while `balance` belongs to the token and is granted only to the holder (`ERC7984.sol:302`, so delegation is required). Correct — and §1.1 sharpens it further: because `FHE.allow(sent, sessionKey)` is legal, the session client can also read **what it actually sent** without any delegation.

So ACL delegation is required for exactly one capability: reading the holder's **balance**, which is needed only for reference amounts ("send half"). The privacy tier is therefore: _the session client sees what it spent and what it has left, but not what is in the wallet._ That is a cleaner sentence for the README than "delegation is optional".

**The amount is not hidden from the session client.** `createEncryptedInput(contractAddress, userAddress)` binds the ciphertext to both, and `userAddress` must equal `msg.sender`, which is the session key. So the session client constructs the ciphertext and necessarily knows the plaintext. This is correct by design — the session client decides the amount — but it should be explicit in the docs so no one claims otherwise. What is hidden is the amount _from observers_, not from the session client.

**`within` is an `ebool`.** The client decrypts it with `FhevmType.ebool`, a different path from the `euint64` handles. A step-3 SDK note.

---

## 6. Decisions pending confirmation

1. Add `nonReentrant` to `send` (conflict 1).
2. Test 10 asserts against ~1.6M HCU, not ~1M (conflict 2).
3. `openSession` consumes a session key permanently, so a key can never be reused (conflict 5).
4. The two ACL findings in §1 are appended to `findings.md` as an addendum, since they are load-bearing for C1 and C2 and are absent from the step-1 report.

Everything else in the step-2 brief is consistent with what step 1 established, and the contract can be written against it as specified.
