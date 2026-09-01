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
 * `params.sessionKey` (SaveTogetherSession.sol:133), over a digest binding the owner
 * (:381). So the key must exist and sign before the user is asked for anything,
 * and the server must already know the owner's address at that moment — which is
 * why `prepare` takes it and why the whole open is one round trip.
 *
 * NOTHING IS STORED. The bearer token is the session record, sealed under a
 * master key held only in the environment, so a restart costs nothing and any
 * process with the same key can serve a URL a user pasted into a chat client
 * days ago. The consequence worth naming: with no record to mark closed, every
 * request asks the chain whether the session is still live, so revocation takes
 * effect immediately and without this server being told.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { SaveTogetherClient, type ReadScope } from "@savetogether/sdk";
import { Contract, JsonRpcProvider, getAddress, isAddress } from "ethers";

import { MemoryKeystore } from "./keystore";
import { McpEndpoints } from "./mcp";
import { TokenSealer, type SessionToken } from "./token";

const MODULE_ABI = [
  "function sessionOf(address sessionKey) view returns ((address owner,uint48 expiry,uint24 maxTxCount,uint24 txCount))",
  "function closeSession(address sessionKey)",
];
const TOKEN_ABI = ["function setOperator(address operator, uint48 until)"];
const ACL_ABI = ["function revokeDelegationForUserDecryption(address delegate, address contract_)"];

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
  /** How the MCP URL is spelled back to the user, including any path prefix. */
  readonly publicUrl: string;
  /**
   * Origins allowed to call the session routes.
   *
   * Explicit rather than `*`: two origins exist now, the frontend and this
   * server, and a wildcard would let any page start a session-opening flow
   * against a user's wallet. The MCP route needs no CORS at all — it is fetched
   * by a chat client's servers, not by a browser.
   */
  readonly allowedOrigins: readonly string[];
  readonly pool?: { readonly address: string; readonly token: string };
  /** The adapter on Zama's confidential vault, when one is deployed. */
  readonly vault?: { readonly adapter: string; readonly batcher?: string };
  readonly tokens: ReadonlyArray<{
    symbol: string;
    address: string;
    decimals: number;
    /** The public ERC-20 this wraps, when it is a wrapper. Wrapping needs it. */
    underlying?: string;
  }>;
}

