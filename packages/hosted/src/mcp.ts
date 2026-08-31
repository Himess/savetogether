/**
 * MCP over streamable HTTP, one endpoint per session.
 *
 * The tool surface is the SAME one the local server exposes, minus the tools
 * that would need a wallet key. That is not a convenience: a hosted tool list
 * that had drifted from the local one would make the local path stop being
 * evidence for anything, and the local path existing is how we know the server
 * is not load-bearing.
 *
 * WHAT IS WITHHELD, and why each one:
 *
 *   open_session    the browser did it. There is no vault here to unlock.
 *   (wrap is NOT withheld any more: it now wraps for the account this session
 *   acts as, which hosted is the session key holding its own position.)
 *   add_recipient   widening the allowlist is exactly the authority the owner
 *                   kept. It belongs in their wallet, not in a chat message.
 *
 * Withheld rather than left in to fail: a tool that is present and always errors
 * teaches a model to retry, and costs the user a confusing paragraph each time.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GhostKeyTools, toolDefinitions, type GhostKeyConfig } from "@ghostkey/mcp-server";
import type { GhostKeyClient } from "@ghostkey/sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import { JsonRpcProvider } from "ethers";

import type { MemoryKeystore } from "./keystore";
import type { SessionToken } from "./token";

const WITHHELD = new Set(["open_session", "add_recipient"]);

export interface McpEndpointsConfig {
  readonly client: GhostKeyClient;
  readonly keystore: MemoryKeystore;
  readonly config: {
    readonly rpcUrl: string;
    readonly chainId: number;
    readonly moduleAddress: string;
    readonly aclAddress?: string;
    readonly pool?: { readonly address: string; readonly token: string };
    readonly vault?: { readonly adapter: string; readonly batcher?: string };
    readonly tokens: ReadonlyArray<{
    symbol: string;
    address: string;
    decimals: number;
    /** The public ERC-20 this wraps, when it is a wrapper. Wrapping needs it. */
    underlying?: string;
  }>;
  };
}

/**
 * What is worth keeping between requests, and what is not.
 *
 * The tools hold the live session — a decrypted key and the refs already handed
 * to the model — so they are cached per session and outlive any one request. The
 * MCP transport is the opposite: a stateless one refuses to serve twice, by
 * design, because reusing it collides message ids between clients. So the
 * expensive half is kept and the cheap half is rebuilt, rather than paying for a
 * chain read and a key decryption on every tool call.
 */
interface Attached {
  readonly tools: GhostKeyTools;
  readonly defs: ReturnType<typeof toolDefinitions>;
}

export class McpEndpoints {
  private readonly attached = new Map<string, Attached>();

  constructor(private readonly deps: McpEndpointsConfig) {}

  async handle(
    token: string,
    session: SessionToken,
    sessionKeyAddress: string,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const { defs } =
      this.attached.get(token) ?? (await this.build(token, session, sessionKeyAddress));

    const server = new Server(
      { name: "ghostpool", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    this.wire(server, defs);

    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    // The transport's optional members are declared `prop?: T` while the class
    // assigns them `T | undefined`, which exactOptionalPropertyTypes treats as
    // different types. The cast is at this one boundary rather than by relaxing
    // the setting for the whole package.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    try {
      await transport.handleRequest(req, res, body);
    } finally {
      await server.close();
    }
  }

  private wire(server: Server, defs: ReturnType<typeof toolDefinitions>): void {
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: defs.map((d) => ({
        name: d.name,
        title: d.title,
        description: d.description,
        inputSchema: d.schema,
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const def = defs.find((d) => d.name === request.params.name);
      if (def === undefined) {
        return {
          content: [{ type: "text" as const, text: `no such tool: ${request.params.name}` }],
          isError: true,
        };
      }
      try {
        const args: unknown = def.validate.parse(request.params.arguments ?? {});
        const result = await def.run(args);
        return { content: [{ type: "text" as const, text: result.text }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `${(e as Error).message}` }],
          isError: true,
        };
      }
    });
  }

  private async build(
    token: string,
    session: SessionToken,
    sessionKeyAddress: string,
  ): Promise<Attached> {
    const cfg: GhostKeyConfig = {
      chainId: this.deps.config.chainId,
      rpcUrl: this.deps.config.rpcUrl,
      moduleAddress: this.deps.config.moduleAddress,
      tokens: this.deps.config.tokens.map((t) => ({ ...t })),
      ...(this.deps.config.aclAddress === undefined
        ? {}
        : { aclAddress: this.deps.config.aclAddress }),
      ...(this.deps.config.pool === undefined ? {} : { pool: { ...this.deps.config.pool } }),
      ...(this.deps.config.vault === undefined ? {} : { vault: { ...this.deps.config.vault } }),
    };

    // No vault, and no way to acquire one. The tools that would have unlocked it
    // are not in the list below, and `ToolContext.vault` is left undefined so a
    // future tool that reached for one fails loudly here rather than quietly
    // somewhere a user is watching.
    const tools = new GhostKeyTools({
      config: cfg,
      provider: new JsonRpcProvider(this.deps.config.rpcUrl, this.deps.config.chainId),
      client: this.deps.client,
    });

    // The key comes out of the token the caller presented, is used to build the
    // session, and is dropped again. Nothing here outlives the process, and the
    // process holding nothing is what lets it be restarted or moved.
    this.deps.keystore.put(sessionKeyAddress, session.privateKey);
    let live;
    try {
      live = await this.deps.client.resumeSession(sessionKeyAddress, session.readScope);
    } finally {
      this.deps.keystore.forget(sessionKeyAddress);
    }
    tools.attachSession(live, session.readScope);

    const defs = toolDefinitions(tools).filter((d) => !WITHHELD.has(d.name));

    const attached: Attached = { tools, defs };
    this.attached.set(token, attached);
    return attached;
  }

  /** Drops a session's tools, and with them the decrypted key they held. */
  async close(token: string): Promise<void> {
    this.attached.delete(token);
  }

  async closeAll(): Promise<void> {
    this.attached.clear();
  }
}
