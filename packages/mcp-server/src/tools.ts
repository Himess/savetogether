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
import type { ConsoleServer } from "@ghostkey/console";
import {
  GhostKeyClient,
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
  type AmountRef,
  type Session,
} from "@ghostkey/sdk";
import { Contract, type Provider, formatEther } from "ethers";
import * as os from "node:os";
import * as path from "node:path";

import { formatAmount, parseAmount, type GhostKeyConfig, type TokenEntry } from "./config";
import { sanitiseChainText, untrusted } from "./sanitize";
import { Vault } from "./vault";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const WRAPPER_ABI = [
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function underlying() view returns (address)",
  "function rate() view returns (uint256)",
];

export interface ToolContext {
  readonly config: GhostKeyConfig;
  readonly provider: Provider;
  readonly client: GhostKeyClient;
  readonly vault: Vault;
  readonly console?: ConsoleServer;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly text: string;
  readonly data?: Record<string, unknown>;
}

/** Session state the tools share. One session at a time, deliberately. */
interface Live {
  session: Session;
  tier: "spend-only" | "balance-visible";
  vaultUnlocks: number;
  /** Refs handed to the model, keyed by an opaque id it can pass back. */
  refs: Map<string, AmountRef>;
}

export class GhostKeyTools {
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
   * The world check, deliberately performed AFTER argument validation.
   *
   * An unknown token or a malformed amount is the caller's mistake and costs one
   * lookup to detect. Reporting "no session is open" first sends a model off to
   * open a session and come back to the same error, having spent a vault unlock
   * on the round trip. Cheap and specific before expensive and situational.
   */
  private requireLive(): Live {
    if (this.live === null) throw new Error("no session is open; call open_session first");
    return this.live;
  }

  private newRefId(kind: string): string {
    return `${kind}_${Math.random().toString(36).slice(2, 10)}`;
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
      vault: (await this.ctx.vault.address()) ?? undefined,
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

    const entries = args.tokens.map((t) => this.token(t));
    const budgets = entries.map((t, i) => ({
      token: t.address,
      amount: parseAmount(args.budgets[i] ?? "0", t.decimals),
    }));
    for (const b of budgets) {
      if (b.amount === 0n) throw new Error("a zero budget would make the session useless");
    }

    const summary = entries.map((t, i) => `${args.budgets[i]} ${t.symbol}`).join(", ");
    const owner = await this.ctx.vault.unlock(
      `Open a session: ${summary} to ${args.allowlist.length} recipient(s), for ${args.ttlHours}h.` +
        (args.delegation ? " The session will also be able to read your balance." : ""),
    );

    // The transfer cap comes from the console, not from the tool call: a chat
    // client should not be able to talk a user into a wider one.
    const maxTxCount = this.ctx.console?.getSettings().maxTxCount ?? 0;

    const result = await this.ctx.client.openSession({
      owner,
      budgets,
      recipients: args.allowlist,
      expiry: new Date(Date.now() + args.ttlHours * 3_600_000),
      readScope: args.delegation ? "balance-visible" : "spend-only",
      ...(maxTxCount > 0 ? { maxTxCount } : {}),
    });

    // The SDK funds the session key during the open, while the owner is still
    // authorised, so nothing extra is needed here.

    // Locked again immediately. Everything after this runs on the session key.
    this.ctx.vault.lock();

    this.live = {
      session: result.session,
      tier: args.delegation ? "balance-visible" : "spend-only",
      vaultUnlocks: result.ownerAuthorisations,
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
  async canAfford(args: { token: string; amount: string }): Promise<ToolResult> {
    const t = this.token(args.token);
    const wanted = parseAmount(args.amount, t.decimals);
    const live = this.requireLive();
    const ok = await live.session.canAfford(t.address, wanted);
    return {
      ok: true,
      text: ok
        ? `Yes — ${args.amount} ${t.symbol} is within the remaining budget.`
        : `No — ${args.amount} ${t.symbol} exceeds the remaining budget.`,
      data: { affordable: ok },
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
        `Send ${t.symbol} to ${args.to}. Type the amount here; the model will not see it.`,
      );
      if (!answer.approved || answer.value === undefined) {
        return { ok: false, text: "Cancelled at the console. Nothing was sent." };
      }
      expr = exact(parseAmount(answer.value, t.decimals));
    } else if (live.refs.has(spec.split(":")[0] ?? "")) {
      const [id = "", op = ""] = spec.split(":");
      const r = live.refs.get(id);
      if (r === undefined) throw new Error(`unknown reference ${id}`);
      const base = ref(r);
      expr =
        op === "half"
          ? base.half()
          : op.startsWith("percent")
            ? base.percent(Number(op.split("=")[1] ?? "0"))
            : base;
    } else {
      expr = exact(parseAmount(spec, t.decimals));
    }

    // Warm the proof before anything else: it is twelve of the roughly thirty
    // seconds, and it does not depend on the chain.
    const prepared = live.session.prepare({ token: t.address, to: args.to, amount: expr });

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
      text: `Sent ${formatAmount(result.amount, t.decimals)} ${t.symbol} to ${args.to}.`,
      data: { status: "sent", amount: formatAmount(result.amount, t.decimals), tx: result.hash },
    };
  }

