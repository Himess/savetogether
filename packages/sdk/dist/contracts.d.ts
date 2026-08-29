/**
 * Typed facades over ethers' dynamic `Contract`.
 *
 * `Contract` exposes its methods through an index signature, which under
 * `noUncheckedIndexedAccess` types every call as possibly-undefined. Rather than
 * sprinkle non-null assertions across the call sites, the surface each contract
 * actually offers is declared once, here, and the `Contract` is cast to it. That
 * also makes this file the single place where the SDK's assumptions about the
 * on-chain ABI are written down.
 */
import { type Interface, type Provider, type Signer, type TransactionResponse } from "ethers";
/** Plaintext session tuple as `sessionOf` returns it. */
export type SessionTuple = [owner: string, expiry: bigint, maxTxCount: bigint, txCount: bigint];
export interface GhostKeyContract {
    readonly interface: Interface;
    readonly target: string;
    connect(runner: Signer | Provider): GhostKeyContract;
    sessionOf(sessionKey: string): Promise<SessionTuple>;
    remainingOf(sessionKey: string, token: string): Promise<string>;
    isRecipientAllowed(sessionKey: string, to: string): Promise<boolean>;
    recipientsOf(sessionKey: string): Promise<string[]>;
    tokensOf(sessionKey: string): Promise<string[]>;
    protocolStatus(sessionKey: string): Promise<[aclPaused: boolean, keyDenied: boolean, moduleDenied: boolean]>;
    openSessionDigest(owner: string, sessionKey: string, expiry: number, maxTxCount: number): Promise<string>;
    send(token: string, to: string, encAmount: string, inputProof: string): Promise<TransactionResponse>;
    increaseBudget(sessionKey: string, token: string, encAmount: string, inputProof: string): Promise<TransactionResponse>;
    addRecipient(sessionKey: string, to: string): Promise<TransactionResponse>;
    removeRecipient(sessionKey: string, to: string): Promise<TransactionResponse>;
    closeSession(sessionKey: string): Promise<TransactionResponse>;
}
export interface Erc7984Contract {
    readonly interface: Interface;
    connect(runner: Signer | Provider): Erc7984Contract;
    name(): Promise<string>;
    symbol(): Promise<string>;
    decimals(): Promise<bigint>;
    confidentialBalanceOf(account: string): Promise<string>;
    isOperator(holder: string, spender: string): Promise<boolean>;
    setOperator(operator: string, until: number): Promise<TransactionResponse>;
}
export interface AclContract {
    readonly interface: Interface;
    connect(runner: Signer | Provider): AclContract;
    delegateForUserDecryption(delegate: string, contractAddress: string, expirationDate: number): Promise<TransactionResponse>;
    revokeDelegationForUserDecryption(delegate: string, contractAddress: string): Promise<TransactionResponse>;
    getUserDecryptionDelegationExpirationDate(delegator: string, delegate: string, contractAddress: string): Promise<bigint>;
    multicall(data: readonly string[]): Promise<TransactionResponse>;
}
export declare function ghostKey(address: string, runner: Signer | Provider): GhostKeyContract;
export declare function erc7984(address: string, runner: Signer | Provider): Erc7984Contract;
export declare function acl(address: string, runner: Signer | Provider): AclContract;
