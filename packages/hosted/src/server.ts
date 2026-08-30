/**
 * The hosted server.
 *
 * Four routes carry the whole product:
 *
 *   POST /api/session/prepare   the server generates a key and signs the digest
 *   POST /api/session/adopt     the server checks the CHAIN, then issues a URL
 *   GET  /api/session/:token    status, and the calls that revoke it
 *   ALL  /mcp/:token            MCP over streamable HTTP
 *
 * The ordering in `prepare` is forced by the contract rather than chosen.
 * `openSession` recovers `sessionKeySignature` and requires it to equal
 * `params.sessionKey` (GhostKeySession.sol:133), over a digest binding the owner
 * (:381). So the key must exist and sign before the user is asked for anything,
 * and the server must already know the owner's address at that moment — which is
 * why `prepare` takes it and why the whole open is one round trip.
 *
 * `adopt` is not a formality. Between prepare and adopt the only thing tying a
 * caller to a session is their own assertion, and an assertion is worthless.
 * `sessionOf` says who opened it, and nothing is served until that agrees.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as crypto from "node:crypto";

import { GhostKeyClient, type ReadScope } from "@ghostkey/sdk";
import { Contract, JsonRpcProvider, getAddress, isAddress } from "ethers";

import { ServerKeystore } from "./keystore";
import { SessionStore, type SessionRecord } from "./store";
import { McpEndpoints } from "./mcp";

const MODULE_ABI = [
  "function sessionOf(address sessionKey) view returns ((address owner,uint48 expiry,uint24 maxTxCount,uint24 txCount))",
  "function closeSession(address sessionKey)",
];
const TOKEN_ABI = ["function setOperator(address operator, uint48 until)"];
const ACL_ABI = ["function revokeDelegationForUserDecryption(address delegate, address contract_)"];

/** Sessions die after this unless the caller asks for less. */
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 24;

/** Per session, per window. A hosted key should not be a free transaction pump. */
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 60;

export interface HostedConfig {
  readonly rpcUrl: string;
  readonly moduleAddress: string;
  readonly aclAddress?: string;
  readonly chainId: number;
  readonly port: number;
  /** How the MCP URL is spelled back to the user. */
  readonly publicUrl: string;
  readonly pool?: { readonly address: string; readonly token: string };
  readonly tokens: ReadonlyArray<{ symbol: string; address: string; decimals: number }>;
}

interface PreparedPending {
  readonly token: string;
  readonly sessionKeyAddress: string;
  readonly ownerAddress: string;
  readonly calls: ReadonlyArray<{ to: string; data: string; value?: string }>;
  readonly expiry: number;
  readonly readScope: ReadScope;
  readonly tokens: readonly string[];
}

export class HostedServer {
  private server: Server | null = null;
  private readonly store = new SessionStore();
  private readonly provider: JsonRpcProvider;
  private readonly client: GhostKeyClient;
  private readonly mcp: McpEndpoints;
  /** Prepared but not yet confirmed on chain. Never served from. */
  private readonly pending = new Map<string, PreparedPending>();

  constructor(private readonly config: HostedConfig) {
    this.provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
    this.client = new GhostKeyClient({
      provider: this.provider,
      rpcUrl: config.rpcUrl,
      moduleAddress: config.moduleAddress,
      keystore: new ServerKeystore(this.store),
      chainId: config.chainId,
      ...(config.aclAddress === undefined ? {} : { aclAddress: config.aclAddress }),
    });
    this.mcp = new McpEndpoints({
      client: this.client,
      store: this.store,
      config,
    });
  }

  async start(): Promise<{ url: string; masterKeySource: string }> {
    const { masterKeySource } = await this.store.init();
    await this.store.sweep();

    this.server = createServer((req, res) => {
      void this.route(req, res).catch((e: unknown) => {
        // A hosted server that swallows its own failures is undebuggable, and
        // the one thing never logged here is anything secret.
        process.stderr.write(`[hosted] ${req.method} ${req.url} failed: ${(e as Error).stack ?? String(e)}
`);
        if (!res.headersSent) this.json(res, 500, { error: (e as Error).message });
        else res.end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.config.port, resolve));
    return { url: this.config.publicUrl, masterKeySource };
  }

  async stop(): Promise<void> {
    await this.mcp.closeAll();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  // -------------------------------------------------------------------------

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      ...this.cors(),
    });
    res.end(text);
  }

