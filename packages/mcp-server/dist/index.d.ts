/**
 * The MCP server.
 *
 * Wires the tool surface to a chat client over stdio, and starts the localhost
 * console in the same process so there is no second daemon and no IPC.
 *
 * TERMINOLOGY, everywhere in this package: the `session client` is this process —
 * it holds the keys, builds ciphertexts, and necessarily knows plaintext amounts
 * because it chose them. The `model` is the language model on the other end of
 * stdio, and by default sees no amount at all. The word "agent" is never used
 * alone, because the privacy claim is exactly the distinction between the two.
 *
 * WHY THE LOW-LEVEL SERVER API. `McpServer.registerTool` infers each handler's
 * argument type from a zod shape, and that mapped type is deep enough that any
 * schema containing an array exhausts TypeScript's instantiation budget (TS2589);
 * nesting an object exhausts the compiler's heap outright. The alternative was to
 * contort the tool schemas to keep an inference engine happy — no arrays in tools
 * that fundamentally take lists — which is the tail wagging the dog. So the
 * schemas are written as JSON Schema and validated with zod explicitly. More code,
 * better control: the exact JSON the model sees lives here, next to the prose that
 * explains it.
 */
import { ConsoleServer } from "@ghostkey/console";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import { type GhostKeyConfig } from "./config";
import { GhostKeyTools, type ToolResult } from "./tools";
export interface ServerHandles {
    readonly server: Server;
    readonly console: ConsoleServer;
    readonly tools: GhostKeyTools;
    stop(): Promise<void>;
}
type JsonSchema = Record<string, unknown>;
/**
 * A tool, with its schema and its validator side by side.
 *
 * They are separate objects that must agree, which is a real hazard — so every
 * definition below carries both, and the unit tests assert that each validator
 * accepts exactly the shape its schema advertises.
 */
interface ToolDef {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly schema: JsonSchema;
    readonly validate: z.ZodTypeAny;
    run(args: unknown): Promise<ToolResult>;
}
/** Built separately so tests can inspect the surface without opening a socket. */
export declare function toolDefinitions(tools: GhostKeyTools): ToolDef[];
export declare function createServer(config?: GhostKeyConfig): Promise<ServerHandles>;
export declare function main(): Promise<void>;
export { GhostKeyTools } from "./tools";
export type { ToolResult } from "./tools";
export { Vault, SEPOLIA_CHAIN_ID } from "./vault";
export { loadConfig, saveConfig, parseAmount, formatAmount } from "./config";
export type { GhostKeyConfig, TokenEntry } from "./config";
export { sanitiseChainText } from "./sanitize";
