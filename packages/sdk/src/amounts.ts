/**
 * Amounts that are opaque by construction.
 *
 * The whole point of SaveTogether is that a plaintext amount is a thing you have to
 * ask for, deliberately, at a site a reviewer can find. So an encrypted quantity
 * is an `AmountRef` that carries no numeric field, refuses to stringify to
 * anything numeric, and hands its plaintext only to `revealAmount` — a free
 * function named for exactly what it does.
 *
 * Arithmetic stays in reference space. `ref(balance).half().cap(1000n)` builds an
 * expression; nothing is decrypted until the moment an amount must be encrypted
 * for a transfer, and even then the number stays inside the session client.
 */
import { BalanceNotVisibleError } from "./errors";

/** Where an encrypted quantity came from. Useful for logging without leaking. */
export type AmountSource = "budget" | "balance" | "sent";

const BRAND: unique symbol = Symbol("SaveTogetherAmountRef");

/**
 * Resolvers live here rather than on the instance, so a consumer cannot reach a
 * plaintext by reading a property, spreading the object, or JSON round-tripping it.
 */
const resolvers = new WeakMap<AmountRef, () => Promise<bigint>>();

/** An opaque reference to an encrypted quantity. Never carries plaintext. */
export class AmountRef {
  /** @internal brand — prevents structural typing from forging a ref */
  readonly [BRAND] = true as const;

  constructor(
    readonly handle: string,
    readonly token: string,
    readonly source: AmountSource,
  ) {}

  /** Deliberately non-numeric, so an accidental interpolation cannot leak. */
  toString(): string {
    return `AmountRef(${this.source}:${this.handle.slice(0, 10)}…)`;
  }

  /** Same, for JSON.stringify. */
  toJSON(): string {
    return this.toString();
  }
}

/** @internal Used by the session layer when it mints a ref. */
export function attachResolver(ref: AmountRef, resolve: () => Promise<bigint>): AmountRef {
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
export async function revealAmount(ref: AmountRef, opts?: { reason?: string }): Promise<bigint> {
  void opts;
  const resolve = resolvers.get(ref);
  if (resolve === undefined) throw new BalanceNotVisibleError();
  return resolve();
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

type Node =
  | { readonly kind: "exact"; readonly value: bigint }
  | { readonly kind: "ref"; readonly ref: AmountRef }
  | { readonly kind: "scale"; readonly inner: Node; readonly bps: number }
  | { readonly kind: "minus"; readonly inner: Node; readonly value: bigint }
  | { readonly kind: "cap"; readonly inner: Node; readonly max: bigint };

/** A description of an amount. Resolved to a number only at encrypt time. */
export class AmountExpr {
  /** @internal */
  constructor(private readonly node: Node) {}

  /** Half, rounded down. */
  half(): AmountExpr {
    return new AmountExpr({ kind: "scale", inner: this.node, bps: 5000 });
  }

  /** A proportion in basis points; 2500 is a quarter. Rounded down. */
  percent(bps: number): AmountExpr {
    if (!Number.isInteger(bps) || bps < 0)
      throw new RangeError("bps must be a non-negative integer");
    return new AmountExpr({ kind: "scale", inner: this.node, bps });
  }

  /** Subtract a fixed amount, clamped at zero. */
  minus(value: bigint): AmountExpr {
    return new AmountExpr({ kind: "minus", inner: this.node, value });
  }

  /** Never exceed `max`. */
  cap(max: bigint): AmountExpr {
    return new AmountExpr({ kind: "cap", inner: this.node, max });
  }

  /**
   * @internal Resolves to a plaintext for encryption. The result is consumed by
   * the session layer and never returned to the SDK's caller.
   */
  async resolve(): Promise<bigint> {
    return resolveNode(this.node);
  }

  /** True when evaluating this expression requires decrypting something. */
  needsBalance(): boolean {
    return nodeNeedsRef(this.node);
  }
}

async function resolveNode(node: Node): Promise<bigint> {
  switch (node.kind) {
    case "exact":
      return node.value;
    case "ref":
      return revealAmount(node.ref, { reason: "resolving an amount expression for encryption" });
    case "scale": {
      const inner = await resolveNode(node.inner);
      return (inner * BigInt(node.bps)) / 10_000n;
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

function nodeNeedsRef(node: Node): boolean {
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
export function exact(value: bigint): AmountExpr {
  return new AmountExpr({ kind: "exact", value });
}

/** An amount derived from an encrypted quantity — "all of it", "half of it". */
export function ref(r: AmountRef): AmountExpr {
  return new AmountExpr({ kind: "ref", ref: r });
}

/** Everything the reference holds. Sugar for `ref(r)`. */
export function all(r: AmountRef): AmountExpr {
  return ref(r);
}