  /**
   * The browser opening a session is on a different origin from this server, so
   * these are load-bearing rather than decorative. Nothing here is authenticated
   * by origin — the MCP routes carry a bearer token and the session routes are
   * bounded by what the chain confirms.
   */
  private cors(): Record<string, string> {
    return {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-expose-headers": "mcp-session-id",
    };
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204, this.cors());
      res.end();
      return;
    }

    if (url.pathname === "/api/health") {
      this.json(res, 200, { ok: true, chainId: this.config.chainId });
      return;
    }

    if (url.pathname === "/api/session/prepare" && req.method === "POST") {
      await this.prepare(req, res);
      return;
    }
    if (url.pathname === "/api/session/adopt" && req.method === "POST") {
      await this.adopt(req, res);
      return;
    }

    const sessionMatch = /^\/api\/session\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (sessionMatch !== null) {
      if (req.method === "GET") {
        await this.status(sessionMatch[1]!, res);
        return;
      }
      if (req.method === "DELETE") {
        await this.forget(sessionMatch[1]!, res);
        return;
      }
    }

    const mcpMatch = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (mcpMatch !== null) {
      await this.handleMcp(mcpMatch[1]!, req, res);
      return;
    }

    this.json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  }

  // ---------------------------------------------------------------- step 2 --

  private async prepare(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = (await this.body(req)) as {
      ownerAddress?: string;
      budgets?: { token: string; amount: string }[];
      recipients?: string[];
      ttlHours?: number;
      readScope?: ReadScope;
    };

    if (typeof b?.ownerAddress !== "string" || !isAddress(b.ownerAddress)) {
      this.json(res, 400, { error: "ownerAddress must be an address" });
      return;
    }
    if (!Array.isArray(b.budgets) || b.budgets.length === 0) {
      this.json(res, 400, { error: "budgets must name at least one token" });
      return;
    }

    const ttl = Math.min(b.ttlHours ?? DEFAULT_TTL_HOURS, MAX_TTL_HOURS);
    const expiry = new Date(Date.now() + ttl * 3600 * 1000);
    const readScope: ReadScope = b.readScope === "balance-visible" ? "balance-visible" : "spend-only";

    const budgets = b.budgets.map((x) => {
      const entry = this.config.tokens.find(
        (t) =>
          t.symbol.toLowerCase() === x.token.toLowerCase() ||
          t.address.toLowerCase() === x.token.toLowerCase(),
      );
      if (entry === undefined) throw new Error(`unknown token ${x.token}`);
      return { token: entry.address, amount: BigInt(x.amount) };
    });

    // The pool is always an allowed recipient when one is configured: it is
    // where a deposit goes, and a session that cannot reach it is inert.
    const recipients = [
      ...new Set([
        ...(b.recipients ?? []).filter(isAddress).map(getAddress),
        ...(this.config.pool === undefined ? [] : [getAddress(this.config.pool.address)]),
      ]),
    ];

    const prepared = await this.client.prepareSession({
      ownerAddress: getAddress(b.ownerAddress),
      budgets,
      recipients,
      expiry,
      readScope,
      label: `hosted ${new Date().toISOString()}`,
    });

    const token = crypto.randomBytes(32).toString("base64url");
    this.pending.set(token, {
      token,
      sessionKeyAddress: prepared.sessionKeyAddress,
      ownerAddress: getAddress(b.ownerAddress),
      calls: prepared.calls.map((c) => ({
        to: c.to,
        data: c.data,
        ...(c.value === undefined ? {} : { value: `0x${c.value.toString(16)}` }),
      })),
      expiry: prepared.expiry,
      readScope,
      tokens: prepared.tokens,
    });

    this.json(res, 200, {
      sessionToken: token,
      sessionKeyAddress: prepared.sessionKeyAddress,
      calls: this.pending.get(token)!.calls,
      expiry: prepared.expiry,
      // So the browser can show what it is about to authorise, rather than a
      // wall of calldata.
      summary: {
        tokens: prepared.tokens,
        recipients,
        readScope,
        ttlHours: ttl,
      },
    });
  }

  // ---------------------------------------------------------------- step 6 --

  private async adopt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const b = (await this.body(req)) as { sessionToken?: string };
    const pending = typeof b?.sessionToken === "string" ? this.pending.get(b.sessionToken) : undefined;
    if (pending === undefined) {
      this.json(res, 404, { error: "no prepared session with that token" });
      return;
    }

    // The chain, not the caller. A claim is not evidence.
    try {
      await this.client.adoptSession(
        pending.sessionKeyAddress,
        pending.ownerAddress,
        pending.readScope,
      );
    } catch (e) {
      this.json(res, 409, { error: (e as Error).message });
      return;
    }

    const record: SessionRecord = {
      token: pending.token,
      sessionKeyAddress: pending.sessionKeyAddress,
      ownerAddress: pending.ownerAddress,
      moduleAddress: this.config.moduleAddress,
      tokens: pending.tokens,
      readScope: pending.readScope,
      expiry: pending.expiry,
      createdAt: Math.floor(Date.now() / 1000),
      adopted: true,
      callCount: 0,
      windowStart: Math.floor(Date.now() / 1000),
    };
    await this.store.put(record);
    this.pending.delete(pending.token);

    this.json(res, 200, {
      mcpUrl: `${this.config.publicUrl}/mcp/${record.token}`,
      sessionKeyAddress: record.sessionKeyAddress,
      expiry: record.expiry,
    });
  }

  // -------------------------------------------------------------------- P2 --

  /**
   * Status, and the three transactions that end it.
   *
   * Handed back as calldata the user's own wallet sends, because a revocation
   * that depends on this server being alive and honest is not a revocation. Each
   * one stands alone and any of them is enough to stop value moving.
   */
  private async status(token: string, res: ServerResponse): Promise<void> {
    const record = this.store.get(token);
    if (record === undefined) {
      this.json(res, 404, { error: "no such session" });
      return;
    }

    const module = new Contract(record.moduleAddress, MODULE_ABI, this.provider);
    const s = await module.sessionOf!(record.sessionKeyAddress);
    const live = BigInt(s.expiry) > 0n;

    const moduleIface = new Contract(record.moduleAddress, MODULE_ABI, this.provider).interface;
    const tokenIface = new Contract(record.tokens[0] ?? record.moduleAddress, TOKEN_ABI, this.provider)
      .interface;
    const aclIface = new Contract(
      this.config.aclAddress ?? record.moduleAddress,
      ACL_ABI,
      this.provider,
    ).interface;

    const revoke = [
      {
        what: "closeSession — the session stops existing",
        to: record.moduleAddress,
        data: moduleIface.encodeFunctionData("closeSession", [record.sessionKeyAddress]),
      },
      ...record.tokens.map((t) => ({
        what: `setOperator(module, 0) on ${t} — the module loses move authority`,
        to: t,
        data: tokenIface.encodeFunctionData("setOperator", [record.moduleAddress, 0]),
      })),
      ...(record.readScope === "balance-visible" && this.config.aclAddress !== undefined
        ? record.tokens.map((t) => ({
            what: `revokeDelegationForUserDecryption on ${t} — the key loses read authority`,
            to: this.config.aclAddress!,
            data: aclIface.encodeFunctionData("revokeDelegationForUserDecryption", [
              record.sessionKeyAddress,
              t,
            ]),
          }))
        : []),
    ];

    this.json(res, 200, {
      sessionKeyAddress: record.sessionKeyAddress,
      ownerAddress: record.ownerAddress,
      live,
      onChainExpiry: Number(s.expiry),
      txCount: Number(s.txCount),
      readScope: record.readScope,
      tokens: record.tokens,
      revoke,
    });
  }

  /** Housekeeping. The chain already stopped the key; this drops the key too. */
  private async forget(token: string, res: ServerResponse): Promise<void> {
    const record = this.store.get(token);
    if (record === undefined) {
      this.json(res, 404, { error: "no such session" });
      return;
    }
    const module = new Contract(record.moduleAddress, MODULE_ABI, this.provider);
    const s = await module.sessionOf!(record.sessionKeyAddress);
    if (BigInt(s.expiry) > 0n) {
      this.json(res, 409, {
        error:
          "that session is still open on chain. Close it from your own wallet first — " +
          "forgetting the key here would leave a live session nobody is watching.",
      });
      return;
    }
    await this.mcp.close(token);
    await this.store.forget(token);
    this.json(res, 200, { forgotten: true });
  }

  // ------------------------------------------------------------------- MCP --

  private async handleMcp(
    token: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const record = this.store.get(token);
    if (record === undefined || !record.adopted) {
      this.json(res, 401, { error: "unknown session" });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (record.expiry <= now) {
      await this.store.forget(token);
      this.json(res, 401, { error: "this session has expired" });
      return;
    }

    if (now - record.windowStart >= RATE_WINDOW_SECONDS) {
      record.windowStart = now;
      record.callCount = 0;
    }
    record.callCount += 1;
    if (record.callCount > RATE_LIMIT) {
      this.json(res, 429, { error: `more than ${RATE_LIMIT} calls in a minute` });
      return;
    }

    for (const [k, v] of Object.entries(this.cors())) res.setHeader(k, v);
    await this.mcp.handle(record, req, res, await this.bodyOrUndefined(req));
  }

  private async bodyOrUndefined(req: IncomingMessage): Promise<unknown> {
    if (req.method !== "POST") return undefined;
    try {
      return await this.body(req);
    } catch {
      return undefined;
    }
  }
}
