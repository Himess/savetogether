/**
 * Configuration, including the token list.
 *
 * NO HARDCODED ADDRESSES. Step 1 looked for a curated confidential-wrapper
 * registry on Sepolia and did not find one — the wrappers in use are named
 * `cUSDCMock` / `USDCMock`, which is not a curated set. So GhostKey defines its
 * own list format and adapts if a registry ever appears. That decision is recorded
 * in `findings.md` §6 item 6; this file is its consequence.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface TokenEntry {
  /** What the user calls it. Never read from the chain, so never injectable. */
  readonly symbol: string;
  readonly address: string;
  readonly decimals: number;
  /** The ERC-20 this wraps, when it is a wrapper. Absent for a plain ERC-7984. */
  readonly underlying?: string;
  /** Wrapper rate, when wrapping is supported. */
  readonly rate?: string;
}

export interface GhostKeyConfig {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly moduleAddress: string;
  readonly tokens: readonly TokenEntry[];
  /** Overrides the ACL address the relayer SDK ships. Rarely needed. */
  readonly aclAddress?: string;
  readonly devUnlock?: boolean;
}

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".ghostkey", "config.json");

export async function loadConfig(file = DEFAULT_CONFIG_PATH): Promise<GhostKeyConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`no GhostKey config at ${file} — run \`ghostkey init\``);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  return validate(parsed, file);
}

export async function saveConfig(
  config: GhostKeyConfig,
  file = DEFAULT_CONFIG_PATH,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function validate(v: unknown, file: string): GhostKeyConfig {
  const c = v as Partial<GhostKeyConfig>;
  const fail = (why: string): never => {
    throw new Error(`${file}: ${why}`);
  };

  if (typeof c.chainId !== "number") fail("chainId must be a number");
  if (typeof c.rpcUrl !== "string" || c.rpcUrl === "") fail("rpcUrl must be a non-empty string");
  if (!isAddress(c.moduleAddress)) fail("moduleAddress must be an address");
  if (!Array.isArray(c.tokens) || c.tokens.length === 0) fail("tokens must be a non-empty array");

  const seen = new Set<string>();
  for (const t of c.tokens ?? []) {
    if (!isAddress(t.address)) fail(`token ${t.symbol ?? "?"} has no valid address`);
    if (typeof t.symbol !== "string" || t.symbol === "") fail("every token needs a symbol");
    if (typeof t.decimals !== "number") fail(`token ${t.symbol} has no decimals`);
    const key = t.address.toLowerCase();
    if (seen.has(key)) fail(`token ${t.address} is listed twice`);
    seen.add(key);
  }

  return c as GhostKeyConfig;
}

function isAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/** Formats a base-unit amount for display. Never used on an undisclosed value. */
export function formatAmount(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac === "" ? "" : `.${frac}`}`;
}

/** Parses a user-typed amount into base units. Rejects anything ambiguous. */
export function parseAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error(`"${input}" is not a plain decimal amount`);
  }
  const [whole = "0", frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(`too many decimal places: this token has ${decimals}`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}
