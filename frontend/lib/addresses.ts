/**
 * Sepolia addresses.
 *
 * The demo runs on its own ERC-7984 token rather than Zama's deployed cUSDC, and
 * that is a deliberate trade. The mock has a public `mint`, so a judge funds
 * themselves in one click; the cUSDC path needs mint-approve-wrap first, and E1
 * measured what that does when a precondition is missing — a bare `execution
 * reverted` with nothing in it. The real wrapper's addresses stay here because
 * the README documents that path and it is the one a production deployment uses.
 */
export const SEPOLIA_CHAIN_ID = 11155111;

/** Deployed by scripts/deploy.ts — see out/deployment.json. */
export const POOL = (process.env.NEXT_PUBLIC_POOL ??
  "0x3f6F8e5A853bEC8FA008b31E28f9B0fD9dC0F287") as `0x${string}`;
export const TOKEN = (process.env.NEXT_PUBLIC_TOKEN ??
  "0x1bbBE55d24174d57305632E75fE47ac3C5158a9F") as `0x${string}`;

/** Zama's Confidential Vault staging deployment — the production path. */
export const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639" as const;
export const USDC = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF" as const;

export const EXPLORER = "https://sepolia.etherscan.io";

/**
 * The composition pool: GhostPool's adapter sitting on Zama's own confidential
 * vault. Read-only in the UI — entry goes through a batcher whose settlement
 * depends on Zama's keeper, so a deposit here would leave a judge waiting on
 * somebody else's infrastructure with a position that reads as neither in nor out.
 */
export const VAULT_ADAPTER = "0xc5120E26aafdD76D324E62cF19c391C367Cf99Ba" as const;
export const VAULT_SHARE = "0x13F7d34A4f0102734F19E3Ff16e068Fe194B28c4" as const;
export const DEPOSIT_BATCHER = "0x48758559c14d4d92b4C74A99660B6a8dbe85F53b" as const;

/**
 * The hosted server, when one is configured.
 *
 * Empty by default and the session panel simply does not render, because the
 * local install is a complete product on its own and a dead `Open a session`
 * button would say otherwise.
 */
export const HOSTED_URL = process.env.NEXT_PUBLIC_HOSTED_URL ?? "";
