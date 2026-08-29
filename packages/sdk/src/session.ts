/**
 * The session: what a session client can do once the owner has authorised it.
 *
 * Two tiers, and they are two TYPES rather than a flag on one type. A session
 * opened without ACL delegation has no `balance()` method, so a reference amount
 * like "half of what's in the wallet" fails to compile rather than failing at
 * runtime. Neither tier is degraded — spend-only is a complete session that
 * simply cannot answer "what is in the wallet", which is a privacy property.
 */
import type { Signer } from "ethers";

import { erc7984, ghostKey, type GhostKeyContract } from "./contracts";
import { AmountExpr, AmountRef, attachResolver } from "./amounts";
import {
  BalanceNotVisibleError,
  OperatorNotGrantedError,
  ProtocolUnavailableError,
  RecipientNotAllowedError,
  SessionNotLiveError,
  ZeroAmountError,
} from "./errors";
import {
  delegatedUserDecrypt,
  type FhevmInstance,
  userDecrypt,
  userDecryptBool,
  warmInput,
} from "./fhe";

/** Plaintext session parameters, exactly as the contract stores them. */
export interface SessionParams {
  readonly owner: string;
  /** UNIX seconds. Zero means the session was closed. */
  readonly expiry: number;
  /** Zero means unlimited. */
  readonly maxTxCount: number;
  readonly txCount: number;
}

/** Everything that can stop a send, named rather than left as an opaque revert. */
export interface Readiness {
  readonly ok: boolean;
  readonly sessionLive: boolean;
  readonly operatorGranted: boolean;
  readonly aclPaused: boolean;
  readonly keyDenied: boolean;
  readonly moduleDenied: boolean;
  readonly reasons: readonly string[];
}

/** The contract's truth table, as a discriminated union. */
export type SendResult =
  | {
      readonly outcome: "sent";
      readonly amount: bigint;
      readonly hash: string;
      readonly sent: AmountRef;
    }
  | { readonly outcome: "over-budget"; readonly hash: string; readonly sent: AmountRef }
  | { readonly outcome: "insufficient-balance"; readonly hash: string; readonly sent: AmountRef };

export interface SendIntent {
  readonly token: string;
  readonly to: string;
  readonly amount: AmountExpr;
}

/**
 * The outcome of closing a session.
 *
 * Session keys are single-use by design, so whatever gas is left on one after a
 * close is stranded forever unless it is swept. Opening a session a day without
 * this leaks 0.02 ETH a day for no benefit.
 */
export interface CloseResult {
  readonly hash: string;
  /** Wei returned to the owner. Zero when there was nothing worth moving. */
  readonly reclaimed: bigint;
  /** Set when the sweep failed. The session is closed regardless. */
  readonly sweepError?: string;
}

/** A send whose proof may still be generating. */
export interface PreparedSend {
  /** Settles when the encrypted input is ready. Await it or ignore it. */
  readonly ready: Promise<void>;
  send(): Promise<SendResult>;
  abort(): void;
}

export interface SessionContext {
  readonly moduleAddress: string;
  readonly sessionKey: Signer;
  readonly sessionKeyAddress: string;
  readonly owner: string;
  readonly fhevm: FhevmInstance;
}

const SECONDS = 1000;

class SessionImpl {
  protected readonly module: GhostKeyContract;

  constructor(protected readonly ctx: SessionContext) {
    this.module = ghostKey(ctx.moduleAddress, ctx.sessionKey);
  }

  get sessionKeyAddress(): string {
    return this.ctx.sessionKeyAddress;
  }

  get owner(): string {
    return this.ctx.owner;
  }

  get moduleAddress(): string {
    return this.ctx.moduleAddress;
  }

  async params(): Promise<SessionParams> {
    const s = await this.module.sessionOf(this.ctx.sessionKeyAddress);
    return {
      owner: s[0],
      expiry: Number(s[1]),
      maxTxCount: Number(s[2]),
      txCount: Number(s[3]),
    };
  }

