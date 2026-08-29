/** Where an encrypted quantity came from. Useful for logging without leaking. */
export type AmountSource = "budget" | "balance" | "sent";
declare const BRAND: unique symbol;
/** An opaque reference to an encrypted quantity. Never carries plaintext. */
export declare class AmountRef {
    readonly handle: string;
    readonly token: string;
    readonly source: AmountSource;
    /** @internal brand — prevents structural typing from forging a ref */
    readonly [BRAND]: true;
    constructor(handle: string, token: string, source: AmountSource);
    /** Deliberately non-numeric, so an accidental interpolation cannot leak. */
    toString(): string;
    /** Same, for JSON.stringify. */
    toJSON(): string;
}
/** @internal Used by the session layer when it mints a ref. */
export declare function attachResolver(ref: AmountRef, resolve: () => Promise<bigint>): AmountRef;
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
export declare function revealAmount(ref: AmountRef, opts?: {
    reason?: string;
}): Promise<bigint>;
type Node = {
    readonly kind: "exact";
    readonly value: bigint;
} | {
    readonly kind: "ref";
    readonly ref: AmountRef;
} | {
    readonly kind: "scale";
    readonly inner: Node;
    readonly bps: number;
} | {
    readonly kind: "minus";
    readonly inner: Node;
    readonly value: bigint;
} | {
    readonly kind: "cap";
    readonly inner: Node;
    readonly max: bigint;
};
/** A description of an amount. Resolved to a number only at encrypt time. */
export declare class AmountExpr {
    private readonly node;
    /** @internal */
    constructor(node: Node);
    /** Half, rounded down. */
    half(): AmountExpr;
    /** A proportion in basis points; 2500 is a quarter. Rounded down. */
    percent(bps: number): AmountExpr;
    /** Subtract a fixed amount, clamped at zero. */
    minus(value: bigint): AmountExpr;
    /** Never exceed `max`. */
    cap(max: bigint): AmountExpr;
    /**
     * @internal Resolves to a plaintext for encryption. The result is consumed by
     * the session layer and never returned to the SDK's caller.
     */
    resolve(): Promise<bigint>;
    /** True when evaluating this expression requires decrypting something. */
    needsBalance(): boolean;
}
/** An amount the caller already knows in plaintext. */
export declare function exact(value: bigint): AmountExpr;
/** An amount derived from an encrypted quantity — "all of it", "half of it". */
export declare function ref(r: AmountRef): AmountExpr;
/** Everything the reference holds. Sugar for `ref(r)`. */
export declare function all(r: AmountRef): AmountExpr;
export {};
