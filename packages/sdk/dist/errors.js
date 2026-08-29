"use strict";
/**
 * Errors the SDK raises for conditions the contract deliberately does not
 * enforce, plus the protocol conditions it can enforce but cannot explain.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeystoreError = exports.BalanceNotVisibleError = exports.RecipientNotAllowedError = exports.SessionNotLiveError = exports.ProtocolUnavailableError = exports.OperatorNotGrantedError = exports.ZeroAmountError = exports.GhostKeyError = void 0;
/** Base class so a consumer can catch everything from this package at once. */
class GhostKeyError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}
exports.GhostKeyError = GhostKeyError;
/**
 * A zero amount is refused before it is encrypted.
 *
 * The contract cannot distinguish a zero request from an insufficient balance —
 * both produce `within = true, sent = 0` — and deliberately spends no FHE
 * operation trying. The session client constructed the ciphertext and therefore
 * knows its own plaintext, so this is its obligation, not the chain's.
 */
class ZeroAmountError extends GhostKeyError {
    constructor() {
        super("refusing to send zero: the contract reports it identically to an insufficient balance");
    }
}
exports.ZeroAmountError = ZeroAmountError;
/**
 * `token.setOperator(module, expiry)` has lapsed or was never granted.
 *
 * Operator grants live on the token and expire independently of `Session.expiry`,
 * so a session can be perfectly live and still be unable to move anything. Without
 * this check the user gets an opaque revert from inside the token.
 */
class OperatorNotGrantedError extends GhostKeyError {
    owner;
    token;
    constructor(owner, token) {
        super(`the module is not an operator for ${owner} on ${token}; the grant lapses independently of the session`);
        this.owner = owner;
        this.token = token;
    }
}
exports.OperatorNotGrantedError = OperatorNotGrantedError;
/** The FHEVM ACL is paused, or a participant is on its deny list. */
class ProtocolUnavailableError extends GhostKeyError {
    detail;
    constructor(detail) {
        const parts = [
            detail.aclPaused ? "the FHEVM ACL is paused" : null,
            detail.keyDenied ? "the session key is deny-listed" : null,
            detail.moduleDenied ? "the module is deny-listed" : null,
        ].filter(Boolean);
        super(`send would revert for a protocol reason: ${parts.join("; ")}`);
        this.detail = detail;
    }
}
exports.ProtocolUnavailableError = ProtocolUnavailableError;
/** The session is closed, expired, or has exhausted its transaction count. */
class SessionNotLiveError extends GhostKeyError {
    reason;
    constructor(reason) {
        super(`session is not live: ${reason}`);
        this.reason = reason;
    }
}
exports.SessionNotLiveError = SessionNotLiveError;
/** A recipient outside the session allowlist. */
class RecipientNotAllowedError extends GhostKeyError {
    to;
    constructor(to) {
        super(`${to} is not on this session's allowlist`);
        this.to = to;
    }
}
exports.RecipientNotAllowedError = RecipientNotAllowedError;
/**
 * A reference amount was used on a session with no balance visibility.
 *
 * This should be unreachable from TypeScript — `SpendOnlySession` has no
 * `balance()` — and exists for JavaScript consumers and for refs smuggled across
 * sessions.
 */
class BalanceNotVisibleError extends GhostKeyError {
    constructor() {
        super("this session has no ACL delegation, so it cannot read the holder's balance; open with readScope 'balance-visible' for reference amounts");
    }
}
exports.BalanceNotVisibleError = BalanceNotVisibleError;
/** The keystore could not produce a usable session key. */
class KeystoreError extends GhostKeyError {
}
exports.KeystoreError = KeystoreError;
//# sourceMappingURL=errors.js.map