  async tokens(): Promise<readonly string[]> {
    return this.module.tokensOf(this.ctx.sessionKeyAddress);
  }

  async recipients(): Promise<readonly string[]> {
    return this.module.recipientsOf(this.ctx.sessionKeyAddress);
  }

  /**
   * The remaining budget, as a reference. This needs no ACL delegation: the
   * budget is the module's own handle and the contract grants it to both the
   * owner and the session key at every write.
   */
  async remaining(token: string): Promise<AmountRef> {
    const handle = await this.module.remainingOf(this.ctx.sessionKeyAddress, token);
    const ref = new AmountRef(handle, token, "budget");
    return attachResolver(ref, () =>
      userDecrypt(this.ctx.fhevm, this.ctx.sessionKey, handle, this.ctx.moduleAddress),
    );
  }

  /** Boolean only. Never returns or leaks the amounts it compares. */
  async canAfford(token: string, amount: bigint): Promise<boolean> {
    const budget = await this.remaining(token);
    const left = await userDecrypt(
      this.ctx.fhevm,
      this.ctx.sessionKey,
      budget.handle,
      this.ctx.moduleAddress,
    );
    return left >= amount;
  }

  async readiness(token?: string): Promise<Readiness> {
    const reasons: string[] = [];
    const p = await this.params();

    let sessionLive = true;
    if (p.owner === "0x0000000000000000000000000000000000000000") {
      sessionLive = false;
      reasons.push("no session exists for this key");
    } else if (p.expiry === 0) {
      sessionLive = false;
      reasons.push("session closed");
    } else if (p.expiry * SECONDS <= Date.now()) {
      sessionLive = false;
      reasons.push("session expired");
    } else if (p.maxTxCount !== 0 && p.txCount >= p.maxTxCount) {
      sessionLive = false;
      reasons.push(`transaction cap reached (${p.txCount}/${p.maxTxCount})`);
    }

    // The operator grant lives on the token and lapses independently of the
    // session, so a perfectly live session can still be unable to move anything.
    let operatorGranted = true;
    const tokensToCheck = token !== undefined ? [token] : await this.tokens();
    for (const t of tokensToCheck) {
      const granted = await erc7984(t, this.ctx.sessionKey).isOperator(
        p.owner,
        this.ctx.moduleAddress,
      );
      if (!granted) {
        operatorGranted = false;
        reasons.push(`the module is not an operator for ${p.owner} on ${t}`);
      }
    }

    const [aclPaused, keyDenied, moduleDenied] = await this.module.protocolStatus(
      this.ctx.sessionKeyAddress,
    );
    if (aclPaused) reasons.push("the FHEVM ACL is paused");
    if (keyDenied) reasons.push("the session key is deny-listed by the ACL");
    if (moduleDenied) reasons.push("the module is deny-listed by the ACL");

    return {
      ok: sessionLive && operatorGranted && !aclPaused && !keyDenied && !moduleDenied,
      sessionLive,
      operatorGranted,
      aclPaused,
      keyDenied,
      moduleDenied,
      reasons,
    };
  }

  /**
   * Starts encryption and proof generation now, submits later.
   *
   * On the step-1 measurements this is worth roughly twelve seconds of perceived
   * latency: proof generation is client-side, has near-zero variance, and happens
   * before any transaction exists. Call it the moment the intent is legible.
   */
  prepare(intent: SendIntent): PreparedSend {
    let aborted = false;
    const started = (async () => {
      const value = await intent.amount.resolve();
      if (value === 0n) throw new ZeroAmountError();
      const warm = warmInput(
        this.ctx.fhevm,
        this.ctx.moduleAddress,
        this.ctx.sessionKeyAddress,
        value,
      );
      return { value, warm };
    })();
    started.catch(() => undefined);

    return {
      ready: started.then(async ({ warm }) => {
        await warm.ready;
      }),
      send: async () => {
        if (aborted) throw new Error("this prepared send was aborted");
        const { value, warm } = await started;
        const input = await warm.ready;
        return this.submit(intent.token, intent.to, value, input);
      },
      abort: () => {
        aborted = true;
        void started.then(({ warm }) => warm.abort()).catch(() => undefined);
      },
    };
  }

