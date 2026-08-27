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
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";

/** Minimal shape of the relayer SDK instance the SDK depends on. */
export interface FhevmInstance {
  createEncryptedInput(
    contractAddress: string,
    userAddress: string,
  ): {
    add64(value: bigint): { encrypt(): Promise<{ handles: Uint8Array[]; inputProof: Uint8Array }> };
  };
  generateKeypair(): { publicKey: string; privateKey: string };
  createEIP712(
    publicKey: string,
    contractAddresses: string[],
    startTimestamp: number,
    durationDays: number,
  ): Eip712Payload;
  createDelegatedUserDecryptEIP712(
    publicKey: string,
    contractAddresses: string[],
    delegatorAddress: string,
    startTimestamp: number,
    durationDays: number,
  ): Eip712Payload;
  userDecrypt(
    handles: { handle: string; contractAddress: string }[],
    privateKey: string,
    publicKey: string,
    signature: string,
    contractAddresses: string[],
    userAddress: string,
    startTimestamp: number,
    durationDays: number,
  ): Promise<Record<string, string | bigint | boolean>>;
  delegatedUserDecrypt(
    handles: { handle: string; contractAddress: string }[],
    privateKey: string,
    publicKey: string,
    signature: string,
    contractAddresses: string[],
    delegatorAddress: string,
    delegateAddress: string,
    startTimestamp: number,
    durationDays: number,
  ): Promise<Record<string, string | bigint | boolean>>;
}

export interface Eip712Payload {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  readonly primaryType?: string;
  readonly message: Record<string, unknown>;
}

/** An encrypted input whose proof may still be generating. */
export interface WarmInput {
  /** Settles when the proof exists and is registered with the relayer. */
  readonly ready: Promise<{ handle: string; inputProof: string }>;
  /** Discards it. Nothing is submitted; the in-flight work is simply not awaited. */
  abort(): void;
}

/** Creates the relayer instance for Sepolia. */
export async function createFhevm(rpcUrl: string): Promise<FhevmInstance> {
  return (await createInstance({ ...SepoliaConfig, network: rpcUrl })) as unknown as FhevmInstance;
}

export const SEPOLIA_ACL_ADDRESS = SepoliaConfig.aclContractAddress;

/** Hex-encodes what the relayer SDK hands back as bytes. */
function hex(u: Uint8Array | string): string {
  if (typeof u === "string") return u;
  return `0x${Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Starts encryption and proof generation immediately and returns a handle to it.
 *
 * Call this the moment the token, the recipient and the amount are known — which
 * in a conversation is well before the user confirms — and await `ready` when the
 * transaction is actually going out. On the measurements in `findings.md` this is
 * worth about twelve seconds of perceived latency per send.
 */
export function warmInput(
  instance: FhevmInstance,
  contractAddress: string,
  userAddress: string,
  value: bigint,
): WarmInput {
  let aborted = false;
  const ready = (async () => {
    const enc = await instance
      .createEncryptedInput(contractAddress, userAddress)
      .add64(value)
      .encrypt();
    const handle = enc.handles[0];
    if (handle === undefined) throw new Error("relayer returned no handle for the encrypted input");
    return { handle: hex(handle), inputProof: hex(enc.inputProof) };
  })();
  // Swallow rejections on an aborted input so it cannot surface as an unhandled
  // rejection after the caller has already moved on.
  ready.catch(() => undefined);
  return {
    ready,
    abort() {
      aborted = true;
      void aborted;
    },
  };
}

/** Encrypts several values under ONE proof — what keeps a multi-token open to one signature. */
export async function encryptMany(
  instance: FhevmInstance,
  contractAddress: string,
  userAddress: string,
  values: readonly bigint[],
): Promise<{ handles: string[]; inputProof: string }> {
  let builder = instance.createEncryptedInput(contractAddress, userAddress) as unknown as {
    add64(v: bigint): typeof builder;
    encrypt(): Promise<{ handles: Uint8Array[]; inputProof: Uint8Array }>;
  };
  for (const v of values) builder = builder.add64(v);
  const enc = await builder.encrypt();
  return { handles: enc.handles.map(hex), inputProof: hex(enc.inputProof) };
}

/** ethers rejects an explicit EIP712Domain entry, so the primary type is isolated. */
async function signPayload(signer: Signer, payload: Eip712Payload): Promise<string> {
  const primary =
    payload.primaryType ?? Object.keys(payload.types).find((t) => t !== "EIP712Domain");
  if (primary === undefined) throw new Error("EIP-712 payload has no primary type");
  const entry = payload.types[primary];
  if (entry === undefined) throw new Error(`EIP-712 payload has no type named ${primary}`);
  return signer.signTypedData(
    payload.domain,
    { [primary]: entry as { name: string; type: string }[] },
    payload.message,
  );
}

/** Decrypts a handle the signer is directly allowed on. */
export async function userDecrypt(
  instance: FhevmInstance,
  signer: Signer,
  handle: string,
  contractAddress: string,
): Promise<bigint> {
  const kp = instance.generateKeypair();
  const start = Math.floor(Date.now() / 1000);
  const sig = await signPayload(
    signer,
    instance.createEIP712(kp.publicKey, [contractAddress], start, 1),
  );
  const res = await instance.userDecrypt(
    [{ handle, contractAddress }],
    kp.privateKey,
    kp.publicKey,
    sig,
    [contractAddress],
    await signer.getAddress(),
    start,
    1,
  );
  return toBigInt(res[handle]);
}

/**
 * Decrypts a handle owned by `delegator`, using the delegate's OWN signature.
 *
 * This is the mechanism verified live in step 1 (A6). The delegator signs
 * nothing here — its address travels as data, and the ACL delegation is what
 * authorises the read.
 */
export async function delegatedUserDecrypt(
  instance: FhevmInstance,
  delegate: Signer,
  delegator: string,
  handle: string,
  contractAddress: string,
): Promise<bigint> {
  const kp = instance.generateKeypair();
  const start = Math.floor(Date.now() / 1000);
  const sig = await signPayload(
    delegate,
    instance.createDelegatedUserDecryptEIP712(kp.publicKey, [contractAddress], delegator, start, 1),
  );
  const res = await instance.delegatedUserDecrypt(
    [{ handle, contractAddress }],
    kp.privateKey,
    kp.publicKey,
    sig,
    [contractAddress],
    delegator,
    await delegate.getAddress(),
    start,
    1,
  );
  return toBigInt(res[handle]);
}

/** `within` is an ebool: a different decrypt path from the euint64 handles. */
export async function userDecryptBool(
  instance: FhevmInstance,
  signer: Signer,
  handle: string,
  contractAddress: string,
): Promise<boolean> {
  const kp = instance.generateKeypair();
  const start = Math.floor(Date.now() / 1000);
  const sig = await signPayload(
    signer,
    instance.createEIP712(kp.publicKey, [contractAddress], start, 1),
  );
  const res = await instance.userDecrypt(
    [{ handle, contractAddress }],
    kp.privateKey,
    kp.publicKey,
    sig,
    [contractAddress],
    await signer.getAddress(),
    start,
    1,
  );
  const v = res[handle];
  return v === true || v === 1n || v === "true" || v === "1";
}

function toBigInt(v: string | bigint | boolean | undefined): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1n : 0n;
  if (typeof v === "string") return BigInt(v);
  throw new Error("relayer returned no value for the requested handle");
}