  // -------------------------------------------------------------------------
  // owner-authorised actions
  // -------------------------------------------------------------------------

  async addRecipient(args: { to: string }): Promise<ToolResult> {
    const live = this.requireLive();
    const owner = await this.ctx.vault.unlock(`Allow this session to send to ${args.to}.`);
    const hash = await live.session.addRecipient(args.to, owner);
    this.ctx.vault.lock();
    live.vaultUnlocks += 1;
    await this.pushStatus();
    return {
      ok: true,
      text: `${args.to} is now on the allowlist. Vault unlocks this session: ${live.vaultUnlocks}.`,
      data: { tx: hash, vaultUnlocks: live.vaultUnlocks },
    };
  }

  /**
   * Wrapping needs the vault, which the brief's tool list did not note: `wrap`
   * moves a PUBLIC ERC-20 balance the owner holds, so it is `approve` plus `wrap`
   * signed by the vault key, not by the session key.
   */
  async wrap(args: { token: string; amount: string }): Promise<ToolResult> {
    const t = this.token(args.token);
    if (t.underlying === undefined) {
      return {
        ok: false,
        text: `${t.symbol} is not a wrapper — there is no public token to wrap into it.`,
      };
    }
    const wrapper = new Contract(t.address, WRAPPER_ABI, this.ctx.provider);
    const underlying = new Contract(t.underlying, ERC20_ABI, this.ctx.provider);
    const decimals = Number((await underlying.decimals?.()) ?? t.decimals);
    const amount = parseAmount(args.amount, decimals);

    const owner = await this.ctx.vault.unlock(
      `Wrap ${args.amount} into ${t.symbol}. This moves a public balance, so it needs the vault.`,
    );
    const approveTx = await (underlying.connect(owner) as Contract).approve?.(t.address, amount);
    await approveTx?.wait();
    const wrapTx = await (wrapper.connect(owner) as Contract).wrap?.(
      await owner.getAddress(),
      amount,
    );
    const receipt = await wrapTx?.wait();
    this.ctx.vault.lock();
    if (this.live !== null) {
      this.live.vaultUnlocks += 1;
      await this.pushStatus();
    }
    return {
      ok: true,
      text: `Wrapped ${args.amount} into ${t.symbol}. The amount was public before and is confidential now.`,
      data: { tx: receipt?.hash },
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
      return {
        ok: false,
        text: "Revealing a number needs a click on the local console, and it is not running.",
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

  /** @internal for the CLI's status command */
  async vaultSummary(): Promise<{ address: string | null; balance: string }> {
    const address = await this.ctx.vault.address();
    if (address === null) return { address: null, balance: "0" };
    return { address, balance: formatEther(await this.ctx.provider.getBalance(address)) };
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
    : osKeychainKeystore({ dir: path.join(os.homedir(), ".ghostkey", "sessions") });
}