  async send(intent: SendIntent): Promise<SendResult> {
    return this.prepare(intent).send();
  }

  /** @internal The part after the proof exists. */
  protected async submit(
    token: string,
    to: string,
    value: bigint,
    input: { handle: string; inputProof: string },
  ): Promise<SendResult> {
    // Client obligations the contract deliberately does not enforce, checked here
    // so the user is told what is actually wrong rather than getting a revert.
    if (value === 0n) throw new ZeroAmountError();

    const allowed = await this.module.isRecipientAllowed(this.ctx.sessionKeyAddress, to);
    if (!allowed) throw new RecipientNotAllowedError(to);

    const ready = await this.readiness(token);
    if (!ready.sessionLive) {
      throw new SessionNotLiveError(
        ready.reasons.some((r) => r.includes("expired"))
          ? "expired"
          : ready.reasons.some((r) => r.includes("cap"))
            ? "tx-count-exhausted"
            : ready.reasons.some((r) => r.includes("closed"))
              ? "closed"
              : "missing",
      );
    }
    if (!ready.operatorGranted) throw new OperatorNotGrantedError(this.ctx.owner, token);
    if (ready.aclPaused || ready.keyDenied || ready.moduleDenied) {
      throw new ProtocolUnavailableError({
        aclPaused: ready.aclPaused,
        keyDenied: ready.keyDenied,
        moduleDenied: ready.moduleDenied,
      });
    }

    const tx = await this.module.send(token, to, input.handle, input.inputProof);
    const receipt = await tx.wait();
    if (receipt === null) throw new Error(`transaction ${tx.hash} produced no receipt`);

    const log = receipt.logs.find(
      (l) => l.address.toLowerCase() === this.ctx.moduleAddress.toLowerCase(),
    );
    if (log === undefined) throw new Error(`no Sent event in ${tx.hash}`);
    const parsed = this.module.interface.parseLog({ topics: [...log.topics], data: log.data });
    if (parsed === null) throw new Error(`could not decode the Sent event in ${tx.hash}`);

    const withinHandle = parsed.args["within"] as string;
    const sentHandle = parsed.args["sent"] as string;

    const sentRef = attachResolver(new AmountRef(sentHandle, token, "sent"), () =>
      userDecrypt(this.ctx.fhevm, this.ctx.sessionKey, sentHandle, this.ctx.moduleAddress),
    );

    // `within` is an ebool and takes a different decrypt path from the euint64
    // handles, so the two are fetched together and mapped once.
    const within = await userDecryptBool(
      this.ctx.fhevm,
      this.ctx.sessionKey,
      withinHandle,
      this.ctx.moduleAddress,
    );
    const moved = await userDecrypt(
      this.ctx.fhevm,
      this.ctx.sessionKey,
      sentHandle,
      this.ctx.moduleAddress,
    );

    if (!within) return { outcome: "over-budget", hash: tx.hash, sent: sentRef };
    if (moved === 0n) return { outcome: "insufficient-balance", hash: tx.hash, sent: sentRef };
    // Plaintext here is not a reveal: the session client chose this number.
    return { outcome: "sent", amount: moved, hash: tx.hash, sent: sentRef };
  }

  /** Owner or session key. The client must be able to narrow its own scope. */
  async removeRecipient(to: string, as?: Signer): Promise<string> {
    const c = as === undefined ? this.module : this.module.connect(as);
    const tx = await c.removeRecipient(this.ctx.sessionKeyAddress, to);
    await tx.wait();
    return tx.hash;
  }

