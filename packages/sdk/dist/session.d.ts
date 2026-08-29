/**
 * The session: what a session client can do once the owner has authorised it.
 *
 * Two tiers, and they are two TYPES rather than a flag on one type. A session
 * opened without ACL delegation has no `balance()` method, so a reference amount
 * like "half of what's in the wallet" fails to compile rather than failing at
 * runtime. Neither tier is degraded — spend-only is a complete session that
 * simply cannot answer "what is in the wallet", which is a privacy property.
 */
import type { Signer } from "ethers";
import { type GhostKeyContract } from "./contracts";
import { AmountExpr, AmountRef } from "./amounts";
import { type FhevmInstance } from "./fhe";
/** Plaintext session parameters, exactly as the contract stores them. */
export interface SessionParams {
    readonly owner: string;
    /** UNIX seconds. Zero means the session was closed. */
    readonly expiry: number;
    /** Zero means unlimited. */
    readonly maxTxCount: number;
    readonly txCount: number;
}
/** Everything that can stop a send, named rather than left as an opaque revert. */
export interface Readiness {
    readonly ok: boolean;
    readonly sessionLive: boolean;
    readonly operatorGranted: boolean;
    readonly aclPaused: boolean;
    readonly keyDenied: boolean;
    readonly moduleDenied: boolean;
    readonly reasons: readonly string[];
}
/** The contract's truth table, as a discriminated union. */
export type SendResult = {
    readonly outcome: "sent";
    readonly amount: bigint;
    readonly hash: string;
    readonly sent: AmountRef;
} | {
    readonly outcome: "over-budget";
    readonly hash: string;
    readonly sent: AmountRef;
} | {
    readonly outcome: "insufficient-balance";
    readonly hash: string;
    readonly sent: AmountRef;
};
export interface SendIntent {
    readonly token: string;
    readonly to: string;
    readonly amount: AmountExpr;
}
/**
 * The outcome of closing a session.
 *
 * Session keys are single-use by design, so whatever gas is left on one after a
 * close is stranded forever unless it is swept. Opening a session a day without
 * this leaks 0.02 ETH a day for no benefit.
 */
export interface CloseResult {
    readonly hash: string;
    /** Wei returned to the owner. Zero when there was nothing worth moving. */
    readonly reclaimed: bigint;
    /** Set when the sweep failed. The session is closed regardless. */
    readonly sweepError?: string;
}
/** A send whose proof may still be generating. */
export interface PreparedSend {
    /** Settles when the encrypted input is ready. Await it or ignore it. */
    readonly ready: Promise<void>;
    send(): Promise<SendResult>;
    abort(): void;
}
export interface SessionContext {
    readonly moduleAddress: string;
    readonly sessionKey: Signer;
    readonly sessionKeyAddress: string;
    readonly owner: string;
    readonly fhevm: FhevmInstance;
}
declare class SessionImpl {
    protected readonly ctx: SessionContext;
    protected readonly module: GhostKeyContract;
    constructor(ctx: SessionContext);
    get sessionKeyAddress(): string;
    get owner(): string;
    get moduleAddress(): string;
    params(): Promise<SessionParams>;
    tokens(): Promise<readonly string[]>;
    recipients(): Promise<readonly string[]>;
    /**
     * The remaining budget, as a reference. This needs no ACL delegation: the
     * budget is the module's own handle and the contract grants it to both the
     * owner and the session key at every write.
     */
    remaining(token: string): Promise<AmountRef>;
    /** Boolean only. Never returns or leaks the amounts it compares. */
    canAfford(token: string, amount: bigint): Promise<boolean>;
    readiness(token?: string): Promise<Readiness>;
    /**
     * Starts encryption and proof generation now, submits later.
     *
     * On the step-1 measurements this is worth roughly twelve seconds of perceived
     * latency: proof generation is client-side, has near-zero variance, and happens
     * before any transaction exists. Call it the moment the intent is legible.
     */
    prepare(intent: SendIntent): PreparedSend;
    send(intent: SendIntent): Promise<SendResult>;
    /** @internal The part after the proof exists. */
    protected submit(token: string, to: string, value: bigint, input: {
        handle: string;
        inputProof: string;
    }): Promise<SendResult>;
    /** Owner or session key. The client must be able to narrow its own scope. */
    removeRecipient(to: string, as?: Signer): Promise<string>;
    /**
     * Closes the session and returns the session key's leftover gas to the owner.
     *
     * Owner or session key may close — the client must be able to self-terminate.
     * The sweep is always signed by the SESSION key, whoever closed, because that is
     * where the balance sits and the session key can already sign a close.
     *
     * Best effort by construction: the close is awaited first and its result stands
     * whatever happens next. A failed sweep leaves stranded gas, which is the state the
     * caller was already in; a failed sweep that took the close down with it would
     * be strictly worse.
     */
    close(as?: Signer): Promise<CloseResult>;
    /**
     * Sends the session key's balance to the owner, less the cost of doing so.
     *
     * The reserve is computed from `maxFeePerGas` rather than the base fee, so the
     * transaction cannot price itself out between estimation and inclusion. That
     * leaves a little dust behind, which is the right side to err on.
     */
    private sweepGas;
    /** Owner only — the vault key must be unlocked for this. */
    addRecipient(to: string, owner: Signer): Promise<string>;
    /** Owner only. */
    increaseBudget(token: string, amount: bigint, owner: Signer): Promise<string>;
}
/** A session with no ACL delegation: it sees what it spent, never the wallet. */
export declare class SpendOnlySession extends SessionImpl {
    readonly tier: "spend-only";
    /** Explicit, so a JavaScript caller gets a useful error rather than `undefined`. */
    balance(): never;
}
/** A session with ACL delegation: it can also read the holder's balance. */
export declare class BalanceVisibleSession extends SessionImpl {
    readonly tier: "balance-visible";
    /**
     * The holder's confidential balance, as a reference.
     *
     * This is the one capability that requires ACL delegation, and it is the whole
     * reason delegation exists in this design. The session key signs with its OWN
     * key; the owner signs nothing here. Verified live in step 1 (A6).
     */
    balance(token: string): Promise<AmountRef>;
}
export type Session = SpendOnlySession | BalanceVisibleSession;
export {};
