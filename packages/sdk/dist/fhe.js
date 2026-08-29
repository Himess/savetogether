"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEPOLIA_ACL_ADDRESS = void 0;
exports.withRetry = withRetry;
exports.isTransient = isTransient;
exports.createFhevm = createFhevm;
exports.warmInput = warmInput;
exports.encryptMany = encryptMany;
exports.userDecrypt = userDecrypt;
exports.delegatedUserDecrypt = delegatedUserDecrypt;
exports.userDecryptBool = userDecryptBool;
const node_1 = require("@zama-fhe/relayer-sdk/node");
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
async function withRetry(label, fn, opts = {}) {
    const attempts = opts.attempts ?? 4;
    const baseMs = opts.baseMs ?? 1000;
    let last;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        }
        catch (err) {
            last = err;
            if (!isTransient(err) || i === attempts - 1) {
                // Annotate rather than wrap: the caller may be matching on the error
                // type, and knowing it was retried four times over eight seconds is the
                // difference between "the relayer is flaky" and "the relayer is down".
                if (isTransient(err) && i > 0 && err instanceof Error) {
                    err.message = `${err.message} [${label}: gave up after ${i + 1} attempts]`;
                }
                throw err;
            }
            opts.onRetry?.(i + 1, err);
            await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
        }
    }
    throw last;
}
/** Substrings that identify a connection problem rather than a rejected request. */
const TRANSIENT = [
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ENOTFOUND",
    "EPIPE",
    "socket hang up",
    "fetch failed",
    "network error",
    "SERVER_ERROR",
    "TIMEOUT",
    "status: 429",
    "status: 502",
    "status: 503",
    "status: 504",
];
/** @internal exported for the tests that pin the transient/permanent split. */
function isTransient(err) {
    const e = err;
    const haystack = `${e?.code ?? ""} ${e?.cause?.code ?? ""} ${e?.message ?? ""}`;
    return TRANSIENT.some((t) => haystack.includes(t));
}
/** Creates the relayer instance for Sepolia. */
async function createFhevm(rpcUrl) {
    return (await (0, node_1.createInstance)({ ...node_1.SepoliaConfig, network: rpcUrl }));
}
exports.SEPOLIA_ACL_ADDRESS = node_1.SepoliaConfig.aclContractAddress;
/** Hex-encodes what the relayer SDK hands back as bytes. */
function hex(u) {
    if (typeof u === "string")
        return u;
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
function warmInput(instance, contractAddress, userAddress, value) {
    let aborted = false;
    const ready = (async () => {
        const enc = await withRetry("encrypt", () => instance.createEncryptedInput(contractAddress, userAddress).add64(value).encrypt());
        const handle = enc.handles[0];
        if (handle === undefined)
            throw new Error("relayer returned no handle for the encrypted input");
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
async function encryptMany(instance, contractAddress, userAddress, values) {
    let builder = instance.createEncryptedInput(contractAddress, userAddress);
    for (const v of values)
        builder = builder.add64(v);
    const enc = await withRetry("encrypt-many", () => builder.encrypt());
    return { handles: enc.handles.map(hex), inputProof: hex(enc.inputProof) };
}
/** ethers rejects an explicit EIP712Domain entry, so the primary type is isolated. */
async function signPayload(signer, payload) {
    const primary = payload.primaryType ?? Object.keys(payload.types).find((t) => t !== "EIP712Domain");
    if (primary === undefined)
        throw new Error("EIP-712 payload has no primary type");
    const entry = payload.types[primary];
    if (entry === undefined)
        throw new Error(`EIP-712 payload has no type named ${primary}`);
    return signer.signTypedData(payload.domain, { [primary]: entry }, payload.message);
}
/** Decrypts a handle the signer is directly allowed on. */
async function userDecrypt(instance, signer, handle, contractAddress) {
    const kp = instance.generateKeypair();
    const start = Math.floor(Date.now() / 1000);
    const sig = await signPayload(signer, instance.createEIP712(kp.publicKey, [contractAddress], start, 1));
    const address = await signer.getAddress();
    const res = await withRetry("user-decrypt", () => instance.userDecrypt([{ handle, contractAddress }], kp.privateKey, kp.publicKey, sig, [contractAddress], address, start, 1));
    return toBigInt(res[handle]);
}
/**
 * Decrypts a handle owned by `delegator`, using the delegate's OWN signature.
 *
 * This is the mechanism verified live in step 1 (A6). The delegator signs
 * nothing here — its address travels as data, and the ACL delegation is what
 * authorises the read.
 */
async function delegatedUserDecrypt(instance, delegate, delegator, handle, contractAddress) {
    const kp = instance.generateKeypair();
    const start = Math.floor(Date.now() / 1000);
    const sig = await signPayload(delegate, instance.createDelegatedUserDecryptEIP712(kp.publicKey, [contractAddress], delegator, start, 1));
    const delegateAddress = await delegate.getAddress();
    const res = await withRetry("delegated-user-decrypt", () => instance.delegatedUserDecrypt([{ handle, contractAddress }], kp.privateKey, kp.publicKey, sig, [contractAddress], delegator, delegateAddress, start, 1));
    return toBigInt(res[handle]);
}
/** `within` is an ebool: a different decrypt path from the euint64 handles. */
async function userDecryptBool(instance, signer, handle, contractAddress) {
    const kp = instance.generateKeypair();
    const start = Math.floor(Date.now() / 1000);
    const sig = await signPayload(signer, instance.createEIP712(kp.publicKey, [contractAddress], start, 1));
    const boolAddress = await signer.getAddress();
    const res = await withRetry("user-decrypt-bool", () => instance.userDecrypt([{ handle, contractAddress }], kp.privateKey, kp.publicKey, sig, [contractAddress], boolAddress, start, 1));
    const v = res[handle];
    return v === true || v === 1n || v === "true" || v === "1";
}
function toBigInt(v) {
    if (typeof v === "bigint")
        return v;
    if (typeof v === "boolean")
        return v ? 1n : 0n;
    if (typeof v === "string")
        return BigInt(v);
    throw new Error("relayer returned no value for the requested handle");
}
//# sourceMappingURL=fhe.js.map