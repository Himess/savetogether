import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-network-helpers";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";
import { vars } from "hardhat/config";

dotenv.config();

// Resolution order for every secret: process.env -> hardhat vars -> empty.
// Nothing is ever hardcoded and nothing is printed.
const fromEnv = (key: string, fallback = ""): string => process.env[key] ?? vars.get(key, fallback);

const SEPOLIA_RPC_URL: string = fromEnv(
  "SEPOLIA_RPC_URL",
  "https://ethereum-sepolia-rpc.publicnode.com",
);

// accounts[0] = holder / delegator, accounts[1] = session key / delegate.
// A6 is only a valid test when these are different addresses.
const sepoliaAccounts: string[] = [
  fromEnv("DEPLOYER_PRIVATE_KEY"),
  fromEnv("SESSION_PRIVATE_KEY"),
].filter((k): k is string => k.length > 0);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      metadata: { bytecodeHash: "none" },
      optimizer: { enabled: true, runs: 800 },
      // FHE clamp chains overflow the legacy stack allocator; the IR pipeline
      // is what makes them compile at all. Matches the proven GhostLend config.
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    sepolia: {
      chainId: 11155111,
      url: SEPOLIA_RPC_URL,
      accounts: sepoliaAccounts,
    },
  },
  etherscan: { apiKey: fromEnv("ETHERSCAN_API_KEY") },
  typechain: { outDir: "types", target: "ethers-v6" },
  gasReporter: { enabled: process.env.REPORT_GAS !== undefined, currency: "USD" },
  mocha: { timeout: 300_000 },
};

export default config;
