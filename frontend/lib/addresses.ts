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
