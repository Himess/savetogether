/**
 * Errors the SDK raises for conditions the contract deliberately does not
 * enforce, plus the protocol conditions it can enforce but cannot explain.
 */

/** Base class so a consumer can catch everything from this package at once. */
export class GhostKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A zero amount is refused before it is encrypted.
 *
 * The contract cannot distinguish a zero request from an insufficient balance —
 * both produce `within = true, sent = 0` — and deliberately spends no FHE
 * operation trying. The session client constructed the ciphertext and therefore
 * knows its own plaintext, so this is its obligation, not the chain's.
 */
export class ZeroAmountError extends GhostKeyError {
  constructor() {
    super("refusing to send zero: the contract reports it identically to an insufficient balance");
  }
}

/**
 * `token.setOperator(module, expiry)` has lapsed or was never granted.
 *
 * Operator grants live on the token and expire independently of `Session.expiry`,
 * so a session can be perfectly live and still be unable to move anything. Without
 * this check the user gets an opaque revert from inside the token.
 */
export class OperatorNotGrantedError extends GhostKeyError {
  constructor(
    readonly owner: string,
    readonly token: string,
  ) {
    super(
      `the module is not an operator for ${owner} on ${token}; the grant lapses independently of the session`,
    );
  }
}

/** The FHEVM ACL is paused, or a participant is on its deny list. */
export class ProtocolUnavailableError extends GhostKeyError {
  constructor(readonly detail: { aclPaused: boolean; keyDenied: boolean; moduleDenied: boolean }) {
    const parts = [
      detail.aclPaused ? "the FHEVM ACL is paused" : null,
      detail.keyDenied ? "the session key is deny-listed" : null,
      detail.moduleDenied ? "the module is deny-listed" : null,
    ].filter(Boolean);
    super(`send would revert for a protocol reason: ${parts.join("; ")}`);
  }
}

/** The session is closed, expired, or has exhausted its transaction count. */
export class SessionNotLiveError extends GhostKeyError {
  constructor(readonly reason: "closed" | "expired" | "tx-count-exhausted" | "missing") {
    super(`session is not live: ${reason}`);
  }
}

/** A recipient outside the session allowlist. */
export class RecipientNotAllowedError extends GhostKeyError {
  constructor(readonly to: string) {
    super(`${to} is not on this session's allowlist`);
  }
}

/**
 * A reference amount was used on a session with no balance visibility.
 *
 * This should be unreachable from TypeScript — `SpendOnlySession` has no
 * `balance()` — and exists for JavaScript consumers and for refs smuggled across
 * sessions.
 */
export class BalanceNotVisibleError extends GhostKeyError {
  constructor() {
    super(
      "this session has no ACL delegation, so it cannot read the holder's balance; open with readScope 'balance-visible' for reference amounts",
    );
  }
}

/** The keystore could not produce a usable session key. */
export class KeystoreError extends GhostKeyError {}
