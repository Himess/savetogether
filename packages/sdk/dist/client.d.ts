/**
 * The client: opening a session, and resuming one that already exists.
 *
 * ON "ONE SIGNATURE". Opening a session needs three owner-side actions —
 * `setOperator` per token, `openSession`, and, only for the balance-visible tier,
 * `delegateForUserDecryption` per token. There are two honest ways to make that
 * one authorisation, and both are implemented here because they serve different
 * callers:
 *
 *   - a consumer with a browser wallet gets them batched into one approval via
 *     EIP-5792 `wallet_sendCalls`, when the wallet advertises the capability;
 *   - the GhostKey product has no browser wallet — both keys are local — so
 *     "one signature" means ONE VAULT UNLOCK, after which the local owner key
 *     signs the three transactions in sequence without asking again.
 *
 * The fallback is not a degraded path. For the product it is the path.
 */
import { type Provider, type Signer } from "ethers";
import { type SessionKeystore } from "./keystore";
import { type Session } from "./session";
/**
 * Gas forwarded to a freshly generated session key, unless the caller says otherwise.
 *
 * The session key sends its own transactions — that is what makes it a session key
 * rather than a signature scheme — so it needs gas, and the only moment the owner
 * is authorised is during the open. Leaving this to every consumer is a footgun:
 * the first integration test written against this SDK forgot it, and the failure
 * surfaces as an opaque "insufficient funds" from inside `send`, minutes later.
 *
 * About 0.02 ETH is twenty-odd confidential transfers at Sepolia gas prices.
 */
export declare const DEFAULT_SESSION_GAS: bigint;
/** Which privacy tier a session runs in. Chosen at open; it is not a runtime flag. */
export type ReadScope = "spend-only" | "balance-visible";
export interface GhostKeyClientConfig {
    readonly provider: Provider;
    readonly rpcUrl: string;
    readonly moduleAddress: string;
    readonly keystore: SessionKeystore;
    /** Defaults to the ACL address the relayer SDK ships for Sepolia. */
    readonly aclAddress?: string;
    readonly chainId?: number;
}
export interface OpenSessionRequest {
    /** The vault key. Unlocked for this call and locked again afterwards. */
    readonly owner: Signer;
    readonly budgets: ReadonlyArray<{
        token: string;
        amount: bigint;
    }>;
    readonly recipients: readonly string[];
    readonly expiry: Date;
    readonly maxTxCount?: number;
    readonly readScope: ReadScope;
    /** Label recorded in the keystore metadata. */
    readonly label?: string;
    /**
     * Gas to forward to the session key. Defaults to {@link DEFAULT_SESSION_GAS}.
     * Pass 0n to fund it yourself — the session key cannot send without gas.
     */
    readonly gasForSessionKey?: bigint;
}
export interface OpenSessionResult {
    readonly session: Session;
    readonly sessionKeyAddress: string;
    /** Transaction hashes in submission order. */
    readonly hashes: readonly string[];
    /** True when EIP-5792 batching was available and used. */
    readonly batched: boolean;
    /** Gas actually forwarded to the session key. Zero if it already had enough. */
    readonly gasForwarded: bigint;
    /**
     * How many times the owner had to authorise. One when batched; one when the
     * vault is unlocked once and signs locally. Higher only if a caller supplies a
     * signer that prompts per transaction.
     */
    readonly ownerAuthorisations: number;
}
export declare class GhostKeyClient {
    readonly config: GhostKeyClientConfig;
    private fhevmPromise;
    constructor(config: GhostKeyClientConfig);
    private fhevm;
    private get acl();
    /** Opens a session. Generates the session key locally; it never leaves the process. */
    openSession(req: OpenSessionRequest): Promise<OpenSessionResult>;
    /** Rebuilds a session object for a key already in the keystore. */
    resumeSession(sessionKeyAddress: string, readScope: ReadScope): Promise<Session>;
    /** Revokes balance visibility without closing the session. */
    revokeBalanceAccess(owner: Signer, sessionKeyAddress: string, tokens: readonly string[]): Promise<readonly string[]>;
}
