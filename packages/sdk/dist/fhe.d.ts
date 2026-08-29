/**
 * The FHE layer: encrypted inputs, decryption, and proof warming.
 *
 * PROOF WARMING IS THE POINT OF THIS FILE. Step 1 measured a 29s median for one
 * confidential transfer end to end, and 12.5s of that — with near-zero variance,
 * so it is compute rather than network — is client-side ZK proof generation that
 * happens *before any transaction exists*. It can be started the moment the
 * user's intent is legible and awaited later. Retrofitting that is much harder
 * than designing for it, so `warmInput` is a first-class part of the surface
 * rather than an optimisation bolted on afterwards.
 */
import type { Signer } from "ethers";
/**
 * Retries a transport failure with exponential backoff.
 *
 * The Zama relayer drops connections. This is measured, not hypothetical: a
 * 60-sample gate run died on its fifth send with `UND_ERR_CONNECT_TIMEOUT`. A
 * session client that dies on one of those is unusable, and a demo recorded in
 * real time cannot be re-cut around it.
 *
 * ONLY transport failures are retried. A revert, a rejected proof, or a failed
 * assertion must surface immediately — retrying those would turn a clear error
 * into a slow one, and could resubmit something that already had an effect.
 */
export declare function withRetry<T>(label: string, fn: () => Promise<T>, opts?: {
    attempts?: number;
    baseMs?: number;
    onRetry?: (attempt: number, error: unknown) => void;
}): Promise<T>;
/** @internal exported for the tests that pin the transient/permanent split. */
export declare function isTransient(err: unknown): boolean;
/** Minimal shape of the relayer SDK instance the SDK depends on. */
export interface FhevmInstance {
    createEncryptedInput(contractAddress: string, userAddress: string): {
        add64(value: bigint): {
            encrypt(): Promise<{
                handles: Uint8Array[];
                inputProof: Uint8Array;
            }>;
        };
    };
    generateKeypair(): {
        publicKey: string;
        privateKey: string;
    };
    createEIP712(publicKey: string, contractAddresses: string[], startTimestamp: number, durationDays: number): Eip712Payload;
    createDelegatedUserDecryptEIP712(publicKey: string, contractAddresses: string[], delegatorAddress: string, startTimestamp: number, durationDays: number): Eip712Payload;
    userDecrypt(handles: {
        handle: string;
        contractAddress: string;
    }[], privateKey: string, publicKey: string, signature: string, contractAddresses: string[], userAddress: string, startTimestamp: number, durationDays: number): Promise<Record<string, string | bigint | boolean>>;
    delegatedUserDecrypt(handles: {
        handle: string;
        contractAddress: string;
    }[], privateKey: string, publicKey: string, signature: string, contractAddresses: string[], delegatorAddress: string, delegateAddress: string, startTimestamp: number, durationDays: number): Promise<Record<string, string | bigint | boolean>>;
}
export interface Eip712Payload {
    readonly domain: Record<string, unknown>;
    readonly types: Record<string, ReadonlyArray<{
        name: string;
        type: string;
    }>>;
    readonly primaryType?: string;
    readonly message: Record<string, unknown>;
}
/** An encrypted input whose proof may still be generating. */
export interface WarmInput {
    /** Settles when the proof exists and is registered with the relayer. */
    readonly ready: Promise<{
        handle: string;
        inputProof: string;
    }>;
    /** Discards it. Nothing is submitted; the in-flight work is simply not awaited. */
    abort(): void;
}
/** Creates the relayer instance for Sepolia. */
export declare function createFhevm(rpcUrl: string): Promise<FhevmInstance>;
export declare const SEPOLIA_ACL_ADDRESS: string;
/**
 * Starts encryption and proof generation immediately and returns a handle to it.
 *
 * Call this the moment the token, the recipient and the amount are known — which
 * in a conversation is well before the user confirms — and await `ready` when the
 * transaction is actually going out. On the measurements in `findings.md` this is
 * worth about twelve seconds of perceived latency per send.
 */
export declare function warmInput(instance: FhevmInstance, contractAddress: string, userAddress: string, value: bigint): WarmInput;
/** Encrypts several values under ONE proof — what keeps a multi-token open to one signature. */
export declare function encryptMany(instance: FhevmInstance, contractAddress: string, userAddress: string, values: readonly bigint[]): Promise<{
    handles: string[];
    inputProof: string;
}>;
/** Decrypts a handle the signer is directly allowed on. */
export declare function userDecrypt(instance: FhevmInstance, signer: Signer, handle: string, contractAddress: string): Promise<bigint>;
/**
 * Decrypts a handle owned by `delegator`, using the delegate's OWN signature.
 *
 * This is the mechanism verified live in step 1 (A6). The delegator signs
 * nothing here — its address travels as data, and the ACL delegation is what
 * authorises the read.
 */
export declare function delegatedUserDecrypt(instance: FhevmInstance, delegate: Signer, delegator: string, handle: string, contractAddress: string): Promise<bigint>;
/** `within` is an ebool: a different decrypt path from the euint64 handles. */
export declare function userDecryptBool(instance: FhevmInstance, signer: Signer, handle: string, contractAddress: string): Promise<boolean>;
