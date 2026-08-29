"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AmountExpr = exports.AmountRef = void 0;
exports.attachResolver = attachResolver;
exports.revealAmount = revealAmount;
exports.exact = exact;
exports.ref = ref;
exports.all = all;
/**
 * Amounts that are opaque by construction.
 *
 * The whole point of GhostKey is that a plaintext amount is a thing you have to
 * ask for, deliberately, at a site a reviewer can find. So an encrypted quantity
 * is an `AmountRef` that carries no numeric field, refuses to stringify to
 * anything numeric, and hands its plaintext only to `revealAmount` — a free
 * function named for exactly what it does.
 *
 * Arithmetic stays in reference space. `ref(balance).half().cap(1000n)` builds an
 * expression; nothing is decrypted until the moment an amount must be encrypted
 * for a transfer, and even then the number stays inside the session client.
 */
const errors_1 = require("./errors");
const BRAND = Symbol("GhostKeyAmountRef");
/**
 * Resolvers live here rather than on the instance, so a consumer cannot reach a
 * plaintext by reading a property, spreading the object, or JSON round-tripping it.
 */
const resolvers = new WeakMap();
/** An opaque reference to an encrypted quantity. Never carries plaintext. */
class AmountRef {
    handle;
    token;
    source;
    /** @internal brand — prevents structural typing from forging a ref */
    [BRAND] = true;
    constructor(handle, token, source) {
        this.handle = handle;
        this.token = token;
        this.source = source;
    }
    /** Deliberately non-numeric, so an accidental interpolation cannot leak. */
    toString() {
        return `AmountRef(${this.source}:${this.handle.slice(0, 10)}…)`;
    }
    /** Same, for JSON.stringify. */
    toJSON() {
        return this.toString();
    }
}
exports.AmountRef = AmountRef;
/** @internal Used by the session layer when it mints a ref. */
function attachResolver(ref, resolve) {
    resolvers.set(ref, resolve);
    return ref;
}
/**
 * The ONLY path from a reference to a number.
 *
 * Named for what it does and requiring a stated reason, so that revealing a
 * plaintext is always a deliberate, greppable call rather than a default, a
 * property access, or a stray template literal.
 *
 * @param ref The reference to decrypt.
 * @param opts.reason Why the plaintext is needed. Recorded by callers that log.
 */
async function revealAmount(ref, opts) {
    void opts;
    const resolve = resolvers.get(ref);
    if (resolve === undefined)
        throw new errors_1.BalanceNotVisibleError();
    return resolve();
}
/** A description of an amount. Resolved to a number only at encrypt time. */
class AmountExpr {
    node;
    /** @internal */
    constructor(node) {
        this.node = node;
    }
    /** Half, rounded down. */
    half() {
        return new AmountExpr({ kind: "scale", inner: this.node, bps: 5000 });
    }
    /** A proportion in basis points; 2500 is a quarter. Rounded down. */
    percent(bps) {
        if (!Number.isInteger(bps) || bps < 0)
            throw new RangeError("bps must be a non-negative integer");
        return new AmountExpr({ kind: "scale", inner: this.node, bps });
    }
    /** Subtract a fixed amount, clamped at zero. */
    minus(value) {
        return new AmountExpr({ kind: "minus", inner: this.node, value });
    }
    /** Never exceed `max`. */
    cap(max) {
        return new AmountExpr({ kind: "cap", inner: this.node, max });
    }
    /**
     * @internal Resolves to a plaintext for encryption. The result is consumed by
     * the session layer and never returned to the SDK's caller.
     */
    async resolve() {
        return resolveNode(this.node);
    }
    /** True when evaluating this expression requires decrypting something. */
    needsBalance() {
        return nodeNeedsRef(this.node);
    }
}
exports.AmountExpr = AmountExpr;
async function resolveNode(node) {
    switch (node.kind) {
        case "exact":
            return node.value;
        case "ref":
            return revealAmount(node.ref, { reason: "resolving an amount expression for encryption" });
        case "scale": {
            const inner = await resolveNode(node.inner);
            return (inner * BigInt(node.bps)) / 10000n;
        }
        case "minus": {
            const inner = await resolveNode(node.inner);
            return inner > node.value ? inner - node.value : 0n;
        }
        case "cap": {
            const inner = await resolveNode(node.inner);
            return inner > node.max ? node.max : inner;
        }
    }
}
function nodeNeedsRef(node) {
    switch (node.kind) {
        case "exact":
            return false;
        case "ref":
            return true;
        case "scale":
        case "minus":
        case "cap":
            return nodeNeedsRef(node.inner);
    }
}
/** An amount the caller already knows in plaintext. */
function exact(value) {
    return new AmountExpr({ kind: "exact", value });
}
/** An amount derived from an encrypted quantity — "all of it", "half of it". */
function ref(r) {
    return new AmountExpr({ kind: "ref", ref: r });
}
/** Everything the reference holds. Sugar for `ref(r)`. */
function all(r) {
    return ref(r);
}
//# sourceMappingURL=amounts.js.map