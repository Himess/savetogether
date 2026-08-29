/**
 * Errors the SDK raises for conditions the contract deliberately does not
 * enforce, plus the protocol conditions it can enforce but cannot explain.
 */
/** Base class so a consumer can catch everything from this package at once. */
export declare class GhostKeyError extends Error {
    constructor(message: string);
}
/**
 * A zero amount is refused before it is encrypted.
 *
 * The contract cannot distinguish a zero request from an insufficient balance —
 * both produce `within = true, sent = 0` — and deliberately spends no FHE
 * operation trying. The session client constructed the ciphertext and therefore
 * knows its own plaintext, so this is its obligation, not the chain's.
 */
export declare class ZeroAmountError extends GhostKeyError {
    constructor();
}
/**
 * `token.setOperator(module, expiry)` has lapsed or was never granted.
 *
 * Operator grants live on the token and expire independently of `Session.expiry`,
 * so a session can be perfectly live and still be unable to move anything. Without
 * this check the user gets an opaque revert from inside the token.
 */
export declare class OperatorNotGrantedError extends GhostKeyError {
    readonly owner: string;
    readonly token: string;
    constructor(owner: string, token: string);
}
/** The FHEVM ACL is paused, or a participant is on its deny list. */
export declare class ProtocolUnavailableError extends GhostKeyError {
    readonly detail: {
        aclPaused: boolean;
        keyDenied: boolean;
        moduleDenied: boolean;
    };
    constructor(detail: {
        aclPaused: boolean;
        keyDenied: boolean;
        moduleDenied: boolean;
    });
}
/** The session is closed, expired, or has exhausted its transaction count. */
export declare class SessionNotLiveError extends GhostKeyError {
    readonly reason: "closed" | "expired" | "tx-count-exhausted" | "missing";
    constructor(reason: "closed" | "expired" | "tx-count-exhausted" | "missing");
}
/** A recipient outside the session allowlist. */
export declare class RecipientNotAllowedError extends GhostKeyError {
    readonly to: string;
    constructor(to: string);
}
/**
 * A reference amount was used on a session with no balance visibility.
 *
 * This should be unreachable from TypeScript — `SpendOnlySession` has no
 * `balance()` — and exists for JavaScript consumers and for refs smuggled across
 * sessions.
 */
export declare class BalanceNotVisibleError extends GhostKeyError {
    constructor();
}
/** The keystore could not produce a usable session key. */
export declare class KeystoreError extends GhostKeyError {
}
