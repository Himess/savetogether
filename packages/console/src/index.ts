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
  /** The product's central claim, rendered as a number. */
  signatures: number;
  vault?: string | undefined;
  sessionKey?: string | undefined;
  expiry?: number | undefined;
  txCount?: number | undefined;
  maxTxCount?: number | undefined;
  recipients?: readonly string[] | undefined;
  tier?: "spend-only" | "balance-visible" | undefined;
}

export interface Resolution {
  readonly approved: boolean;
  /** Only for `sealed`: the amount the user typed, as they typed it. */
  readonly value?: string | undefined;
}

interface Waiter {
  readonly pending: Pending;
  resolve(r: Resolution): void;
}

export interface ConsoleServerOptions {
  /** Called when the user presses the revoke button. */
  onRevoke?: () => Promise<void> | void;
  /** Seconds before an unanswered prompt resolves as denied. */
  timeoutSeconds?: number;
}

export class ConsoleServer {
  private readonly server: Server;
  private readonly token = randomBytes(24).toString("hex");
  private readonly waiters = new Map<string, Waiter>();
  private readonly listeners = new Set<ServerResponse>();
  private status: ConsoleStatus = { session: false, signatures: 0 };
  private port = 0;

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

  /**
   * Puts a request on the page and waits for the user.
   *
   * Denial on timeout rather than approval: the failure mode of an unattended
   * console must be that nothing happens, not that everything is approved.
   */
  ask(kind: PendingKind, detail: string): Promise<Resolution> {
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
    const header = req.headers["x-ghostkey-token"];
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
        pending: [...this.waiters.values()].map((w) => w.pending),
      });
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
