import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@typechain/hardhat";
import type { HardhatUserConfig } from "hardhat/config";
import * as fs from "fs";
import * as path from "path";

// Signer and RPC, in order: env, then probe/secrets.json (git-ignored).
// Same convention as GhostLend so the funded probe wallet carries over.
type Secrets = { privateKey?: string; sepoliaRpcUrl?: string };
let fileSecrets: Secrets = {};
try {
  const p = path.join(__dirname, "probe", "secrets.json");
  if (fs.existsSync(p)) fileSecrets = JSON.parse(fs.readFileSync(p, "utf8")) as Secrets;
} catch {
  /* ignore */
}

const PK: string = process.env.PROBE_PK || fileSecrets.privateKey || "";
const RPC: string =
  process.env.SEPOLIA_RPC_URL ||
  fileSecrets.sepoliaRpcUrl ||
  "https://ethereum-sepolia-rpc.publicnode.com";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: { chainId: 31337 },
    sepolia: {
      accounts: PK ? [PK.startsWith("0x") ? PK : `0x${PK}`] : [],
      chainId: 11155111,
      url: RPC,
    },
  },
  paths: { artifacts: "./artifacts", cache: "./cache", sources: "./contracts", tests: "./test" },
  typechain: { outDir: "types", target: "ethers-v6" },
  solidity: {
    version: "0.8.27",
    settings: {
      metadata: { bytecodeHash: "none" },
      optimizer: { enabled: true, runs: 800 },
      evmVersion: "cancun",
    },
  },
};

export default config;
