#!/usr/bin/env node
/**
 * `ghostpool-hosted` — the server behind the website.
 *
 * Holds nothing. Session keys are sealed into the bearer token under
 * `GHOSTPOOL_MASTER_KEY`, so this process can be restarted, redeployed or moved
 * to another machine and every URL a user has already pasted into a chat client
 * keeps working. There is no database and no file of private keys.
 */
import { HostedServer } from "./server";

const SEPOLIA = 11155111;

/** Zama's deployed confidential vault, reached through GhostPool's adapter. */
const ZAMA_VAULT_ADAPTER = "0xc5120E26aafdD76D324E62cF19c391C367Cf99Ba";
const ZAMA_DEPOSIT_BATCHER = "0x48758559c14d4d92b4C74A99660B6a8dbe85F53b";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function list(name: string, fallback: string[]): string[] {
  const raw = flag(name) ?? process.env[name.replace(/^--/, "").toUpperCase().replace(/-/g, "_")];
  if (raw === undefined || raw === "") return fallback;
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

async function main(): Promise<void> {
  const rpcUrl = flag("--rpc") ?? process.env["SEPOLIA_RPC_URL"] ?? "";
  if (rpcUrl === "") throw new Error("pass --rpc <url> or set SEPOLIA_RPC_URL");

  const port = Number(flag("--port") ?? process.env["PORT"] ?? 8787);

  // Includes any path prefix, because behind a reverse proxy the URL a user
  // pastes is not the one this process sees. Getting it wrong produces an MCP
  // URL that 404s, which is a confusing failure to debug from a chat client.
  const publicUrl = flag("--public-url") ?? process.env["PUBLIC_URL"] ?? `http://localhost:${port}`;

  const allowedOrigins = list("--allowed-origins", [
    "https://ghostpool-himess.vercel.app",
    "https://ghostpool-himess-projects.vercel.app",
    "http://localhost:3000",
  ]);

  const server = new HostedServer({
    rpcUrl,
    chainId: SEPOLIA,
    port,
    publicUrl,
    allowedOrigins,
    moduleAddress: flag("--module") ?? "0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6",
    aclAddress: "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D",
    pool: {
      address: flag("--pool") ?? "0x4728F94D12f04C7aCB1fEC278A59F3275C396865",
      token: "gUSDC",
    },
    vault: { adapter: ZAMA_VAULT_ADAPTER, batcher: ZAMA_DEPOSIT_BATCHER },
    tokens: [
      // Whole units. The frontend once scaled withdraw by 1e6 and deposit not at
      // all, and the pool clamped the difference to an encrypted zero without
      // failing, so this number is load-bearing.
      { symbol: "gUSDC", address: "0x8738E041D06cb1263A475a6495cCBB408F4731B8", decimals: 0 },
      { symbol: "gkUSD", address: "0xCFf87b42b916f7aA0F61CD060C9f48772F303D37", decimals: 6 },
      {
        // Zama's own wrapper. `underlying` is what makes it wrappable at all --
        // without that link the wrap tool has nothing to turn into it, and would
        // refuse with "not a wrapper" on a contract that plainly is one.
        symbol: "cUSDC",
        address: "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639",
        decimals: 6,
        underlying: "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF",
      },
    ],
  });

  const { url } = await server.start();
  process.stdout.write(
    [
      "",
      "  GhostPool hosted",
      "",
      `  listening      :${port}`,
      `  public url     ${url}`,
      `  cors           ${allowedOrigins.join(", ")}`,
      "",
      "  Stateless. Session keys are sealed into the bearer token, so this process",
      "  can restart or move and existing MCP URLs keep working. There is no",
      "  database and no key file to lose or leak.",
      "",
      "  It has never held a wallet key and has no code path that accepts one.",
      "  Every session is bounded on chain by an encrypted budget, an allowlist and",
      "  an expiry, and the owner closes it from their own wallet without asking",
      "  this process for anything — which is why every request re-checks the chain.",
      "",
    ].join("\n"),
  );

  const shutdown = (): void => {
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(`ghostpool-hosted: ${(e as Error).message}\n`);
  process.exit(1);
});