export class HostedServer {
  private server: Server | null = null;
  private readonly provider: JsonRpcProvider;
  private readonly keystore = new MemoryKeystore();
  private readonly client: SaveTogetherClient;
  private readonly mcp: McpEndpoints;
  private readonly sealer: TokenSealer;
  /** Session-scoped rate limits. Losing these on restart is acceptable. */
  private readonly rate = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly config: HostedConfig,
    sealer: TokenSealer = TokenSealer.fromEnv(),
  ) {
    this.sealer = sealer;
    this.provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
    this.client = new SaveTogetherClient({
      provider: this.provider,
      rpcUrl: config.rpcUrl,
      moduleAddress: config.moduleAddress,
      keystore: this.keystore,
      chainId: config.chainId,
      ...(config.aclAddress === undefined ? {} : { aclAddress: config.aclAddress }),
    });
    this.mcp = new McpEndpoints({
      client: this.client,
      keystore: this.keystore,
      config,
    });
  }

  async start(): Promise<{ url: string }> {
    this.server = createServer((req, res) => {
      void this.route(req, res).catch((e: unknown) => {
        // A hosted server that swallows its own failures is undebuggable, and
        // nothing secret is ever written here.
        process.stderr.write(
          `[hosted] ${req.method} ${req.url} failed: ${(e as Error).stack ?? String(e)}\n`,
        );
        if (!res.headersSent) this.json(res, 500, { error: (e as Error).message });
        else res.end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.config.port, resolve));
    return { url: this.config.publicUrl };
  }

  async stop(): Promise<void> {
    await this.mcp.closeAll();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  // -------------------------------------------------------------------------

  private cors(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !this.config.allowedOrigins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      vary: "Origin",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    };
  }

  private json(res: ServerResponse, status: number, body: unknown, cors: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      ...cors,
    });
    res.end(text);
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
    const cors = this.cors(req);

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // A person who pastes the base URL into a browser gets an explanation, not
    // `no route for GET /`. They are not lost — there is genuinely no page here
    // — but an API that answers a human with an error reads as broken, and the
    // first person to try it did exactly that and asked whether it was down.
    if (url.pathname === "/" || url.pathname === "") {
      this.json(
        res,
        200,
        {
          service: "ghostpool-hosted",
          what: "The server behind SaveTogether's conversational layer. There is no page here.",
          openASession: "https://ghostpool-himess.vercel.app",
          endpoints: {
            "GET /api/health": "liveness",
            "POST /api/session/prepare": "generate a session key and return the calls your wallet signs",
            "POST /api/session/adopt": "confirm on chain, then issue the MCP URL",
            "GET /api/session/:token": "status, and the calls that revoke it",
            "ALL /mcp/:token": "MCP over streamable HTTP — for a chat client, not a browser",
          },
          holds: "session keys, sealed into the bearer token. No wallet keys, no database.",
        },
        cors,
      );
      return;
    }

    if (url.pathname === "/api/health") {
      this.json(res, 200, { ok: true, chainId: this.config.chainId }, cors);
      return;
    }
    if (url.pathname === "/api/session/prepare" && req.method === "POST") {
      await this.prepare(req, res, cors);
      return;
    }
    if (url.pathname === "/api/session/adopt" && req.method === "POST") {
      await this.adopt(req, res, cors);
      return;
    }

    const sessionMatch = /^\/api\/session\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (sessionMatch !== null && req.method === "GET") {
      await this.status(sessionMatch[1]!, res, cors);
      return;
    }

    const mcpMatch = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (mcpMatch !== null) {
      await this.handleMcp(mcpMatch[1]!, req, res);
      return;
    }

    this.json(res, 404, { error: `no route for ${req.method} ${url.pathname}` }, cors);
  }

  // ---------------------------------------------------------------- step 2 --

  private async prepare(
    req: IncomingMessage,
    res: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    const b = (await this.body(req)) as {
      ownerAddress?: string;
      budgets?: { token: string; amount: string }[];
      recipients?: string[];
      ttlHours?: number;
      readScope?: ReadScope;
    };

    if (typeof b?.ownerAddress !== "string" || !isAddress(b.ownerAddress)) {
      this.json(res, 400, { error: "ownerAddress must be an address" }, cors);
      return;
    }
    if (!Array.isArray(b.budgets) || b.budgets.length === 0) {
      this.json(res, 400, { error: "budgets must name at least one token" }, cors);
      return;
    }

    const ttl = Math.min(b.ttlHours ?? DEFAULT_TTL_HOURS, MAX_TTL_HOURS);
    const expiryDate = new Date(Date.now() + ttl * 3600 * 1000);
    const readScope: ReadScope =
      b.readScope === "balance-visible" ? "balance-visible" : "spend-only";

    const budgets = b.budgets.map((x) => {
      const entry = this.config.tokens.find(
        (t) =>
          t.symbol.toLowerCase() === x.token.toLowerCase() ||
          t.address.toLowerCase() === x.token.toLowerCase(),
      );
      if (entry === undefined) throw new Error(`unknown token ${x.token}`);
      return { token: entry.address, amount: BigInt(x.amount) };
    });

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
      expiry: expiryDate,
      readScope,
      label: `hosted ${new Date().toISOString()}`,
    });

    // Seal the key into the token and drop it. From here the server keeps
    // nothing: the only copy that survives this request is the one in the URL
    // the caller is about to receive.
    const wallet = await this.keystore.load(prepared.sessionKeyAddress);
    const token = this.sealer.seal({
      privateKey: wallet.privateKey,
      ownerAddress: getAddress(b.ownerAddress),
      expiry: prepared.expiry,
      readScope,
      tokens: prepared.tokens,
    });
    this.keystore.forget(prepared.sessionKeyAddress);

    this.json(
      res,
      200,
      {
        sessionToken: token,
        sessionKeyAddress: prepared.sessionKeyAddress,
        calls: prepared.calls.map((c) => ({
          to: c.to,
          data: c.data,
          ...(c.value === undefined ? {} : { value: `0x${c.value.toString(16)}` }),
        })),
        expiry: prepared.expiry,
        summary: { tokens: prepared.tokens, recipients, readScope, ttlHours: ttl },
      },
      cors,
    );
  }

  // ---------------------------------------------------------------- step 6 --

  private async adopt(
    req: IncomingMessage,
    res: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    const b = (await this.body(req)) as { sessionToken?: string };
    if (typeof b?.sessionToken !== "string") {
      this.json(res, 400, { error: "sessionToken is required" }, cors);
      return;
    }

    let session: SessionToken;
    try {
      session = this.sealer.open(b.sessionToken);
    } catch (e) {
      this.json(res, 400, { error: (e as Error).message }, cors);
      return;
    }

    // The chain, not the caller. A claim is not evidence.
    const address = await this.addressOf(session);
    try {
      this.keystore.put(address, session.privateKey);
      await this.client.adoptSession(address, session.ownerAddress, session.readScope);
    } catch (e) {
      this.json(res, 409, { error: (e as Error).message }, cors);
      return;
    } finally {
      this.keystore.forget(address);
    }

    this.json(
      res,
      200,
      {
        mcpUrl: `${this.config.publicUrl}/mcp/${b.sessionToken}`,
        sessionKeyAddress: address,
        expiry: session.expiry,
      },
      cors,
    );
  }

  private async addressOf(session: SessionToken): Promise<string> {
    const { Wallet } = await import("ethers");
    return new Wallet(session.privateKey).address;
  }

  // -------------------------------------------------------------------- P2 --

  /**
   * Status, and the three transactions that end it.
   *
   * Handed back as calldata the user's own wallet sends, because a revocation
   * that depends on this server being alive and honest is not a revocation.
   */
  private async status(
    token: string,
    res: ServerResponse,
    cors: Record<string, string>,
  ): Promise<void> {
    let session: SessionToken;
    try {
      session = this.sealer.open(token);
    } catch (e) {
      this.json(res, 404, { error: (e as Error).message }, cors);
      return;
    }
    const address = await this.addressOf(session);

    const module = new Contract(this.config.moduleAddress, MODULE_ABI, this.provider);
    const s = await module.sessionOf!(address);
    const live = BigInt(s.expiry) > 0n;

    const moduleIface = module.interface;
    const tokenIface = new Contract(
      session.tokens[0] ?? this.config.moduleAddress,
      TOKEN_ABI,
      this.provider,
    ).interface;
    const aclIface = new Contract(
      this.config.aclAddress ?? this.config.moduleAddress,
      ACL_ABI,
      this.provider,
    ).interface;

    const revoke = [
      {
        what: "closeSession — the session stops existing",
        to: this.config.moduleAddress,
        data: moduleIface.encodeFunctionData("closeSession", [address]),
      },
      ...session.tokens.map((t) => ({
        what: `setOperator(module, 0) on ${t} — the module loses move authority`,
        to: t,
        data: tokenIface.encodeFunctionData("setOperator", [this.config.moduleAddress, 0]),
      })),
      ...(session.readScope === "balance-visible" && this.config.aclAddress !== undefined
        ? session.tokens.map((t) => ({
            what: `revokeDelegationForUserDecryption on ${t} — the key loses read authority`,
            to: this.config.aclAddress!,
            data: aclIface.encodeFunctionData("revokeDelegationForUserDecryption", [address, t]),
          }))
        : []),
    ];

    this.json(
      res,
      200,
      {
        sessionKeyAddress: address,
        ownerAddress: session.ownerAddress,
        live,
        onChainExpiry: Number(s.expiry),
        txCount: Number(s.txCount),
        readScope: session.readScope,
        tokens: session.tokens,
        revoke,
      },
      cors,
    );
  }

  // ------------------------------------------------------------------- MCP --

  private async handleMcp(
    token: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let session: SessionToken;
    try {
      session = this.sealer.open(token);
    } catch (e) {
      this.json(res, 401, { error: (e as Error).message });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (session.expiry <= now) {
      this.json(res, 401, { error: "this session has expired" });
      return;
    }

    // No record to consult, so the chain is asked every time. That is the point:
    // an owner who revoked a minute ago is not relying on this process having
    // been told about it.
    const address = await this.addressOf(session);
    const module = new Contract(this.config.moduleAddress, MODULE_ABI, this.provider);
    const s = await module.sessionOf!(address);
    if (BigInt(s.expiry) === 0n) {
      await this.mcp.close(token);
      this.json(res, 401, {
        error: "this session has been closed by its owner and can no longer act",
      });
      return;
    }
    if (s.owner.toLowerCase() !== session.ownerAddress.toLowerCase()) {
      this.json(res, 401, { error: "this token does not match the session on chain" });
      return;
    }

    const window = this.rate.get(token) ?? { count: 0, windowStart: now };
    if (now - window.windowStart >= RATE_WINDOW_SECONDS) {
      window.windowStart = now;
      window.count = 0;
    }
    window.count += 1;
    this.rate.set(token, window);
    if (window.count > RATE_LIMIT) {
      this.json(res, 429, { error: `more than ${RATE_LIMIT} calls in a minute` });
      return;
    }

    await this.mcp.handle(token, session, address, req, res, await this.bodyOrUndefined(req));
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
