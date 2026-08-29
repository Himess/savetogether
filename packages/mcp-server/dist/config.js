"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CONFIG_PATH = void 0;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.formatAmount = formatAmount;
exports.parseAmount = parseAmount;
/**
 * Configuration, including the token list.
 *
 * NO HARDCODED ADDRESSES. Step 1 looked for a curated confidential-wrapper
 * registry on Sepolia and did not find one — the wrappers in use are named
 * `cUSDCMock` / `USDCMock`, which is not a curated set. So GhostKey defines its
 * own list format and adapts if a registry ever appears. That decision is recorded
 * in `findings.md` §6 item 6; this file is its consequence.
 */
const fs = __importStar(require("node:fs/promises"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
exports.DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".ghostkey", "config.json");
async function loadConfig(file = exports.DEFAULT_CONFIG_PATH) {
    let raw;
    try {
        raw = await fs.readFile(file, "utf8");
    }
    catch {
        throw new Error(`no GhostKey config at ${file} — run \`ghostkey init\``);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        throw new Error(`${file} is not valid JSON: ${e.message}`);
    }
    return validate(parsed, file);
}
async function saveConfig(config, file = exports.DEFAULT_CONFIG_PATH) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
function validate(v, file) {
    const c = v;
    const fail = (why) => {
        throw new Error(`${file}: ${why}`);
    };
    if (typeof c.chainId !== "number")
        fail("chainId must be a number");
    if (typeof c.rpcUrl !== "string" || c.rpcUrl === "")
        fail("rpcUrl must be a non-empty string");
    if (!isAddress(c.moduleAddress))
        fail("moduleAddress must be an address");
    if (!Array.isArray(c.tokens) || c.tokens.length === 0)
        fail("tokens must be a non-empty array");
    const seen = new Set();
    for (const t of c.tokens ?? []) {
        if (!isAddress(t.address))
            fail(`token ${t.symbol ?? "?"} has no valid address`);
        if (typeof t.symbol !== "string" || t.symbol === "")
            fail("every token needs a symbol");
        if (typeof t.decimals !== "number")
            fail(`token ${t.symbol} has no decimals`);
        const key = t.address.toLowerCase();
        if (seen.has(key))
            fail(`token ${t.address} is listed twice`);
        seen.add(key);
    }
    return c;
}
function isAddress(v) {
    return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}
/** Formats a base-unit amount for display. Never used on an undisclosed value. */
function formatAmount(base, decimals) {
    const negative = base < 0n;
    const abs = negative ? -base : base;
    const unit = 10n ** BigInt(decimals);
    const whole = abs / unit;
    const frac = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole}${frac === "" ? "" : `.${frac}`}`;
}
/** Parses a user-typed amount into base units. Rejects anything ambiguous. */
function parseAmount(input, decimals) {
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
//# sourceMappingURL=config.js.map