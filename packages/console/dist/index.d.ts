export type PendingKind = "unlock" | "reveal" | "sealed";
export interface Pending {
    readonly id: string;
    readonly kind: PendingKind;
    /** Shown verbatim on the page. Must already be sanitised by the caller. */
    readonly detail: string;
    readonly createdAt: number;
}
/** Whatever the console currently knows about the session, for the status panel. */
export interface ConsoleStatus {
    session: boolean;
    /**
     * The product's central claim, rendered as a number.
     *
     * Unlocks, not signatures: after one unlock the vault signs setOperator,
     * openSession and — on the balance-visible tier — delegateForUserDecryption.
     * Three signatures, one authorisation. The counter names the second.
     */
    vaultUnlocks: number;
    /**
     * What those unlocks were for, so the page can say it rather than show a bare
     * number. Sums to vaultUnlocks.
     */
    unlocks?: readonly {
        reason: string;
        n: number;
    }[] | undefined;
    vault?: string | undefined;
    sessionKey?: string | undefined;
    expiry?: number | undefined;
    txCount?: number | undefined;
    maxTxCount?: number | undefined;
    recipients?: readonly string[] | undefined;
    tier?: "spend-only" | "balance-visible" | undefined;
}
/**
 * Values the user sets on the console and the session client reads at open time.
 *
 * A transfer cap is not a tool argument — a chat client should not be talking a
 * user into a wider one — so it lives here, next to the sentence explaining what
 * it buys.
 */
export interface ConsoleSettings {
    /** Maximum transfers per session. 0 means uncapped. */
    maxTxCount: number;
}
/**
 * Default cap.
 *
 * `docs/leakage.md` §3: reaching statistical significance on the residual gas
 * channel would need roughly 120 observations of the same skew. Fifty is
 * comfortably under that and generous for a day of ordinary use, so the default
 * is a real bound rather than a token one.
 */
export declare const DEFAULT_MAX_TX_COUNT = 50;
export interface Resolution {
    readonly approved: boolean;
    /** Only for `sealed`: the amount the user typed, as they typed it. */
    readonly value?: string | undefined;
}
/**
 * What the console shows about the vault.
 *
 * Confidential token balances are deliberately absent: showing them would need a
 * decryption, and a decryption is the thing the whole product makes deliberate.
 * The console shows what is public — the address and the gas — and the
 * conversation is where you ask about the rest.
 */
export interface VaultPanel {
    readonly address: string;
    readonly ethBalance: string;
    readonly chainId: number;
    readonly chainName: string;
    /** Symbols the local config knows about, for the mint control. */
    readonly tokens: readonly string[];
    /** False off testnet, which hides the mint control entirely. */
    readonly canMint: boolean;
}
export interface ConsoleServerOptions {
    /** Called when the user presses the revoke button. */
    onRevoke?: () => Promise<void> | void;
    /** Reads the vault panel. Absent when the console runs without a chain. */
    onVault?: () => Promise<VaultPanel>;
    /** Mints test tokens to the vault. Testnet only; absent elsewhere. */
    onMint?: (symbol: string, amount: string) => Promise<string>;
    /** Seconds before an unanswered prompt resolves as denied. */
    timeoutSeconds?: number;
}
export declare class ConsoleServer {
    private readonly opts;
    private readonly server;
    private readonly token;
    private readonly waiters;
    private readonly listeners;
    private status;
    private settings;
    private vault;
    private vaultError;
    private port;
    private stopped;
    constructor(opts?: ConsoleServerOptions);
    start(): Promise<string>;
    stop(): Promise<void>;
    get url(): string;
    setStatus(patch: Partial<ConsoleStatus>): void;
    getStatus(): ConsoleStatus;
    /** Read by the session client when it opens a session. */
    getSettings(): ConsoleSettings;
    /**
     * Reads the vault panel and pushes it to any open page.
     *
     * Called by the owner of this server once its dependencies exist — not from
     * start(), which runs before they do. Failures are recorded rather than
     * swallowed: a page showing dashes with no explanation is worse than one
     * saying it could not reach the chain, especially on a first run where the
     * user has nothing to compare against.
     */
    refreshVault(): Promise<void>;
    /**
     * Puts a request on the page and waits for the user.
     *
     * Denial on timeout rather than approval: the failure mode of an unattended
     * console must be that nothing happens, not that everything is approved.
     */
    ask(kind: PendingKind, detail: string): Promise<Resolution>;
    private notify;
    private authorised;
    private handle;
    private json;
}
export { consoleHtml } from "./ui";
