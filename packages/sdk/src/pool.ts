import { Contract, type Signer } from "ethers";
import { AmountExpr, AmountRef, attachResolver } from "./amounts";
import { type FhevmInstance, userDecrypt, warmInput, withRetry } from "./fhe";

/**
 * The prize pool, as the session client sees it.
 *
 * The session key is the participant. The owner funds it through the module's
 * budget-bounded `send`, so what can reach the pool is bounded by the encrypted
 * budget rather than by the model's restraint — and the position, the winnings
 * and the pending credit all belong to an address the model can act for but
 * cannot drain.
 *
 * Amounts are `AmountExpr` throughout, never numbers. "Half my balance" resolves
 * here, inside the session client: the plaintext exists for the moment it takes
 * to encrypt an input and is never returned to the caller. A tool that accepted
 * a number instead would force the model to read the balance first, and the
 * balance would be in its context forever after — which is the claim collapsing,
 * not a bug in a tool.
 */

const POOL_ABI = [
  "function deposit(bytes32 encAmount, bytes inputProof)",
  "function withdraw(bytes32 encAmount, bytes inputProof)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function winningsOf(address) view returns (bytes32)",
  "function pendingOf(address) view returns (bytes32)",
  "function drawCount() view returns (uint32)",
  // Tiers. `prize()` was removed when the pool grew them, and reading it against
  // the tiered contract comes back as a bare "missing revert data" — the SDK
  // asking for a function that is not there looks exactly like an RPC fault.
  "function TIERS() view returns (uint8)",
  "function tierPrize(uint256) view returns (uint64)",
  "function tierK(uint256) view returns (uint128)",
  "function asset() view returns (address)",
  "function drawAt(uint32) view returns (tuple(uint40 periodStart, uint40 snapshotAt, uint8 status, bytes32 encR, bytes32 encTotalWeight, uint64 r, uint128 totalWeight))",
];

const MOCK_TOKEN_ABI = [
  "function mint(address to, uint64 amount) returns (bytes32)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function setOperator(address operator, uint48 until)",
];

export interface PoolPosition {
  readonly inPool: AmountRef;
  readonly won: AmountRef;
  readonly pending: AmountRef;
}

export interface PoolStatus {
  readonly round: number;
  readonly state: "none" | "open" | "revealed";
  /** The grand prize — the largest, and the one the reserve must be able to cover. */
  readonly prize: bigint;
  /** Every tier, largest first, with how often each is expected to be won. */
  readonly tiers: readonly { prize: bigint; everyNDraws: bigint }[];
  readonly snapshotAt: number;
  readonly randomness: bigint;
}

export interface PoolContext {
  readonly fhevm: FhevmInstance;
  readonly sessionKey: Signer;
  readonly sessionKeyAddress: string;
  readonly poolAddress: string;
  readonly tokenAddress: string;
}

const STATES = ["none", "open", "revealed"] as const;

export class PoolClient {
  constructor(private readonly ctx: PoolContext) {}

  private get pool(): Contract {
    return new Contract(this.ctx.poolAddress, POOL_ABI, this.ctx.sessionKey);
  }

  private get token(): Contract {
    return new Contract(this.ctx.tokenAddress, MOCK_TOKEN_ABI, this.ctx.sessionKey);
  }

  /** Public facts about the round. Nothing here is anybody's secret. */
  async status(): Promise<PoolStatus> {
    const pool = this.pool;
    const round = Number(await pool.drawCount!());
    const count = Number(await pool.TIERS!());
    const tiers: { prize: bigint; everyNDraws: bigint }[] = [];
    for (let t = 0; t < count; t++) {
      tiers.push({
        prize: BigInt(await pool.tierPrize!(t)),
        everyNDraws: BigInt(await pool.tierK!(t)),
      });
    }
    const prize = tiers[0]?.prize ?? 0n;
    if (round === 0) {
      return { round: 0, state: "none", prize, tiers, snapshotAt: 0, randomness: 0n };
    }
    const d = await pool.drawAt!(round);
    return {
      round,
      state: STATES[Number(d.status)] ?? "none",
      prize,
      tiers,
      snapshotAt: Number(d.snapshotAt),
      randomness: BigInt(d.r),
    };
  }

  /**
   * The position, as references.
   *
   * Three separate numbers rather than one, because they are three different
   * facts: what is earning weight in the next draw, what has ever been won, and
   * what is won but not yet compounded. Adding them together would misstate the
   * odds.
   */
  async position(): Promise<PoolPosition> {
    const pool = this.pool;
    const me = this.ctx.sessionKeyAddress;
    const mk = async (handle: string, source: "balance" | "sent"): Promise<AmountRef> => {
      const r = new AmountRef(handle, this.ctx.tokenAddress, source);
      return attachResolver(r, () =>
        userDecrypt(this.ctx.fhevm, this.ctx.sessionKey, handle, this.ctx.poolAddress),
      );
    };
    return {
      inPool: await mk(await pool.confidentialBalanceOf!(me), "balance"),
      won: await mk(await pool.winningsOf!(me), "sent"),
      pending: await mk(await pool.pendingOf!(me), "sent"),
    };
  }

  /** Whether the pool may move the session key's tokens. */
  async isAuthorised(): Promise<boolean> {
    return this.token.isOperator!(this.ctx.sessionKeyAddress, this.ctx.poolAddress);
  }

  /** Authorises the pool. One transaction, from the session key — no vault unlock. */
  async authorise(): Promise<string> {
    const until = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const tx = await this.token.setOperator!(this.ctx.poolAddress, until);
    await tx.wait();
    return tx.hash;
  }

  /** The demo token's public faucet. Plaintext by design: minting is not private. */
  async mint(amount: bigint): Promise<string> {
    const tx = await this.token.mint!(this.ctx.sessionKeyAddress, amount);
    await tx.wait();
    return tx.hash;
  }

  async deposit(amount: AmountExpr): Promise<string> {
    return this.submit("deposit", amount);
  }

  async withdraw(amount: AmountExpr): Promise<string> {
    return this.submit("withdraw", amount);
  }

  /**
   * Resolves the expression, encrypts it, and sends.
   *
   * The plaintext lives between these two lines and nowhere else. It is not
   * returned, not logged, and not part of the result the model sees.
   */
  private async submit(fn: "deposit" | "withdraw", amount: AmountExpr): Promise<string> {
    const value = await amount.resolve();
    const input = warmInput(
      this.ctx.fhevm,
      this.ctx.poolAddress,
      this.ctx.sessionKeyAddress,
      value,
    );
    const { handle, inputProof } = await input.ready;
    const tx = await withRetry(fn, () => this.pool[fn]!(handle, inputProof));
    await tx.wait();
    return tx.hash;
  }
}