  /**
   * Closes the session and returns the session key's leftover gas to the owner.
   *
   * Owner or session key may close — the client must be able to self-terminate.
   * The sweep is always signed by the SESSION key, whoever closed, because that is
   * where the balance sits and the session key can already sign a close.
   *
   * Best effort by construction: the close is awaited first and its result stands
   * whatever happens next. A failed sweep leaves stranded gas, which is the state the
   * caller was already in; a failed sweep that took the close down with it would
   * be strictly worse.
   */
  async close(as?: Signer): Promise<CloseResult> {
    const c = as === undefined ? this.module : this.module.connect(as);
    const tx = await c.closeSession(this.ctx.sessionKeyAddress);
    await tx.wait();

    try {
      const reclaimed = await this.sweepGas();
      return { hash: tx.hash, reclaimed };
    } catch (e) {
      return { hash: tx.hash, reclaimed: 0n, sweepError: (e as Error).message };
    }
  }

  /**
   * Sends the session key's balance to the owner, less the cost of doing so.
   *
   * The reserve is computed from `maxFeePerGas` rather than the base fee, so the
   * transaction cannot price itself out between estimation and inclusion. That
   * leaves a little dust behind, which is the right side to err on.
   */
  private async sweepGas(): Promise<bigint> {
    const provider = this.ctx.sessionKey.provider;
    if (provider === null) return 0n;

    const balance = await provider.getBalance(this.ctx.sessionKeyAddress);
    if (balance === 0n) return 0n;

    const fees = await provider.getFeeData();
    const perGas = fees.maxFeePerGas ?? fees.gasPrice;
    if (perGas === null || perGas === undefined) return 0n;

    const GAS = 21_000n;
    const cost = GAS * perGas;
    if (balance <= cost) return 0n;

    const value = balance - cost;
    const sweep = await this.ctx.sessionKey.sendTransaction({
      to: this.ctx.owner,
      value,
      gasLimit: GAS,
    });
    await sweep.wait();
    return value;
  }

  /** Owner only — the vault key must be unlocked for this. */
  async addRecipient(to: string, owner: Signer): Promise<string> {
    const tx = await this.module.connect(owner).addRecipient(this.ctx.sessionKeyAddress, to);
    await tx.wait();
    return tx.hash;
  }

  /** Owner only. */
  async increaseBudget(token: string, amount: bigint, owner: Signer): Promise<string> {
    const ownerAddr = await owner.getAddress();
    const warm = warmInput(this.ctx.fhevm, this.ctx.moduleAddress, ownerAddr, amount);
    const input = await warm.ready;
    const tx = await this.module
      .connect(owner)
      .increaseBudget(this.ctx.sessionKeyAddress, token, input.handle, input.inputProof);
    await tx.wait();
    return tx.hash;
  }
}

/** A session with no ACL delegation: it sees what it spent, never the wallet. */
export class SpendOnlySession extends SessionImpl {
  readonly tier = "spend-only" as const;

  /** Explicit, so a JavaScript caller gets a useful error rather than `undefined`. */
  balance(): never {
    throw new BalanceNotVisibleError();
  }
}

/** A session with ACL delegation: it can also read the holder's balance. */
export class BalanceVisibleSession extends SessionImpl {
  readonly tier = "balance-visible" as const;

  /**
   * The holder's confidential balance, as a reference.
   *
   * This is the one capability that requires ACL delegation, and it is the whole
   * reason delegation exists in this design. The session key signs with its OWN
   * key; the owner signs nothing here. Verified live in step 1 (A6).
   */
  async balance(token: string): Promise<AmountRef> {
    const handle = await erc7984(token, this.ctx.sessionKey).confidentialBalanceOf(this.ctx.owner);
    const ref = new AmountRef(handle, token, "balance");
    return attachResolver(ref, () =>
      delegatedUserDecrypt(this.ctx.fhevm, this.ctx.sessionKey, this.ctx.owner, handle, token),
    );
  }
}

export type Session = SpendOnlySession | BalanceVisibleSession;
