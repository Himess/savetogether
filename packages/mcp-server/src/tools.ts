/**
 * The tool surface.
 *
 * WHAT THE MODEL MAY SEE. By default, never a plaintext amount. `reveal: true`
 * requires a click on the local console, every single call, and there is no
 * configuration option that turns the confirmation off. That is the ideological
 * core of the project, so it is enforced here rather than left to a setting.
 *
 * NO UNWRAP TOOL. ERC-7984 to ERC-20 needs public decryption of the amount, which
 * is a deliberate disclosure decision. It stays outside session authority
 * entirely; if a user asks, `send` explains why and points at the console.
 */
import type { ConsoleServer } from "@savetogether/console";
import {
  SaveTogetherClient,
  OperatorNotGrantedError,
  ProtocolUnavailableError,
  RecipientNotAllowedError,
  SessionNotLiveError,
  ZeroAmountError,
  exact,
  memoryKeystore,
  osKeychainKeystore,
  ref,
  revealAmount,
  PoolClient,
  VaultClient,
  type AmountExpr,
  type AmountRef,
  type Session,
} from "@savetogether/sdk";
import { Contract, getAddress, type Provider, formatEther } from "ethers";
import * as os from "node:os";
import * as path from "node:path";

import { formatAmount, parseAmount, type SaveTogetherConfig, type TokenEntry } from "./config";
import { COARSE_BUCKET, coarsenBudget, sanitiseChainText, untrusted } from "./sanitize";
import { Vault } from "./vault";
import { isFigure, isRefId, refId } from "./refs.js";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const MINTABLE_ABI = ["function mintPlain(address to, uint64 amount)"];

/**
 * Where a holder goes to read their own numbers.
 *
 * The one address this server hands a user, and it is not the MCP endpoint —
 * `PUBLIC_URL` does not reach here. It was still `ghostpool-himess` after the
 * product was renamed, and it surfaced in a real transcript rather than in any
 * check, which is why it is a named constant now: one place, and greppable.
 */
const SITE = "https://savetogether-fhe.vercel.app";

const WRAPPER_ABI = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function underlying() view returns (address)",
  "function rate() view returns (uint256)",
];

export interface ToolContext {
  readonly config: SaveTogetherConfig;
  readonly provider: Provider;
  readonly client: SaveTogetherClient;
  /**
   * Absent when hosted. The server holds session keys, never a vault key, so
   * every tool that would unlock one is withheld rather than made to fail late.
   */
  readonly vault?: Vault;
  readonly console?: ConsoleServer;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly text: string;
  readonly data?: Record<string, unknown>;
}

/**
 * What a vault unlock was spent on.
 *
 * The counter is the product's central claim as a number, and a number nobody can
 * attribute is not evidence — it could be a constant with a label on it. Recording
 * the reason is what makes a move from 1 to 2 mid-demo readable as "the owner
 * widened the allowlist" rather than as drift.
 */
export type UnlockReason = "session" | "recipient" | "wrap";

/** Session state the tools share. One session at a time, deliberately. */
interface Live {
  session: Session;
  tier: "spend-only" | "balance-visible";
  vaultUnlocks: number;
  /** Aggregated by reason, in order of first occurrence. Sums to vaultUnlocks. */
  unlocks: { reason: UnlockReason; n: number }[];
  /** Refs handed to the model, keyed by an opaque id it can pass back. */
  refs: Map<string, AmountRef>;
  /** Built on first use; a session without a configured pool never makes one. */
  pool?: PoolClient;
}

export class SaveTogetherTools {
  private live: Live | null = null;

  constructor(private readonly ctx: ToolContext) {}

  private token(symbolOrAddress: string): TokenEntry {
    const needle = symbolOrAddress.trim().toLowerCase();
    const found = this.ctx.config.tokens.find(
      (t) => t.symbol.toLowerCase() === needle || t.address.toLowerCase() === needle,
    );
    if (found === undefined) {
      throw new Error(
        `unknown token "${symbolOrAddress}"; this session knows ${this.ctx.config.tokens.map((t) => t.symbol).join(", ")}`,
      );
    }
    return found;
  }

