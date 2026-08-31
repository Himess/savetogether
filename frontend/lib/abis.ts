/** Only what the UI calls. A fuller ABI would be noise. */
export const POOL_ABI = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "encAmount", type: "bytes32" }, { name: "inputProof", type: "bytes" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "encAmount", type: "bytes32" }, { name: "inputProof", type: "bytes" }], outputs: [] },
  { type: "function", name: "confidentialBalanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "winningsOf", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "pendingOf", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "drawCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "prize", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "accrued", stateMutability: "view", inputs: [{ type: "uint32" }, { type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "drawAt", stateMutability: "view", inputs: [{ type: "uint32" }],
    outputs: [{
      type: "tuple", components: [
        { name: "periodStart", type: "uint40" }, { name: "snapshotAt", type: "uint40" },
        { name: "status", type: "uint8" }, { name: "encR", type: "bytes32" },
        { name: "encTotalWeight", type: "bytes32" }, { name: "r", type: "uint64" },
        { name: "totalWeight", type: "uint128" },
      ],
    }],
  },
] as const;

export const ERC7984_ABI = [
  { type: "function", name: "confidentialBalanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "isOperator", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setOperator", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint48" }], outputs: [] },
  { type: "function", name: "wrap", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/** Only the reads the vault-proof section makes. Nothing here can write. */
export const ADAPTER_ABI = [
  { type: "function", name: "openBatches", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export const BATCHER_ABI = [
  { type: "function", name: "batchState", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "toToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export const SHARE_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "confidentialBalanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bytes32" }] },
] as const;

/** The yield engine. rateBps is immutable, so the APY on screen is read, not written. */
export const YIELD_ABI = [
  { type: "function", name: "rateBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "principal", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "pending", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/** The adapter that joined a real Zama vault batch and holds real shares. */
export const VAULT_SOURCE_ABI = [
  { type: "function", name: "openBatches", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "joinVault", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimShares", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;
