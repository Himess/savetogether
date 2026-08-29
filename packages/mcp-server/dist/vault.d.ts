import type { ConsoleServer } from "@ghostkey/console";
import { type Provider, Wallet } from "ethers";
/** Only Sepolia. Asserted, not assumed — see {@link Vault.unlock}. */
export declare const SEPOLIA_CHAIN_ID = 11155111;
export interface VaultOptions {
    readonly provider: Provider;
    readonly chainId: number;
    /** Present in normal operation; absent only for headless tests. */
    readonly console?: ConsoleServer;
    /**
     * Skips the human authorisation step so a demo can be recorded without a hand
     * reaching for the mouse. Hard-gated to Sepolia — see {@link Vault.unlock}.
     */
    readonly devUnlock?: boolean;
    readonly dir?: string;
}
export declare class Vault {
    private readonly opts;
    private readonly store;
    private cached;
    constructor(opts: VaultOptions);
    /** Creates the vault key if there is not one already. Returns its address. */
    ensure(): Promise<string>;
    address(): Promise<string | null>;
    /**
     * Authorises and returns the vault signer.
     *
     * The key material is decrypted from the OS keychain; the *authorisation* is a
     * click on the local console, or a terminal confirmation when there is no
     * console. Neither path can be driven by the model: a tool call cannot click a
     * button, and stdin belongs to the MCP transport, not to a conversation.
     *
     * NOT IMPLEMENTED: a true biometric prompt (Touch ID, Windows Hello). That
     * needs a native module per platform. What is implemented is key material at
     * rest under the OS keychain plus a local human action — which is the second
     * item in the brief's preference order, and is honest about being that.
     */
    unlock(reason: string): Promise<Wallet>;
    /** Drops the decrypted key. Called immediately after the session open. */
    lock(): void;
    get isUnlocked(): boolean;
}
