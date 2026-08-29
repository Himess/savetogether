import { HDNodeWallet, Wallet } from "ethers";
export interface StoredSessionKey {
    readonly address: string;
    readonly label: string;
    readonly createdAt: string;
    readonly file: string;
}
export interface SessionKeystore {
    /** Generates a key, encrypts it, stores the passphrase. Returns only the address. */
    create(label: string): Promise<string>;
    /** Decrypts into an in-memory wallet. The plaintext key never touches disk. */
    load(address: string): Promise<Wallet>;
    list(): Promise<readonly StoredSessionKey[]>;
    destroy(address: string): Promise<void>;
}
/** Default keystore: Web3 Secret Storage v3 on disk, passphrase in the OS keychain. */
export declare function osKeychainKeystore(opts?: {
    dir?: string;
    service?: string;
}): SessionKeystore;
/**
 * In-memory keystore for tests and ephemeral runs. Nothing is persisted, so a
 * process restart loses every session — which is the correct behaviour for a
 * test fixture and the wrong behaviour for a product.
 */
export declare function memoryKeystore(): SessionKeystore;
/** @internal Re-exported so the MCP layer can reuse the same wallet type. */
export type { HDNodeWallet };
