/**
 * The localhost console.
 *
 * Runs inside the MCP process rather than as a second daemon, so there is no IPC
 * to get wrong and nothing to start separately. It binds to 127.0.0.1 on an
 * ephemeral port and every request must carry a one-time token minted at startup,
 * so another local process cannot drive it.
 *
 * It exists for exactly three things, all of which must not happen in chat:
 * unlocking the vault, confirming that a number may be revealed to the model, and
 * typing an amount that must never enter the transcript.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { consoleHtml } from "./ui";

export type PendingKind = "unlock" | "reveal" | "sealed";

export interface Pending {
  readonly id: string;
  readonly kind: PendingKind;
  /** Shown verbatim on the page. Must already be sanitised by the caller. */
  readonly detail: string;
  readonly createdAt: number;
}

/** Whatever the console currently knows about the session, for the status panel. */
export interface ConsoleStatus {
  session: boolean;
  /**
   * The product's central claim, rendered as a number.
   *
   * Unlocks, not signatures: after one unlock the vault signs setOperator,
   * openSession and — on the balance-visible tier — delegateForUserDecryption.
   * Three signatures, one authorisation. The counter names the second.
   */
  vaultUnlocks: number;
  /**
   * What those unlocks were for, so the page can say it rather than show a bare
   * number. Sums to vaultUnlocks.
   */
  unlocks?: readonly { reason: string; n: number }[] | undefined;
  vault?: string | undefined;
  sessionKey?: string | undefined;
  expiry?: number | undefined;
  txCount?: number | undefined;
  maxTxCount?: number | undefined;
  recipients?: readonly string[] | undefined;
  tier?: "spend-only" | "balance-visible" | undefined;
}

/**
 * Values the user sets on the console and the session client reads at open time.
 *
 * A transfer cap is not a tool argument — a chat client should not be talking a
 * user into a wider one — so it lives here, next to the sentence explaining what
 * it buys.
 */
export interface ConsoleSettings {
  /** Maximum transfers per session. 0 means uncapped. */
  maxTxCount: number;
}

/**
 * Default cap.
 *
 * `docs/leakage.md` §3: reaching statistical significance on the residual gas
 * channel would need roughly 120 observations of the same skew. Fifty is
 * comfortably under that and generous for a day of ordinary use, so the default
 * is a real bound rather than a token one.
 */
export const DEFAULT_MAX_TX_COUNT = 50;

export interface Resolution {
  readonly approved: boolean;
  /** Only for `sealed`: the amount the user typed, as they typed it. */
  readonly value?: string | undefined;
}

interface Waiter {
  readonly pending: Pending;
  resolve(r: Resolution): void;
}

/**
 * What the console shows about the vault.
 *
 * Confidential token balances are deliberately absent: showing them would need a
 * decryption, and a decryption is the thing the whole product makes deliberate.
 * The console shows what is public — the address and the gas — and the
 * conversation is where you ask about the rest.
 */
export interface VaultPanel {
  readonly address: string;
  readonly ethBalance: string;
  readonly chainId: number;
  readonly chainName: string;
  /** Symbols the local config knows about, for the mint control. */
  readonly tokens: readonly string[];
  /** False off testnet, which hides the mint control entirely. */
  readonly canMint: boolean;
}

export interface ConsoleServerOptions {
  /** Called when the user presses the revoke button. */
  onRevoke?: () => Promise<void> | void;
  /** Reads the vault panel. Absent when the console runs without a chain. */
  onVault?: () => Promise<VaultPanel>;
  /** Mints test tokens to the vault. Testnet only; absent elsewhere. */
  onMint?: (symbol: string, amount: string) => Promise<string>;
  /** Seconds before an unanswered prompt resolves as denied. */
  timeoutSeconds?: number;
}

export class ConsoleServer {
  private readonly server: Server;
  private readonly token = randomBytes(24).toString("hex");
  private readonly waiters = new Map<string, Waiter>();
  private readonly listeners = new Set<ServerResponse>();
  private status: ConsoleStatus = { session: false, vaultUnlocks: 0 };
  private settings: ConsoleSettings = { maxTxCount: DEFAULT_MAX_TX_COUNT };
  private vault: VaultPanel | null = null;
  private vaultError: string | null = null;
  private port = 0;
  private stopped = false;

