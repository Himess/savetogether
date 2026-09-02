#!/usr/bin/env node
/**
 * `savetogether` — setup and status.
 *
 * `savetogether init` writes the Claude config, generates both keys, and prints the
 * funding address. No manual JSON editing, no network switching, no browser
 * extension. That is the whole point: if setup takes ten minutes nobody gets to
 * the part that is interesting.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { JsonRpcProvider, formatEther } from "ethers";

import { createServer } from "./index";
import {
  DEFAULT_CONFIG_PATH,
  loadConfig,
  saveConfig,
  type SaveTogetherConfig,
  type TokenEntry,
} from "./config";
import { Vault } from "./vault";

const SEPOLIA = 11155111;

/** Where Claude Desktop keeps its MCP server list, per platform. */
function claudeConfigPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      );
    case "win32":
      return path.join(
        process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json",
      );
    default:
      return path.join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

async function readJsonIfPresent(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Adds SaveTogether to the Claude config without disturbing whatever else is there.
 *
 * Merging rather than overwriting matters: this file usually already has other
 * servers in it, and a setup step that silently deletes a user's configuration is
 * a worse failure than one that does nothing.
 */
async function writeClaudeConfig(): Promise<string> {
  const file = claudeConfigPath();
  const existing = await readJsonIfPresent(file);
  const servers = (existing["mcpServers"] as Record<string, unknown> | undefined) ?? {};

  // This checkout's own entry point, not a published package: `npx` would
  // resolve nothing today, and `dist/cli.js` is the setup CLI -- `dist/index.js`
  // is the one that speaks MCP over stdio.
  servers["savetogether"] = {
    command: process.execPath,
    args: [path.join(__dirname, "index.js")],
  };
  existing["mcpServers"] = servers;

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(existing, null, 2)}\n`);
  return file;
}

/** The prize pool, and the token it settles in. One product, one config. */
const POOL_ADDRESS = "0x118Bc19eE40f2d3AB9c3B798F3e08f220e8d88DA";
const POOL_TOKEN = "cUSDC";

const SEPOLIA_STARTER_TOKENS: readonly TokenEntry[] = [
  {
    symbol: "gkUSD",
    address: "0xCFf87b42b916f7aA0F61CD060C9f48772F303D37",
    decimals: 6,
  },
  {
    // Six, and it has to match the token: the frontend once shipped a bug where
    // withdraw scaled by 1e6 and deposit did not, so asking for 5 sent
    // 5,000,000, the pool clamped it to an encrypted zero, and the transaction
    // SUCCEEDED having moved nothing -- silent, because the clamp is a privacy
    // feature. A wrong number here rebuilds that trap one layer up.
    symbol: POOL_TOKEN,
    address: "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639",
    decimals: 6,
    underlying: "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF",
  },
];

async function init(args: string[]): Promise<void> {
  const rpcUrl = flag(args, "--rpc") ?? process.env["SEPOLIA_RPC_URL"] ?? "";
  const moduleAddress = flag(args, "--module") ?? "0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6";
  if (rpcUrl === "") {
    throw new Error("pass --rpc <url> or set SEPOLIA_RPC_URL; a public node works but is slower");
  }

  const config: SaveTogetherConfig = {
    chainId: SEPOLIA,
    rpcUrl,
    moduleAddress,
    tokens: [...SEPOLIA_STARTER_TOKENS],
    // The prize pool this session client can act in. Optional: the session
    // layer is useful on its own, and a config written before the pool existed
    // has to keep loading rather than failing.
    pool: {
      address: flag(args, "--pool") ?? POOL_ADDRESS,
      token: flag(args, "--pool-token") ?? POOL_TOKEN,
    },
  };
  await saveConfig(config);

  const provider = new JsonRpcProvider(rpcUrl, SEPOLIA);
  const vault = new Vault({ provider, chainId: SEPOLIA });
  const vaultAddress = await vault.ensure();

  const claudeFile = await writeClaudeConfig();

  process.stdout.write(
    [
      "",
      "  SaveTogether is set up.",
      "",
      `  config           ${DEFAULT_CONFIG_PATH}`,
      `  Claude config    ${claudeFile}`,
      `  vault address    ${vaultAddress}`,
      "",
      "  Next:",
      "",
      "    savetogether console      open the local page",
      "",
      "  Send it some Sepolia ETH, mint test tokens from the page, then start Claude.",
      "  The vault key stays on this machine, encrypted, and unlocks once per session —",
      "  everything after that runs on a session key that cannot exceed the budget",
      "  you set or send outside the list you name.",
      "",
      "  No seed phrase was generated and none is needed. Nothing to write down.",
      "",
    ].join("\n"),
  );
}

/**
 * Runs the console with no chat client attached.
 *
 * Funding a vault and minting test tokens are setup, and setup should not require
 * a conversation to be open — you want the address before you have anything to
 * say. This is also how a first run works: init, open this, send some ETH, mint,
 * and only then start talking.
 */
async function consoleOnly(): Promise<void> {
  const handles = await createServer();
  process.stdout.write(
    [
      "",
      "  SaveTogether console",
      `  ${handles.console.url}`,
      "",
      "  Fund the vault from the page, mint some test tokens, then start Claude.",
      "  Ctrl-C to stop.",
      "",
    ].join("\n"),
  );

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void handles.stop().then(resolve);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function status(): Promise<void> {
  const cfg = await loadConfig();
  const provider = new JsonRpcProvider(cfg.rpcUrl, cfg.chainId);
  const vault = new Vault({ provider, chainId: cfg.chainId });
  const address = await vault.address();

  const balance = address === null ? "0" : formatEther(await provider.getBalance(address));

  process.stdout.write(
    [
      "",
      `  chain      ${cfg.chainId}`,
      `  module     ${cfg.moduleAddress}`,
      `  vault      ${address ?? "(not created — run `savetogether init`)"}`,
      `  gas        ${balance} ETH`,
      `  tokens     ${cfg.tokens.map((t) => t.symbol).join(", ")}`,
      "",
    ].join("\n"),
  );
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  switch (command) {
    case "init":
      await init(rest);
      return;
    case "console":
      await consoleOnly();
      return;
    case "status":
      await status();
      return;
    default:
      process.stdout.write(
        [
          "",
          "  savetogether init --rpc <url> [--module <address>]   set up config and keys",
          "  savetogether console                                 open the local console",
          "  savetogether status                                  show the vault and config",
          "",
        ].join("\n"),
      );
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`savetogether: ${(e as Error).message}\n`);
  process.exit(1);
});
