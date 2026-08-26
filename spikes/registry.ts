/**
 * Sepolia recon: how do we discover confidential wrappers without hardcoding?
 *
 *   pnpm spike:registry
 */
import { ethers } from "hardhat";
import { Contract } from "ethers";
import { SepoliaConfig } from "@zama-fhe/relayer-sdk/node";
import { call, record } from "./_shared";

const KNOWN = {
  cUSDC: "0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639",
  cWETH: "0x46208622DA27d91db4f0393733C8BA082ed83158",
};
const WRAPPER_ABI = [
  "function underlying() view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function rate() view returns (uint256)",
];
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function main(): Promise<void> {
  const p = ethers.provider;
  console.log("FHEVM system contracts (Sepolia), from @zama-fhe/relayer-sdk SepoliaConfig:");
  for (const [k, v] of Object.entries(SepoliaConfig)) console.log(`  ${k.padEnd(45)} ${v}`);

  const found: Record<string, unknown> = {};
  console.log("\nConfidential wrappers:");
  for (const [label, addr] of Object.entries(KNOWN)) {
    const w = new Contract(addr, WRAPPER_ABI, p);
    const info: Record<string, unknown> = { address: addr };
    for (const f of ["name", "symbol", "decimals", "underlying", "rate"]) {
      try {
        info[f] = String(await call<unknown>(w, f)());
      } catch {
        info[f] = null;
      }
    }
    if (typeof info.underlying === "string" && info.underlying !== ethers.ZeroAddress) {
      const u = new Contract(info.underlying, ERC20_ABI, p);
      try {
        info.underlyingSymbol = await call<string>(u, "symbol")();
        info.underlyingDecimals = String(await call<bigint>(u, "decimals")());
      } catch {
        /* ignore */
      }
    }
    found[label] = info;
    console.log(
      `  ${label.padEnd(7)} ${addr}  ${info.symbol}/${info.decimals}d  <- ${info.underlyingSymbol ?? "?"} ${info.underlying}`,
    );
  }

  const out = record("registry", { system: SepoliaConfig, wrappers: found });
  console.log(`\nrecorded -> ${out}`);
}
main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