  /**
   * Validates a recipient address.
   *
   * Every address argument used to go straight through to ethers, which meant a
   * model passing a name — "add Mehmet to the list" is a thing a user says — got
   * an ABI encoding error AFTER the tool had already made the user click a vault
   * unlock. A physical action spent on an argument that was never going to work.
   *
   * Names and ENS are refused rather than resolved: resolution is a chain call
   * whose answer the user cannot check before signing, and this is the one
   * argument where being wrong sends money to the wrong place.
   */
  private recipient(raw: string): string {
    const value = raw.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new Error(
        `"${raw}" is not an address. This needs a 0x-prefixed, 40-hex-digit address — names ` +
          `and ENS are not resolved, because a resolution cannot be checked before it is signed.`,
      );
    }
    try {
      return getAddress(value);
    } catch {
      throw new Error(
        `"${raw}" is the right shape but its checksum is wrong, which usually means one ` +
          `character is mistyped. Paste it again rather than correcting it by hand.`,
      );
    }
  }

  /**
   * The world check, deliberately performed AFTER argument validation.
   *
   * An unknown token, a malformed amount or a bad address is the caller's mistake
   * and costs one local check to detect. Reporting "no session is open" first
   * sends a model off to open a session and come back to the same error, having
   * spent a vault unlock on the round trip. Cheap and specific before expensive
   * and situational — and never after something the user has to physically click.
   */
  /** The vault, or an explanation of why there isn't one. */
  private requireVault(): Vault {
    if (this.ctx.vault === undefined) {
      throw new Error(
        "this is a hosted session: the server holds a session key bounded by your encrypted " +
          "budget, never your wallet key. Anything needing your wallet — opening a session, " +
          "widening the allowlist, wrapping tokens — happens in your browser.",
      );
    }
    return this.ctx.vault;
  }

  /**
   * Adopts a session opened somewhere else.
   *
   * Hosted sessions are opened by the user's own wallet in the browser, so by
   * the time the tools exist the session is already live on chain and no unlock
   * was ever spent here. The unlock counter starts at zero and stays there,
   * which is the honest number rather than a flattering one.
   */
  attachSession(session: Session, tier: "spend-only" | "balance-visible"): void {
    this.live = {
      session,
      tier,
      vaultUnlocks: 0,
      unlocks: [],
      refs: new Map(),
    };
  }

  private requireLive(): Live {
    if (this.live === null) throw new Error("no session is open; call open_session first");
    return this.live;
  }

  /**
   * Reference ids, in the shape every surface says they are.
   *
   * This minted `bal_${Math.random().toString(36)}` — `bal_haauwfru` — while the
   * tool descriptions, the schema hints, the error messages, the README and the
   * pool_position text all say `bal_1`. The two never agreed, so the documented
   * reference path into the pool was dead for every caller: a live session minted
   * a reference and `pool_deposit` refused its own output.
   *
   * Sequential, per session, and that is not a downgrade. These name the CALLER'S
   * OWN values inside the CALLER'S OWN session — `live.refs` is per-session state,
   * so there is nothing here another party could reach by guessing. What the
   * randomness was buying was unguessability against the holder themselves, which
   * is not a threat; what it cost was every piece of documentation being false.
   *
   * A guessed-but-absent id is now a named error rather than a silent fall
   * through to `parseAmount`, which is the part that mattered.
   */
  private newRefId(kind: string): string {
    const n = (this.refCounts.get(kind) ?? 0) + 1;
    this.refCounts.set(kind, n);
    return refId(kind, n);
  }

  /** One counter per prefix, so bal_1 and pool_1 can both exist. */
  private readonly refCounts = new Map<string, number>();

  /** Counts an unlock and remembers what it bought. */
  private recordUnlock(reason: UnlockReason): void {
    const live = this.live;
    if (live === null) return;
    live.vaultUnlocks += 1;
    const seen = live.unlocks.find((u) => u.reason === reason);
    if (seen === undefined) live.unlocks.push({ reason, n: 1 });
    else seen.n += 1;
  }

  private async pushStatus(): Promise<void> {
    if (this.ctx.console === undefined) return;
    if (this.live === null) {
      this.ctx.console.setStatus({ session: false, vaultUnlocks: 0 });
      return;
    }
    const p = await this.live.session.params();
    this.ctx.console.setStatus({
      session: p.expiry !== 0,
      vaultUnlocks: this.live.vaultUnlocks,
      unlocks: this.live.unlocks.map((u) => ({ ...u })),
      vault: (await this.ctx.vault?.address()) ?? undefined,
      sessionKey: this.live.session.sessionKeyAddress,
      expiry: p.expiry,
      txCount: p.txCount,
      maxTxCount: p.maxTxCount,
      recipients: await this.live.session.recipients(),
      tier: this.live.tier,
    });
  }

  // -------------------------------------------------------------------------
  // open_session
  // -------------------------------------------------------------------------

  async openSession(args: {
    tokens: string[];
    budgets: string[];
    allowlist: string[];
    ttlHours: number;
    delegation: boolean;
  }): Promise<ToolResult> {
    if (args.tokens.length === 0) {
      throw new Error("a session must fund at least one token");
    }
    if (args.tokens.length !== args.budgets.length) {
      throw new Error("tokens and budgets must have the same length, in the same order");
    }
    if (args.allowlist.length === 0) {
      throw new Error("an empty allowlist means no transfers at all; name at least one recipient");
    }
    // Before the unlock: a bad address here would otherwise cost a console click
    // and three transactions to discover.
    const allowlist = args.allowlist.map((a) => this.recipient(a));

    const entries = args.tokens.map((t) => this.token(t));
    const budgets = entries.map((t, i) => ({
      token: t.address,
      amount: parseAmount(args.budgets[i] ?? "0", t.decimals),
    }));
    for (const b of budgets) {
      if (b.amount === 0n) throw new Error("a zero budget would make the session useless");
    }

    const summary = entries.map((t, i) => `${args.budgets[i]} ${t.symbol}`).join(", ");
    const owner = await this.requireVault().unlock(
      `Open a session: ${summary} to ${args.allowlist.length} recipient(s), for ${args.ttlHours}h.` +
        (args.delegation ? " The session will also be able to read your balance." : ""),
    );

    // The transfer cap comes from the console, not from the tool call: a chat
    // client should not be able to talk a user into a wider one.
    const maxTxCount = this.ctx.console?.getSettings().maxTxCount ?? 0;

    const result = await this.ctx.client.openSession({
      owner,
      budgets,
      recipients: allowlist,
      expiry: new Date(Date.now() + args.ttlHours * 3_600_000),
      readScope: args.delegation ? "balance-visible" : "spend-only",
      ...(maxTxCount > 0 ? { maxTxCount } : {}),
    });

    // The SDK funds the session key during the open, while the owner is still
    // authorised, so nothing extra is needed here.

    // Locked again immediately. Everything after this runs on the session key.
    this.requireVault().lock();

    this.live = {
      session: result.session,
      tier: args.delegation ? "balance-visible" : "spend-only",
      vaultUnlocks: result.ownerAuthorisations,
      unlocks: [{ reason: "session", n: result.ownerAuthorisations }],
      refs: new Map(),
    };
    await this.pushStatus();

    return {
      ok: true,
      text:
        `Session open. ${summary} spendable to ${args.allowlist.length} address(es) for ${args.ttlHours}h` +
        (maxTxCount > 0 ? `, capped at ${maxTxCount} transfers.\n` : ", uncapped.\n") +
        `The vault is locked again — that was the only time it will be needed.\n` +
        `Vault unlocks this session: ${result.ownerAuthorisations}. The vault signed ` +
        `three transactions after that one unlock, which is the point.\n` +
        (args.delegation
          ? 'This session can read your balance, so reference amounts like "half" work.'
          : "This session cannot read your balance. It sees what it spent and what is left."),
      data: {
        sessionKey: result.sessionKeyAddress,
        vaultUnlocks: result.ownerAuthorisations,
        batched: result.batched,
        tier: this.live.tier,
      },
    };
  }

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  /** Symbols and references. Never amounts. */
  async listAssets(): Promise<ToolResult> {
    const lines: string[] = [];
    for (const t of this.ctx.config.tokens) {
      // The symbol comes from local config, not the chain, so it is not
      // injectable. The on-chain name is fetched only to show drift, sanitised.
      let onChain = "";
      try {
        const c = new Contract(
          t.address,
          ["function name() view returns (string)"],
          this.ctx.provider,
        );
        const raw = (await c.name?.()) as string;
        const s = sanitiseChainText(raw);
        if (s.text.toLowerCase() !== t.symbol.toLowerCase()) {
          onChain = `  (${untrusted("on-chain name", s.text)})`;
        }
      } catch {
        /* a token that will not answer name() is still usable */
      }
      lines.push(`${t.symbol}  ${t.address}${onChain}`);
    }
    return {
      ok: true,
      text: `Tokens this session knows about:\n${lines.join("\n")}\n\nNo amounts here by design — ask about a specific one.`,
      data: { tokens: this.ctx.config.tokens.map((t) => t.symbol) },
    };
  }

  /** Returns a reference by default. A number only with a click. */
  async balance(args: { token: string; reveal: boolean }): Promise<ToolResult> {
    const t = this.token(args.token);
    const live = this.requireLive();
    if (live.tier !== "balance-visible" || live.session.tier !== "balance-visible") {
      return {
        ok: false,
        text:
          `This session cannot read your balance — it was opened without delegation.\n` +
          `That was the point: the session client sees what it spent and what is left, not what you hold.\n` +
          `Open a new session with delegation if you want reference amounts like "half".`,
      };
    }
    const r = await live.session.balance(t.address);
    const id = this.newRefId("bal");
    live.refs.set(id, r);

    if (!args.reveal) {
      return {
        ok: true,
        text: `Your ${t.symbol} balance is available as ${id}. I have not looked at the number.`,
        data: { ref: id, token: t.symbol },
      };
    }
    return this.revealRef(id, `Reveal your ${t.symbol} balance to the model?`, t);
  }

  async remaining(args: { token: string; reveal: boolean }): Promise<ToolResult> {
    const t = this.token(args.token);
    const live = this.requireLive();
    const r = await live.session.remaining(t.address);
    const id = this.newRefId("rem");
    live.refs.set(id, r);

    if (!args.reveal) {
      return {
        ok: true,
        text: `The remaining ${t.symbol} budget is available as ${id}. I have not looked at the number.`,
        data: { ref: id, token: t.symbol },
      };
    }
    return this.revealRef(id, `Reveal the remaining ${t.symbol} budget to the model?`, t);
  }

  /** Boolean only. Never leaks either side of the comparison. */
  /**
   * Whether an amount fits, answered against a COARSENED budget.
   *
   * The exact predicate was an oracle. `left >= amount` is monotone, free, and
   * was neither counted nor logged, so binary search recovered the budget to the
   * unit — 40 calls for a realistic figure, inside the hosted server's
   * 60-per-minute window. `test/g1-can-afford-oracle.ts` performs the search and
   * then pins the fix.
   *
   * The answer is now computed against `remaining` rounded DOWN to
   * `COARSE_BUCKET`, so every budget sharing a bucket answers identically to
   * every probe and no number of calls separates them. Rounding down means a
   * "yes" is always a real yes; the cost is that an amount inside the residue is
   * refused even though it would have gone through, and the description says so.
   */
  async canAfford(args: { token: string; amount: string }): Promise<ToolResult> {
    const t = this.token(args.token);
    const wanted = parseAmount(args.amount, t.decimals);
    const live = this.requireLive();

    const remaining = await live.session.remainingExact(t.address);
    const coarse = coarsenBudget(remaining);
    const ok = coarse >= wanted;

    const bucket = `${Number(COARSE_BUCKET) / 10 ** t.decimals} ${t.symbol}`;
    return {
      ok: true,
      text: ok
        ? `Yes — ${args.amount} ${t.symbol} is within the remaining budget.`
        : `No — ${args.amount} ${t.symbol} is not within the budget as measured. ` +
          `This answer is computed against the budget rounded down to the nearest ${bucket}, ` +
          `so an amount within that rounding is refused here even though the transfer itself ` +
          `would succeed. Try a smaller figure, or send it and let the on-chain budget decide.`,
      data: { affordable: ok, coarsenedBy: COARSE_BUCKET.toString() },
    };
  }

  async sessionStatus(): Promise<ToolResult> {
    const live = this.requireLive();
    const p = await live.session.params();
    const recipients = await live.session.recipients();
    const ready = await live.session.readiness();
    await this.pushStatus();

    return {
      ok: true,
      text:
        `Session ${live.session.sessionKeyAddress}\n` +
        `  owner       ${p.owner}\n` +
        `  expires     ${p.expiry === 0 ? "closed" : new Date(p.expiry * 1000).toISOString()}\n` +
        `  transfers   ${p.txCount}${p.maxTxCount === 0 ? " (uncapped)" : ` / ${p.maxTxCount}`}\n` +
        `  allowlist   ${recipients.join(", ") || "(none)"}\n` +
        `  can read balance  ${live.tier === "balance-visible" ? "yes" : "no"}\n` +
        `  vault unlocks  ${live.vaultUnlocks}\n` +
        (ready.ok ? `  ready       yes` : `  ready       no — ${ready.reasons.join("; ")}`),
      data: {
        txCount: p.txCount,
        maxTxCount: p.maxTxCount,
        expiry: p.expiry,
        vaultUnlocks: live.vaultUnlocks,
        ready: ready.ok,
        reasons: ready.reasons,
      },
    };
  }

  // -------------------------------------------------------------------------
  // send
  // -------------------------------------------------------------------------

  /**
   * `amount` is one of: a plain decimal, a reference id from `balance`/`remaining`
   * optionally with `half`/`percent`, or the literal `"sealed"`.
   *
   * SEALED MODE. The user types the amount on the console; this process encrypts
   * it; the model receives only `{status, ok_ref, sent_ref}`. What still leaks,
   * stated plainly rather than glossed: that a transfer happened, which token,
   * which recipient, and when. Recipients are public on chain regardless, so
   * sealed mode hides the amount and nothing else — and it does not pretend to.
   */
  async send(args: { token: string; to: string; amount: string }): Promise<ToolResult> {
    const t = this.token(args.token);
    const to = this.recipient(args.to);
    const spec = args.amount.trim();
    const live = this.requireLive();

    let expr;
    let sealed = false;
    if (spec.toLowerCase() === "sealed") {
      sealed = true;
      if (this.ctx.console === undefined) {
        throw new Error("sealed mode needs the local console, and it is not running");
      }
      const answer = await this.ctx.console.ask(
        "sealed",
        `Send ${t.symbol} to ${to}. Type the amount here; the model will not see it.`,
      );
      if (!answer.approved || answer.value === undefined) {
        return { ok: false, text: "Cancelled at the console. Nothing was sent." };
      }
      expr = exact(parseAmount(answer.value, t.decimals));
    } else {
      // One resolver, shared with pool_deposit and pool_withdraw. This used to be
      // a second copy of it, and that copy is the only reason send kept working
      // while both pool paths were dead — it checked whether the session held the
      // reference, while the shared parser checked whether the id LOOKED like one
      // and disagreed with the minter. A defect one of three callers is immune to
      // is a defect that hides.
      expr = this.exprFor(this.amountSpec(spec), live, t.decimals);
    }

    // Warm the proof before anything else: it is twelve of the roughly thirty
    // seconds, and it does not depend on the chain.
    const prepared = live.session.prepare({ token: t.address, to, amount: expr });

    let result;
    try {
      result = await prepared.send();
    } catch (e) {
      return { ok: false, text: explainFailure(e, t.symbol) };
    }
    await this.pushStatus();

    const sentId = this.newRefId("sent");
    live.refs.set(sentId, result.sent);

    if (result.outcome === "over-budget") {
      return {
        ok: false,
        text: `That would exceed the session budget, so nothing moved. The budget is untouched.`,
        data: { status: "over-budget", sent_ref: sentId, tx: result.hash },
      };
    }
    if (result.outcome === "insufficient-balance") {
      return {
        ok: false,
        text: `The wallet does not hold that much ${t.symbol}, so nothing moved. The budget is untouched.`,
        data: { status: "insufficient-balance", sent_ref: sentId, tx: result.hash },
      };
    }

    if (sealed) {
      // The model never learns the amount. It learns that it worked.
      return {
        ok: true,
        text: `Sent. The amount stayed between you and the chain.`,
        data: { status: "sent", ok_ref: "true", sent_ref: sentId, tx: result.hash },
      };
    }
    return {
      ok: true,
      text: `Sent ${formatAmount(result.amount, t.decimals)} ${t.symbol} to ${to}.`,
      data: { status: "sent", amount: formatAmount(result.amount, t.decimals), tx: result.hash },
    };
  }

  // -------------------------------------------------------------------------
  // owner-authorised actions
  // -------------------------------------------------------------------------

  async addRecipient(args: { to: string }): Promise<ToolResult> {
    const to = this.recipient(args.to);
    const live = this.requireLive();
    const owner = await this.requireVault().unlock(`Allow this session to send to ${to}.`);
    const hash = await live.session.addRecipient(to, owner);
    this.requireVault().lock();
    this.recordUnlock("recipient");
    await this.pushStatus();
    return {
      ok: true,
      text: `${to} is now on the allowlist. Vault unlocks this session: ${live.vaultUnlocks}.`,
      data: { tx: hash, vaultUnlocks: live.vaultUnlocks },
    };
  }

  /**
   * Public money into confidential money, for whoever this session acts as.
   *
   * TWO MODES, ONE MEANING. Locally the owner holds the public balance and a
   * vault unlock is the honest price of moving it. Hosted there is no vault and
   * no owner key, so the account that acts is the session key -- it holds its
   * own position, and wrapping into that position is an ordinary thing for it to
   * do. The tool means the same in both: make the money this session can spend
   * confidential.
   *
   * The faucet step exists because the underlying here is a testnet mock with a
   * permissionless mint. On a real deployment the caller brings their own and it
   * never runs -- which is why it is a precondition handled quietly rather than
   * a feature announced.
   */
  async wrap(args: { token: string; amount: string }): Promise<ToolResult> {
    const t = this.token(args.token);
    if (t.underlying === undefined) {
      return {
        ok: false,
        text: `${t.symbol} is not a wrapper — there is no public token to wrap into it.`,
      };
    }

    // Hosted: no vault, so the session key wraps for itself.
    if (this.ctx.vault === undefined) {
      const live = this.requireLive();
      const client = live.session.wrapClient(t.address);
      const { decimals } = await client.publicBalance();
      const amount = parseAmount(args.amount, decimals);

      const { hashes, steps } = await client.wrap(amount, { faucet: true });
      return {
        ok: true,
        text:
          `Done: ${steps.join(", ")}. That amount was public before and is confidential now — ` +
          `and wrapping itself is a public act, so the figure IS readable in this transaction. ` +
          `Nothing you do with it afterwards is.`,
        data: { tx: hashes[hashes.length - 1], hashes, steps },
      };
    }

    const wrapper = new Contract(t.address, WRAPPER_ABI, this.ctx.provider);
    const underlying = new Contract(t.underlying, ERC20_ABI, this.ctx.provider);
    const decimals = Number((await underlying.decimals?.()) ?? t.decimals);
    const amount = parseAmount(args.amount, decimals);

    const owner = await this.requireVault().unlock(
      `Wrap ${args.amount} into ${t.symbol}. This moves a public balance, so it needs the vault.`,
    );
    const approveTx = await (underlying.connect(owner) as Contract).approve?.(t.address, amount);
    await approveTx?.wait();
    const wrapTx = await (wrapper.connect(owner) as Contract).wrap?.(
      await owner.getAddress(),
      amount,
    );
    const receipt = await wrapTx?.wait();
    this.requireVault().lock();
    if (this.live !== null) {
      this.recordUnlock("wrap");
      await this.pushStatus();
    }
    return {
      ok: true,
      text: `Wrapped ${args.amount} into ${t.symbol}. The amount was public before and is confidential now.`,
      data: { tx: receipt?.hash },
    };
  }

  /**
   * Confidential money back into public money.
   *
   * THE LIMIT ON THIS ONE IS NOT ON CHAIN, and that is a property of the
   * deployed token rather than a decision taken here. Read at the implementation
   * behind the proxy, the wrapper carries
   *
   *     unwrap(address,address,bytes32,bytes)   0x5bf4ef06   present
   *     unwrap(address,address,uint64)          0xf5c3c5f0   absent
   *
   * An externally encrypted input carries a proof bound to the contract and the
   * account that produced it, and a contract cannot forge one. So the budget
   * module that bounds `send` — the thing that makes every other limit here a
   * promise rather than a preference — cannot bound this. The ceiling lives in
   * this process instead, and every answer says which kind of limit it was,
   * because a weaker guarantee described in the same words as a stronger one is
   * how a product ends up lying without anybody writing a false sentence.
   *
   * It is also a DISCLOSURE: wrapping publishes an amount going in, unwrapping
   * publishes one coming out. That is said before anything else.
   */
  async unwrap(args: { token: string; amount: string }): Promise<ToolResult> {
    const t = this.token(args.token);
    if (t.underlying === undefined) {
      return {
        ok: false,
        text: `${t.symbol} is not a wrapper — there is no public token to unwrap into.`,
      };
    }

    const ceiling = parseAmount(this.ctx.config.maxUnwrap ?? "1000", t.decimals);
    const amount = parseAmount(args.amount, t.decimals);
    if (amount > ceiling) {
      return {
        ok: false,
        text:
          `That is over this server's unwrap ceiling of ${formatAmount(ceiling, t.decimals)} ` +
          `${t.symbol} per call. Worth being precise about what just stopped you: this limit ` +
          `is enforced HERE, by this process, not on chain the way the session budget is. ` +
          `The deployed wrapper only accepts an externally encrypted amount, so no contract ` +
          `can stand in front of it and refuse. Anyone holding the key directly is not bound ` +
          `by it.`,
      };
    }

    // An encrypted input needs the relayer, which a session is what supplies.
    const live = this.requireLive();

    // Hosted: the session key holds the position, so it unwraps its own.
    if (this.ctx.vault === undefined) {
      const { hash } = await live.session.wrapClient(t.address).unwrap(amount);
      return {
        ok: true,
        text:
          `Unwrapped ${args.amount} ${t.symbol}. THAT AMOUNT IS PUBLIC NOW — readable in the ` +
          `transaction and in the account's public balance, which is what unwrapping means. ` +
          `Everything still inside ${t.symbol} is not. The ceiling that allowed it was this ` +
          `server's, not the on-chain budget.`,
        data: { tx: hash, ceiling: formatAmount(ceiling, t.decimals), enforcedBy: "server" },
      };
    }

    // Local: the balance is the owner's, so the owner signs and the session only
    // lends its relayer connection.
    const owner = await this.requireVault().unlock(
      `Unwrap ${args.amount} ${t.symbol}. This PUBLISHES the amount, so it needs the vault.`,
    );
    const client = live.session.wrapClient(t.address, {
      signer: owner,
      address: await owner.getAddress(),
    });
    const { hash } = await client.unwrap(amount);
    this.requireVault().lock();
    this.recordUnlock("wrap");
    await this.pushStatus();
    return {
      ok: true,
      text:
        `Unwrapped ${args.amount} ${t.symbol}. That amount is public now — readable in the ` +
        `transaction and in your public balance. Everything still inside ${t.symbol} is not.`,
      data: { tx: hash, ceiling: formatAmount(ceiling, t.decimals), enforcedBy: "server" },
    };
  }

  // -------------------------------------------------------------------------
  // the vault
  //
  // Composition, not yield. Joining moves the adapter's balance into Zama's next
  // deposit batch and real shares come back when their keeper dispatches it --
  // and it earns NOTHING, because Zama's Sepolia vault is a mock. Both tools say
  // so, because a model that told someone their money was earning in there would
  // be making the one claim that discredits everything else this product says.
  // -------------------------------------------------------------------------

  private requireVaultSource(live: Live): VaultClient {
    const cfg = this.ctx.config.vault;
    if (cfg === undefined) {
      throw new Error("no vault adapter is configured for this deployment");
    }
    return live.session.vaultClient(cfg.adapter, cfg.batcher);
  }

  /** Where the adapter is in the vault's batch cycle. */
  async vaultStatus(): Promise<ToolResult> {
    const live = this.requireLive();
    const client = this.requireVaultSource(live);
    const s = await client.status();

    const where =
      s.currentBatchId === null
        ? "The batcher's own state is not configured here."
        : `The vault's current batch is #${s.currentBatchId} and it is ${s.currentState}.`;

    return {
      ok: true,
      text:
        `${where} The adapter has ${s.openBatches.length} batch(es) it has joined and not yet ` +
        `claimed${s.openBatches.length > 0 ? ` (${s.openBatches.join(", ")})` : ""}. ` +
        `Worth being straight about: this vault is Zama's Sepolia mock and pays no yield. ` +
        `Joining it proves the confidential layer composes; it does not make anyone money.`,
      data: { ...s },
    };
  }

  /**
   * Puts the adapter's balance into the vault's next batch.
   *
   * Permissionless, and it moves the ADAPTER's holding rather than anyone's
   * personal balance — there is no argument to get wrong and no way for it to
   * send value somewhere the adapter had not already chosen.
   */
  async vaultJoin(): Promise<ToolResult> {
    const live = this.requireLive();
    const client = this.requireVaultSource(live);
    const hash = await client.join();
    return {
      ok: true,
      text:
        `Joined the next deposit batch. Shares arrive when Zama's keeper dispatches it, which is ` +
        `their clock rather than ours — ask for the vault status to see where it is. This earns ` +
        `nothing: the Sepolia vault is a mock, and what this demonstrates is composition.`,
      data: { tx: hash },
    };
  }

  /** The panic button. Closes the session; the session key can do this alone. */
  async revokeAll(): Promise<ToolResult> {
    if (this.live === null) return { ok: true, text: "There is no session to revoke." };
    const result = await this.live.session.close();
    const key = this.live.session.sessionKeyAddress;
    this.live = null;
    await this.pushStatus();

    const returned =
      result.reclaimed > 0n
        ? `\n${formatEther(result.reclaimed)} ETH of unused gas went back to your vault.`
        : result.sweepError !== undefined
          ? `\nThe leftover gas could not be returned (${result.sweepError}); it is stranded on a key that can no longer be used.`
          : "";

    return {
      ok: true,
      text:
        `Session ${key} is closed. It can no longer move anything.` +
        returned +
        `\nThe operator grant on the token is separate and still stands; clear it from the console if you want it gone too.`,
      data: { tx: result.hash, reclaimed: result.reclaimed.toString() },
    };
  }

  // -------------------------------------------------------------------------

  private async revealRef(id: string, question: string, t: TokenEntry): Promise<ToolResult> {
    const live = this.requireLive();
    const r = live.refs.get(id);
    if (r === undefined) throw new Error(`unknown reference ${id}`);
    if (this.ctx.console === undefined) {
      // Hosted. There is no local console to click, so the answer is no — and
      // that is the design rather than a missing feature: a reveal has to be a
      // physical act by the holder, and a hosted session has nowhere to put one.
      // The earlier wording said "the local console is not running", which reads
      // as a fault to someone who never had one.
      return {
        ok: false,
        text:
          "I cannot see that number. Revealing one takes a deliberate click by you, and this " +
          "is a hosted session with nowhere to put that click — so the figure stays a reference " +
          "I can spend but not read. Your own balances are on the site, decrypted with your " +
          `wallet: ${SITE}`,
      };
    }
    const answer = await this.ctx.console.ask("reveal", question);
    if (!answer.approved) {
      return { ok: false, text: "Declined at the console. The number stays hidden." };
    }
    const value = await revealAmount(r, { reason: question });
    return {
      ok: true,
      text: `${formatAmount(value, t.decimals)} ${t.symbol}`,
      data: { amount: formatAmount(value, t.decimals), token: t.symbol },
    };
  }

  /**
   * What the console shows about the vault.
   *
   * No confidential balances: reading one is a decryption, and a decryption is
   * exactly the act this product makes deliberate. The console shows the public
   * facts — address, gas, network — and the conversation is where you ask about
   * the rest.
   */
  async vaultPanel(): Promise<{
    address: string;
    ethBalance: string;
    chainId: number;
    chainName: string;
    tokens: string[];
    canMint: boolean;
  }> {
    const address = (await this.requireVault().address()) ?? "";
    const ethBalance =
      address === "" ? "0" : formatEther(await this.ctx.provider.getBalance(address));
    const chainId = this.ctx.config.chainId;
    return {
      address,
      ethBalance,
      chainId,
      chainName: chainId === 11155111 ? "Sepolia" : `chain ${chainId}`,
      tokens: this.ctx.config.tokens.map((x) => x.symbol),
      // Minting is a testnet affordance. Off testnet the control does not appear
      // at all, rather than appearing and failing.
      canMint: chainId === 11155111,
    };
  }

  /**
   * Mints confidential test tokens straight to the vault.
   *
   * This signs with the vault key, so it raises a real unlock prompt even though
   * the user is already standing at the console. That is the rule holding rather
   * than an oversight: no vault signature without an explicit authorisation. It
   * also happens before any session exists, so it does not touch the unlock
   * counter — which counts unlocks *this session*.
   */
  async mint(symbol: string, amount: string): Promise<string> {
    if (this.ctx.config.chainId !== 11155111) {
      throw new Error("minting test tokens is restricted to Sepolia");
    }
    const t = this.token(symbol);
    const value = parseAmount(amount, t.decimals);
    if (value === 0n) throw new Error("mint an amount greater than zero");

    const owner = await this.requireVault().unlock(
      `Mint ${amount} ${t.symbol} to your vault. Test tokens, Sepolia only.`,
    );
    try {
      const token = new Contract(t.address, MINTABLE_ABI, owner);
      const fn = token.getFunction("mintPlain");
      const tx = (await fn(await owner.getAddress(), value)) as {
        hash: string;
        wait(): Promise<unknown>;
      };
      await tx.wait();
      return tx.hash;
    } finally {
      this.requireVault().lock();
    }
  }

  /** @internal for the CLI's status command */
  async vaultSummary(): Promise<{ address: string | null; balance: string }> {
    const address = await this.requireVault().address();
    if (address === null) return { address: null, balance: "0" };
    return { address, balance: formatEther(await this.ctx.provider.getBalance(address)) };
  }

  // -------------------------------------------------------------------------
  // the pool
  //
  // Amounts are references or exact figures, never a number the model had to
  // read first. "Half my balance" resolves inside the session client, so the
  // plaintext exists for the moment it takes to encrypt an input and never
  // enters the transcript. A tool that only accepted numbers would force the
  // model to decrypt the balance to compute half of it, and the balance would
  // be in its context from then on — that is the product's claim collapsing,
  // not a bug in a tool.
  // -------------------------------------------------------------------------

  /**
   * Diagnosed before any chain lookup — but against the session, not a regex.
   *
   * This used to check that an id LOOKED like a reference: `/^[a-z]+_[0-9]+$/`.
   * That is the check that broke the product, because it can disagree with the
   * minter and did. An opaque identifier has no syntax worth validating; the only
   * question worth asking is whether this session actually issued it, and the
   * session knows. `send` already worked this way, which is the only reason
   * `send` still worked while both pool paths were dead.
   *
   * It also makes the error useful: the ids you hold, named.
   */
  private amountSpec(raw: unknown): string {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(
        'amount must be a figure like "250", or a reference like "bal_1" or "bal_1:half".',
      );
    }
    const spec = raw.trim();
    const [id = "", op = ""] = spec.split(":");
    if (isFigure(id)) return spec;
    // STRUCTURE ONLY — prefix, underscore, suffix. Deliberately not a format:
    // the check this replaces pinned the suffix to `[0-9]+` while the minter
    // emitted base-36, and every caller doing it the documented way was refused
    // its own reference. Anything the minter can produce passes here, and
    // whether it EXISTS is a question for the session, one step later.
    if (!isRefId(id)) {
      throw new Error(
        `${id} is neither an amount nor a reference. References look like bal_1 and come from ` +
          `balance, remaining or pool_position.`,
      );
    }
    if (op !== "" && op !== "half" && !op.startsWith("percent=")) {
      throw new Error(`${op} is not a reference operation. Use :half or :percent=25.`);
    }
    return spec;
  }

  /** Turns a validated spec into an expression. Needs the session for its refs. */
  private exprFor(spec: string, live: Live, decimals: number): AmountExpr {
    const [id = "", op = ""] = spec.split(":");
    // A plain figure, and nothing else, reaches parseAmount. This used to send
    // anything it did not recognise as a reference, so a mistyped id was
    // diagnosed as a malformed NUMBER — one indirection away from the truth.
    if (!live.refs.has(id)) {
      if (isFigure(spec)) return exact(parseAmount(spec, decimals));
      // Structurally a reference, and this session never issued it. Naming the
      // ones it did issue is the difference between a model retrying blind and a
      // model retrying correctly.
      const held = [...live.refs.keys()];
      throw new Error(
        `${id} is not a reference this session issued. ` +
          (held.length === 0
            ? "No references exist yet — call balance or pool_position first."
            : `References you hold: ${held.join(", ")}.`),
      );
    }
    const r = live.refs.get(id);
    if (r === undefined) throw new Error(`unknown reference ${id}`);
    const base = ref(r);
    if (op === "half") return base.half();
    if (op.startsWith("percent")) return base.percent(Number(op.split("=")[1] ?? "0"));
    return base;
  }

  private requirePool(live: Live): PoolClient {
    const cfg = this.ctx.config.pool;
    if (cfg === undefined) {
      throw new Error("no prize pool is configured — set pool.address in the SaveTogether config");
    }
    if (live.pool === undefined) {
      // cfg.token is what the user calls it; the client needs the address.
      live.pool = live.session.poolClient(cfg.address, this.token(cfg.token).address);
    }
    return live.pool;
  }

  /**
   * Puts money in the pool.
   *
   * Handles its own preconditions. Entering the pool is authorise, then fund,
   * then deposit, and making the model discover that from three separate
   * failures would defeat the point of it being one sentence.
   *
   * The deposit is for what ACTUALLY arrived rather than what was asked for.
   * The owner's transfer is bounded by the session's encrypted budget and
   * clamps silently when it would exceed it, so depositing the request would
   * credit a position the pool never received.
   */
  async poolDeposit(args: { amount: string }): Promise<ToolResult> {
    const spec = this.amountSpec(args.amount);
    const live = this.requireLive();
    const pool = this.requirePool(live);
    const cfg = this.ctx.config.pool!;
    const t = this.token(cfg.token);
    const expr = this.exprFor(spec, live, t.decimals);

    const steps: string[] = [];
    if (!(await pool.isAuthorised())) {
      await pool.authorise();
      steps.push("authorised the pool to move the session's tokens");
    }

    // Budget-bounded: this is the owner's spend, and the module clamps it.
    const moved = await live.session.send({
      token: t.address,
      to: live.session.sessionKeyAddress,
      amount: expr,
    });
    if (moved.outcome === "over-budget") {
      return {
        ok: false,
        text: "That is more than the session's remaining budget, so nothing moved.",
        data: { status: "over-budget" },
      };
    }
    if (moved.outcome === "insufficient-balance") {
      return {
        ok: false,
        text: `The wallet does not hold that much ${t.symbol}, so nothing moved.`,
        data: { status: "insufficient-balance" },
      };
    }
    steps.push("moved it from the vault within the session budget");

    const hash = await pool.deposit(ref(moved.sent));
    steps.push("deposited");

    const id = this.newRefId("dep");
    live.refs.set(id, moved.sent);
    return {
      ok: true,
      text:
        // Careful with this sentence. "It never left this machine" is true of a
        // local install and FALSE of a hosted one, where the session client is a
        // server that resolved the reference and therefore saw the number. What
        // holds in both is the narrower claim: the model was never told it, and
        // the chain never carried it in the clear. Overstating it here would put
        // a lie in front of the user at the exact moment they are deciding
        // whether to trust the thing.
        `Done: ${steps.join(", ")}. The figure was encrypted before it reached the chain, and ` +
        `it was never given to me. The deposited amount is available as ${id}.`,
      data: { tx: hash, ref: id, steps },
    };
  }

  /** Takes principal back out. Asking for more than the position moves nothing. */
  async poolWithdraw(args: { amount: string }): Promise<ToolResult> {
    const spec = this.amountSpec(args.amount);
    const live = this.requireLive();
    const pool = this.requirePool(live);
    const cfg = this.ctx.config.pool!;
    const t = this.token(cfg.token);
    const expr = this.exprFor(spec, live, t.decimals);

    const hash = await pool.withdraw(expr);
    return {
      ok: true,
      text:
        `Withdrawn — check the position to see whether it moved, because a withdrawal is ` +
        `all-or-nothing and there are TWO reasons it can move nothing. Asking for more than ` +
        `the position holds is one. The other is asking for more than the pool has liquid ` +
        `right now: some principal sits in Zama's vault between batches, and it comes back ` +
        `when a batch settles. Both succeed on chain and both leave the position untouched, ` +
        `so nothing is lost either way and a smaller amount goes through. The transaction ` +
        `succeeds on purpose — a revert would be visible, and what someone tried to take out ` +
        `is nobody else's business.`,
      data: { tx: hash },
    };
  }

  /**
   * The position, as references.
   *
   * Three numbers rather than one because they are three different facts: what
   * is earning weight in the next draw, what has ever been won, and what is won
   * but not yet compounded. Summing them would misstate the odds.
   */
  async poolPosition(args: { reveal: boolean }): Promise<ToolResult> {
    const live = this.requireLive();
    const pool = this.requirePool(live);
    const cfg = this.ctx.config.pool!;
    const t = this.token(cfg.token);

    const p = await pool.position();
    const inPool = this.newRefId("pool");
    const won = this.newRefId("won");
    const pending = this.newRefId("pend");
    live.refs.set(inPool, p.inPool);
    live.refs.set(won, p.won);
    live.refs.set(pending, p.pending);

    if (!args.reveal) {
      return {
        ok: true,
        text:
          `In the pool: ${inPool}. Won all time: ${won}. Won but not yet compounded: ` +
          `${pending}. These are references — I have not seen the numbers.`,
        data: { inPool, won, pending, token: t.symbol },
      };
    }
    return this.revealRef(inPool, "Reveal your pool position to the model?", t);
  }

  /** Public facts about the round. Nothing here is anybody's secret. */
  async poolStatus(): Promise<ToolResult> {
    const live = this.requireLive();
    const pool = this.requirePool(live);
    const s = await pool.status();

    if (s.round === 0) {
      return {
        ok: true,
        text: "No draw has been opened yet. A deposit now is in the first one.",
        data: { round: 0 },
      };
    }
    const when = new Date(s.snapshotAt * 1000).toISOString();
    const tail =
      s.state === "open"
        ? " The randomness is drawn and still encrypted — nobody knows the outcome yet."
        : s.state === "revealed"
          ? " Credits reach every participant, winner or not. Claiming is optional and reveals nothing."
          : "";
    // Formatted, with the symbol. This printed the raw base units, so a 1 cUSDC
    // prize read as "Prize 1000000" — a number the model has every reason to
    // repeat to the user as a million.
    const pt = this.token(this.ctx.config.pool!.token);
    // Every tier, with its odds. One number would be a lie now: the pool pays
    // three different prizes, and `everyNDraws` is literally how often each is
    // expected to be won — a property that holds whatever the balances are.
    const prize = s.tiers
      .map((t) =>
        t.everyNDraws === 1n
          ? `${formatAmount(t.prize, pt.decimals)} ${pt.symbol} every draw`
          : `${formatAmount(t.prize, pt.decimals)} ${pt.symbol} every ${t.everyNDraws} draws`,
      )
      .join(", ");
    return {
      ok: true,
      text: `Round ${s.round}, ${s.state}. Prize ${prize}. Weights frozen at ${when}.${tail}`,
      data: {
        round: s.round,
        state: s.state,
        prize: s.prize.toString(),
        prizeFormatted: prize,
        snapshotAt: s.snapshotAt,
      },
    };
  }

}

