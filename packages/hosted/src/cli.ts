#!/usr/bin/env node
/**
 * `ghostpool-hosted` — the server behind the website.
 *
 * Deliberately boring to start: no database, no accounts, no secrets in the
 * repository. It needs an RPC URL and a public origin, and it tells you where it
 * put the key that seals session keys at rest.
 */
import { HostedServer } from "./server";

const SEPOLIA = 11155111;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const rpcUrl = flag("--rpc") ?? process.env["SEPOLIA_RPC_URL"] ?? "";
  if (rpcUrl === "") throw new Error("pass --rpc <url> or set SEPOLIA_RPC_URL");

  const port = Number(flag("--port") ?? process.env["PORT"] ?? 8787);
  const publicUrl = flag("--public-url") ?? process.env["PUBLIC_URL"] ?? `http://localhost:${port}`;

  const server = new HostedServer({
    rpcUrl,
    chainId: SEPOLIA,
    port,
    publicUrl,
    moduleAddress: flag("--module") ?? "0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6",
    aclAddress: "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D",
    pool: {
      address: flag("--pool") ?? "0x3f6F8e5A853bEC8FA008b31E28f9B0fD9dC0F287",
      token: "gUSDC",
    },
    tokens: [
      // Whole units. The frontend once scaled withdraw by 1e6 and deposit not at
      // all, and the pool clamped the difference to an encrypted zero without
      // failing, so this number is load-bearing.
      { symbol: "gUSDC", address: "0x1bbBE55d24174d57305632E75fE47ac3C5158a9F", decimals: 0 },
      { symbol: "gkUSD", address: "0xCFf87b42b916f7aA0F61CD060C9f48772F303D37", decimals: 6 },
    ],
  });

  const { url, masterKeySource } = await server.start();
  process.stdout.write(
    [
      "",
      "  GhostPool hosted",
      "",
      `  listening      :${port}`,
      `  public url     ${url}`,
      `  session keys   sealed with the key from ${masterKeySource}`,
      "",
      "  The server holds session keys. It has never held a wallet key and has no",
      "  code path that accepts one. Every session is bounded on chain by an",
      "  encrypted budget, an allowlist and an expiry, and the owner can close it",
      "  from their own wallet without asking this process for anything.",
      "",
      "  Ctrl-C to stop.",
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
