/**
 * Sepolia addresses.
 *
 * The pool settles in Zama's own confidential USDC, and that is not a cosmetic
 * choice. Zama's vault deposit batcher takes cUSDC — `adapter.asset()` says so on
 * chain — so a pool settling in anything else could never join a batch, and the
 * composition this project is built around would be a diagram rather than a
 * transaction. An earlier build used our own whole-unit token because its public
 * `mint` funded a judge in one click; the Wrap screen now covers that in the
 * mint-approve-wrap form the real token actually requires.
 */
export const SEPOLIA_CHAIN_ID = 11155111;

/** Deployed by scripts/deploy-tiered.ts — see out/deployment.json. */
export const POOL = (process.env.NEXT_PUBLIC_POOL ??
  "0x021585bE0100a8D838876432730f308bC7B168D6") as `0x${string}`;

/** The pool's settlement token: Zama's deployed cUSDC, six decimals. */
export const TOKEN = (process.env.NEXT_PUBLIC_TOKEN ??
  "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639") as `0x${string}`;

/**
 * Six, and every amount on screen goes through it.
 *
 * The previous token was whole-unit, so the screens read and wrote base units
 * directly. On a six-decimal token that same code deposits a millionth of what
 * the box says, which is silent rather than loud — it succeeds.
 */
export const TOKEN_DECIMALS = 6;
export const TOKEN_SYMBOL = "cUSDC";

export const CUSDC = "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639" as const;
export const USDC = "0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF" as const;

export const EXPLORER = "https://sepolia.etherscan.io";

/**
 * Zama's confidential vault, which the pool's yield source is wired into.
 *
 * `joinVault()` sends half the pool's principal into the batcher below and real
 * shares come back when Zama's keeper dispatches the batch. Half, because a batch
 * is a round trip on somebody else's clock and the source does not unwind shares
 * on demand — the other half is the withdrawal buffer.
 */
export const VAULT_ADAPTER = "0xc5120E26aafdD76D324E62cF19c391C367Cf99Ba" as const;
export const VAULT_SHARE = "0x13F7d34A4f0102734F19E3Ff16e068Fe194B28c4" as const;
export const DEPOSIT_BATCHER = "0x48758559c14d4d92b4C74A99660B6a8dbe85F53b" as const;

/**
 * The engine that funds prizes: a testnet replica of Steakhouse Confidential
 * Prime that is also the pool's bridge into the vault above.
 *
 * The split is worth stating because both halves are on screen. The vault
 * composition is real — real batcher, real shares, on chain. The RATE is ours:
 * Zama's Sepolia vault has no yield adapter, so nothing about it appreciates and
 * a prize funded from its appreciation would never be paid. The APY the Vault
 * screen shows is read from this contract, not written into the page.
 */
export const YIELD_SOURCE = "0x57bC5cD7Be1231F73161ecE05a01f9E24370d85E" as const;

/** SaveTogetherSession — the module that holds the encrypted budget. */
export const MODULE = "0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6" as const;

/**
 * The hosted server.
 *
 * A default rather than an environment variable, like the addresses above, and
 * that is a decision this deployment paid for: the three NEXT_PUBLIC_ variables
 * were set in production but stored EMPTY, and `??` passes an empty string
 * through — so the override silently won and the panel it controls never
 * rendered. They are removed, and the code is the single source of truth.
 *
 * Set the variable to override; set it to nothing and the session panel does not
 * render at all, which is honest, because the local install is a complete product
 * on its own and a dead `Open a session` button would say otherwise.
 */
export const HOSTED_URL =
  process.env.NEXT_PUBLIC_HOSTED_URL ?? "https://survivorsbyashborn.com/ghostpool";
