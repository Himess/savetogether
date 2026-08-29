/**
 * The tool surface.
 *
 * WHAT THE MODEL MAY SEE. By default, never a plaintext amount. `reveal: true`
 * requires a click on the local console, every single call, and there is no
 * configuration option that turns the confirmation off. That is the ideological
 * core of the project, so it is enforced here rather than left to a setting.
 *
 * NO UNWRAP TOOL. ERC-7984 to ERC-20 needs public decryption of the amount, which
 * is a deliberate disclosure decision. It stays outside session authority
 * entirely; if a user asks, `send` explains why and points at the console.
 */
import type { ConsoleServer } from "@ghostkey/console";
import { GhostKeyClient } from "@ghostkey/sdk";
import { type Provider } from "ethers";
import { type GhostKeyConfig } from "./config";
import { Vault } from "./vault";
export interface ToolContext {
    readonly config: GhostKeyConfig;
    readonly provider: Provider;
    readonly client: GhostKeyClient;
    readonly vault: Vault;
    readonly console?: ConsoleServer;
}
export interface ToolResult {
    readonly ok: boolean;
    readonly text: string;
    readonly data?: Record<string, unknown>;
}
/**
 * What a vault unlock was spent on.
 *
 * The counter is the product's central claim as a number, and a number nobody can
 * attribute is not evidence — it could be a constant with a label on it. Recording
 * the reason is what makes a move from 1 to 2 mid-demo readable as "the owner
 * widened the allowlist" rather than as drift.
 */
export type UnlockReason = "session" | "recipient" | "wrap";
export declare class GhostKeyTools {
    private readonly ctx;
    private live;
    constructor(ctx: ToolContext);
    private token;
    /**
     * Validates a recipient address.
     *
     * Every address argument used to go straight through to ethers, which meant a
     * model passing a name — "add Mehmet to the list" is a thing a user says — got
     * an ABI encoding error AFTER the tool had already made the user click a vault
     * unlock. A physical action spent on an argument that was never going to work.
     *
     * Names and ENS are refused rather than resolved: resolution is a chain call
     * whose answer the user cannot check before signing, and this is the one
     * argument where being wrong sends money to the wrong place.
     */
    private recipient;
    /**
     * The world check, deliberately performed AFTER argument validation.
     *
     * An unknown token, a malformed amount or a bad address is the caller's mistake
     * and costs one local check to detect. Reporting "no session is open" first
     * sends a model off to open a session and come back to the same error, having
     * spent a vault unlock on the round trip. Cheap and specific before expensive
     * and situational — and never after something the user has to physically click.
     */
    private requireLive;
    private newRefId;
    /** Counts an unlock and remembers what it bought. */
    private recordUnlock;
    private pushStatus;
    openSession(args: {
        tokens: string[];
        budgets: string[];
        allowlist: string[];
        ttlHours: number;
        delegation: boolean;
    }): Promise<ToolResult>;
    /** Symbols and references. Never amounts. */
    listAssets(): Promise<ToolResult>;
    /** Returns a reference by default. A number only with a click. */
    balance(args: {
        token: string;
        reveal: boolean;
    }): Promise<ToolResult>;
    remaining(args: {
        token: string;
        reveal: boolean;
    }): Promise<ToolResult>;
    /** Boolean only. Never leaks either side of the comparison. */
    canAfford(args: {
        token: string;
        amount: string;
    }): Promise<ToolResult>;
    sessionStatus(): Promise<ToolResult>;
    /**
     * `amount` is one of: a plain decimal, a reference id from `balance`/`remaining`
     * optionally with `half`/`percent`, or the literal `"sealed"`.
     *
     * SEALED MODE. The user types the amount on the console; this process encrypts
     * it; the model receives only `{status, ok_ref, sent_ref}`. What still leaks,
     * stated plainly rather than glossed: that a transfer happened, which token,
     * which recipient, and when. Recipients are public on chain regardless, so
     * sealed mode hides the amount and nothing else — and it does not pretend to.
     */
    send(args: {
        token: string;
        to: string;
        amount: string;
    }): Promise<ToolResult>;
    addRecipient(args: {
        to: string;
    }): Promise<ToolResult>;
    /**
     * Wrapping needs the vault, which the brief's tool list did not note: `wrap`
     * moves a PUBLIC ERC-20 balance the owner holds, so it is `approve` plus `wrap`
     * signed by the vault key, not by the session key.
     */
    wrap(args: {
        token: string;
        amount: string;
    }): Promise<ToolResult>;
    /** The panic button. Closes the session; the session key can do this alone. */
    revokeAll(): Promise<ToolResult>;
    private revealRef;
    /**
     * What the console shows about the vault.
     *
     * No confidential balances: reading one is a decryption, and a decryption is
     * exactly the act this product makes deliberate. The console shows the public
     * facts — address, gas, network — and the conversation is where you ask about
     * the rest.
     */
    vaultPanel(): Promise<{
        address: string;
        ethBalance: string;
        chainId: number;
        chainName: string;
        tokens: string[];
        canMint: boolean;
    }>;
    /**
     * Mints confidential test tokens straight to the vault.
     *
     * This signs with the vault key, so it raises a real unlock prompt even though
     * the user is already standing at the console. That is the rule holding rather
     * than an oversight: no vault signature without an explicit authorisation. It
     * also happens before any session exists, so it does not touch the unlock
     * counter — which counts unlocks *this session*.
     */
    mint(symbol: string, amount: string): Promise<string>;
    /** @internal for the CLI's status command */
    vaultSummary(): Promise<{
        address: string | null;
        balance: string;
    }>;
}
/** Builds the keystore the SDK should use. Memory only for tests. */
export declare function sessionKeystore(inMemory: boolean): import("@ghostkey/sdk").SessionKeystore;
