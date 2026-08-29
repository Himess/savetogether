export interface TokenEntry {
    /** What the user calls it. Never read from the chain, so never injectable. */
    readonly symbol: string;
    readonly address: string;
    readonly decimals: number;
    /** The ERC-20 this wraps, when it is a wrapper. Absent for a plain ERC-7984. */
    readonly underlying?: string;
    /** Wrapper rate, when wrapping is supported. */
    readonly rate?: string;
}
export interface GhostKeyConfig {
    readonly chainId: number;
    readonly rpcUrl: string;
    readonly moduleAddress: string;
    readonly tokens: readonly TokenEntry[];
    /** Overrides the ACL address the relayer SDK ships. Rarely needed. */
    readonly aclAddress?: string;
    readonly devUnlock?: boolean;
    /** Where the vault keystore lives. Defaults to ~/.ghostkey/vault. */
    readonly vaultDir?: string;
}
export declare const DEFAULT_CONFIG_PATH: string;
export declare function loadConfig(file?: string): Promise<GhostKeyConfig>;
export declare function saveConfig(config: GhostKeyConfig, file?: string): Promise<void>;
/** Formats a base-unit amount for display. Never used on an undisclosed value. */
export declare function formatAmount(base: bigint, decimals: number): string;
/** Parses a user-typed amount into base units. Rejects anything ambiguous. */
export declare function parseAmount(input: string, decimals: number): bigint;
