import * as fs from "node:fs";
import * as path from "node:path";

/** Wall-clock milliseconds, monotonic. */
export const now = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/** Times an async phase and returns both its result and its duration. */
export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ label: string; ms: number; value: T }> {
  const t0 = now();
  const value = await fn();
  return { label, ms: now() - t0, value };
}

export interface Stats {
  readonly label: string;
  readonly min: number;
  readonly median: number;
  readonly max: number;
  readonly n: number;
}

export function stats(label: string, samples: readonly number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median =
    s.length === 0
      ? 0
      : s.length % 2 === 0
        ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
        : (s[mid] ?? 0);
  return { label, min: s[0] ?? 0, median, max: s[s.length - 1] ?? 0, n: s.length };
}

/** Fixed-width markdown table so findings.md can paste it verbatim. */
export function table(rows: readonly Stats[]): string {
  const fmt = (ms: number): string =>
    ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
  const w = Math.max(24, ...rows.map((r) => r.label.length));
  const head = `| ${"phase".padEnd(w)} | ${"min".padStart(9)} | ${"median".padStart(9)} | ${"max".padStart(9)} | n |`;
  const sep = `|${"-".repeat(w + 2)}|${"-".repeat(11)}|${"-".repeat(11)}|${"-".repeat(11)}|---|`;
  const body = rows.map(
    (r) =>
      `| ${r.label.padEnd(w)} | ${fmt(r.min).padStart(9)} | ${fmt(r.median).padStart(9)} | ${fmt(r.max).padStart(9)} | ${r.n} |`,
  );
  return [head, sep, ...body].join("\n");
}

/** Upsert a KEY=value line in .env without disturbing the rest of the file. */
export function upsertEnv(key: string, value: string): void {
  const file = path.resolve(__dirname, "..", ".env");
  const line = `${key}=${value}`;
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
  fs.writeFileSync(file, text.replace(/^\n/, ""), { encoding: "utf8", mode: 0o600 });
}

/** Writes a spike result to spikes/out/ for findings.md to quote. */
export function record(name: string, payload: unknown): string {
  const dir = path.resolve(__dirname, "out");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (v === undefined || v.length === 0)
    throw new Error(`${key} is not set — copy .env.example to .env and fill it in`);
  return v;
}

// --- typed access to untyped external contracts ----------------------------
// ethers' dynamic Contract members are `possibly undefined` under strict mode.
// getFunction is the typed door; these wrappers keep the spikes strict-clean
// without weakening tsconfig.

/** Hex FHE handle. The relayer SDK keys userDecrypt results by this exact type. */
export type Handle = `0x${string}`;

export interface ReceiptLike {
  readonly status: number | null;
  readonly blockNumber: number;
  readonly gasUsed: bigint;
}
export interface TxLike {
  readonly hash: string;
  wait(): Promise<ReceiptLike | null>;
}

interface FunctionBearing {
  getFunction(name: string): unknown;
}

/** Returns a call-signature-typed view of one contract method. */
export function call<T>(c: FunctionBearing, name: string): (...args: unknown[]) => Promise<T> {
  return c.getFunction(name) as (...args: unknown[]) => Promise<T>;
}

// --- EIP-712 signing shared by the delegation and latency spikes ----------

/** Shape the relayer SDK returns from createEIP712 / createDelegatedUserDecryptEIP712. */
export interface Eip712Payload {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  readonly primaryType?: string;
  readonly message: Record<string, unknown>;
}

interface TypedDataSigner {
  signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, ReadonlyArray<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

/**
 * Signs an SDK-produced EIP-712 payload. ethers rejects an explicit
 * EIP712Domain entry in `types`, so the primary type is isolated first.
 */
export async function signEip712(signer: TypedDataSigner, payload: Eip712Payload): Promise<string> {
  const primary =
    payload.primaryType ?? Object.keys(payload.types).find((t) => t !== "EIP712Domain");
  if (primary === undefined) throw new Error("EIP-712 payload has no primary type");
  const entry = payload.types[primary];
  if (entry === undefined) throw new Error(`EIP-712 payload has no type named ${primary}`);
  return signer.signTypedData(payload.domain, { [primary]: entry }, payload.message);
}

/**
 * Retries a transient failure with exponential backoff.
 *
 * The Zama relayer and the RPC both drop connections occasionally — a 60-sample
 * run hit `UND_ERR_CONNECT_TIMEOUT` on the fifth send. That is not a defect in
 * anything under test, but a measurement harness that dies on it produces no
 * measurement, and a session client that dies on it is unusable. Only transport
 * failures are retried: a revert or an assertion failure must surface immediately.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 1500;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      const wait = baseMs * 2 ** i;
      console.log(`    ${label}: ${describe(err)} — retry ${i + 1}/${attempts - 1} in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

const TRANSIENT = [
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "SERVER_ERROR",
  "TIMEOUT",
  "socket hang up",
  "fetch failed",
  "502",
  "503",
  "504",
  "429",
];

function isTransient(err: unknown): boolean {
  const s = `${(err as { code?: string })?.code ?? ""} ${(err as Error)?.message ?? ""}`;
  return TRANSIENT.some((t) => s.includes(t));
}

function describe(err: unknown): string {
  return `${(err as { code?: string })?.code ?? (err as Error)?.message ?? "unknown"}`.slice(0, 60);
}
