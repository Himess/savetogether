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
  "0x307e2D1eA71C73FD4358622933880868BbCe05D0") as `0x${string}`;
export const TOKEN = (process.env.NEXT_PUBLIC_TOKEN ??
  "0x056AC066e0770A7BE08eCAc73C09f811B067fc46") as `0x${string}`;

/** Zama's Confidential Vault staging deployment — the production path. */
export const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639" as const;
export const USDC = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF" as const;

export const EXPLORER = "https://sepolia.etherscan.io";