/** Turns an SDK error into something worth saying to a person. */
function explainFailure(e: unknown, symbol: string): string {
  if (e instanceof ZeroAmountError) {
    return "That amount is zero. The chain cannot tell a zero transfer from an insufficient balance, so I stop here rather than report something misleading.";
  }
  if (e instanceof RecipientNotAllowedError) {
    return `That address is not on this session's allowlist, so the session cannot send to it. Adding one needs the vault.`;
  }
  if (e instanceof OperatorNotGrantedError) {
    return `The ${symbol} operator grant has lapsed — it expires independently of the session. The session is alive but cannot move ${symbol} until it is renewed.`;
  }
  if (e instanceof ProtocolUnavailableError) {
    return `The FHEVM protocol is refusing this right now: ${e.message}. Nothing to do with your budget.`;
  }
  if (e instanceof SessionNotLiveError) {
    return `The session is ${e.reason.replace(/-/g, " ")}. Open a new one.`;
  }
  return `The send failed: ${(e as Error).message}`;
}

/** Builds the keystore the SDK should use. Memory only for tests. */
export function sessionKeystore(inMemory: boolean) {
  return inMemory
    ? memoryKeystore()
    : osKeychainKeystore({ dir: path.join(os.homedir(), ".savetogether", "sessions") });
}