  constructor(private readonly opts: ConsoleServerOptions = {}) {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this.url;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const l of this.listeners) l.end();
    this.listeners.clear();
    for (const w of this.waiters.values()) w.resolve({ approved: false });
    this.waiters.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/?t=${this.token}`;
  }

  setStatus(patch: Partial<ConsoleStatus>): void {
    this.status = { ...this.status, ...patch };
    this.notify();
  }

  getStatus(): ConsoleStatus {
    return this.status;
  }

  /** Read by the session client when it opens a session. */
  getSettings(): ConsoleSettings {
    return this.settings;
  }

  /**
   * Reads the vault panel and pushes it to any open page.
   *
   * Called by the owner of this server once its dependencies exist — not from
   * start(), which runs before they do. Failures are recorded rather than
   * swallowed: a page showing dashes with no explanation is worse than one
   * saying it could not reach the chain, especially on a first run where the
   * user has nothing to compare against.
   */
  async refreshVault(): Promise<void> {
    if (this.opts.onVault === undefined) return;
    try {
      this.vault = await this.opts.onVault();
      this.vaultError = null;
    } catch (e) {
      this.vault = null;
      this.vaultError = (e as Error).message.slice(0, 200);
    }
    this.notify();
  }

  /**
   * Puts a request on the page and waits for the user.
   *
   * Denial on timeout rather than approval: the failure mode of an unattended
   * console must be that nothing happens, not that everything is approved.
   */
  ask(kind: PendingKind, detail: string): Promise<Resolution> {
    // Without this a prompt raised after the console has gone registers a waiter
    // nobody can ever answer, and the tool call hangs for the full timeout with
    // no page to click on. Failing immediately is the honest answer, and it lets
    // the caller say "the console is not running" instead of going quiet.
    if (this.stopped) {
      return Promise.resolve({ approved: false });
    }
    const id = randomBytes(9).toString("hex");
    const pending: Pending = { id, kind, detail, createdAt: Date.now() };
    return new Promise<Resolution>((resolve) => {
      const timeout = setTimeout(
        () => {
          if (this.waiters.delete(id)) {
            this.notify();
            resolve({ approved: false });
          }
        },
        (this.opts.timeoutSeconds ?? 180) * 1000,
      );
      this.waiters.set(id, {
        pending,
        resolve: (r) => {
          clearTimeout(timeout);
          resolve(r);
        },
      });
      this.notify();
    });
  }

  private notify(): void {
    for (const l of this.listeners) l.write(`data: tick\n\n`);
  }

  private authorised(req: IncomingMessage): boolean {
    const header = req.headers["x-savetogether-token"];
    if (typeof header === "string" && header === this.token) return true;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    return url.searchParams.get("t") === this.token || url.searchParams.get("token") === this.token;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (!this.authorised(req)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("this console is bound to one token");
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        // Nothing here loads anything remote, and nothing should be framed.
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      });
      res.end(consoleHtml(this.token));
      return;
    }

    if (url.pathname === "/api/state") {
      this.json(res, {
        status: this.status,
        settings: this.settings,
        vault: this.vault,
        vaultError: this.vaultError,
        pending: [...this.waiters.values()].map((w) => w.pending),
      });
      return;
    }

    if (url.pathname === "/api/vault" && req.method === "POST") {
      if (this.opts.onVault === undefined) {
        this.json(res, { ok: false, reason: "this console has no chain connection" });
        return;
      }
      await this.refreshVault();
      if (this.vaultError !== null) {
        this.json(res, { ok: false, reason: this.vaultError });
        return;
      }
      this.json(res, { ok: true, vault: this.vault });
      return;
    }

    if (url.pathname === "/api/mint" && req.method === "POST") {
      if (this.opts.onMint === undefined) {
        this.json(res, { ok: false, reason: "minting is not available here" });
        return;
      }
      const body = (await readJson(req)) as { symbol?: unknown; amount?: unknown };
      if (typeof body.symbol !== "string" || typeof body.amount !== "string") {
        this.json(res, { ok: false, reason: "symbol and amount must both be strings" });
        return;
      }
      try {
        const tx = await this.opts.onMint(body.symbol, body.amount);
        if (this.opts.onVault !== undefined) this.vault = await this.opts.onVault();
        this.notify();
        this.json(res, { ok: true, tx });
      } catch (e) {
        this.json(res, { ok: false, reason: (e as Error).message.slice(0, 200) });
      }
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      const body = (await readJson(req)) as { maxTxCount?: unknown };
      // Not Number(): it coerces null and "" to 0, which is a legitimate value
      // here meaning "uncapped". Junk must be rejected, not silently interpreted
      // as the most permissive setting.
      const raw = body.maxTxCount;
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 16_777_215) {
        this.json(res, { ok: false, reason: "maxTxCount must be an integer from 0 to 16777215" });
        return;
      }
      this.settings = { maxTxCount: raw };
      this.notify();
      this.json(res, { ok: true, settings: this.settings });
      return;
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": open\n\n");
      this.listeners.add(res);
      req.on("close", () => this.listeners.delete(res));
      return;
    }

    if (url.pathname === "/api/resolve" && req.method === "POST") {
      const body = (await readJson(req)) as { id?: string; approved?: boolean; value?: string };
      const waiter = body.id === undefined ? undefined : this.waiters.get(body.id);
      if (waiter === undefined) {
        this.json(res, { ok: false, reason: "no such pending request" });
        return;
      }
      this.waiters.delete(waiter.pending.id);
      waiter.resolve(
        body.value === undefined
          ? { approved: body.approved === true }
          : { approved: body.approved === true, value: body.value },
      );
      this.notify();
      this.json(res, { ok: true });
      return;
    }

    if (url.pathname === "/api/revoke" && req.method === "POST") {
      await this.opts.onRevoke?.();
      this.json(res, { ok: true });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  private json(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    size += buf.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

export { consoleHtml } from "./ui";
