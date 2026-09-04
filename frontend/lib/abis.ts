/** Only what the UI calls. A fuller ABI would be noise. */
export const POOL_ABI = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "encAmount", type: "bytes32" }, { name: "inputProof", type: "bytes" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "encAmount", type: "bytes32" }, { name: "inputProof", type: "bytes" }], outputs: [] },
  { type: "function", name: "confidentialBalanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "winningsOf", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "pendingOf", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "drawCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  // Three tiers now. `grandPrize` is tier 0 and the array is indexed 0..2.
  { type: "function", name: "grandPrize", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "tierPrize", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "tierK", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "TIERS", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  // B5. A draw nobody revealed can be abandoned after a day, by anyone.
  { type: "function", name: "cancelDraw", stateMutability: "nonpayable", inputs: [{ type: "uint32" }], outputs: [] },
  { type: "function", name: "keeperFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "observationCount", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "observationAt", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "i", type: "uint256" }], outputs: [{ type: "tuple", components: [{ name: "timestamp", type: "uint40" }, { name: "balance", type: "bytes32" }, { name: "cumulative", type: "bytes32" }] }] },
  // Added so the product can do what it keeps SAYING anyone can do: harvest,
  // open a draw and settle an address are permissionless, and until now the ABI
  // did not carry them, so no screen could offer them.
  { type: "function", name: "harvest", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "openDraw", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "accrueMany", stateMutability: "nonpayable", inputs: [{ type: "address[]" }, { type: "uint32" }], outputs: [] },
  // One bit per draw: does the reserve cover SOLVENCY_COVER grand prizes. Publicly
  // decryptable by design — no wallet, no permit.
  { type: "function", name: "solventAt", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "minPeriod", stateMutability: "view", inputs: [], outputs: [{ type: "uint40" }] },
  { type: "function", name: "accrued", stateMutability: "view", inputs: [{ type: "uint32" }, { type: "address" }], outputs: [{ type: "bool" }] },
  // Permissionless and unconditional: anyone may call it for anyone, and it does
  // the same thing whether that address won or not. A claim only a winner would
  // send would be the leak the rest of this contract is built to avoid.
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "user", type: "address" }], outputs: [] },
  // The audit recomputes these in the browser and compares. The three-argument
  // form is the tiered one; ethers cannot resolve the overload by arity alone,
  // so only this one is declared.
  { type: "function", name: "thresholdFor", stateMutability: "view", inputs: [{ type: "uint32" }, { type: "address" }, { type: "uint8" }], outputs: [{ type: "uint128" }] },
  // Not a view: the grant is a state change. It returns the handle, and since
  // AA1 the grant goes to the SUBJECT rather than the caller.
  { type: "function", name: "weightFor", stateMutability: "nonpayable", inputs: [{ type: "uint32" }, { type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "cancelDraw", stateMutability: "nonpayable", inputs: [{ type: "uint32" }], outputs: [] },
  { type: "function", name: "CANCEL_AFTER", stateMutability: "view", inputs: [], outputs: [{ type: "uint40" }] },
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
  // The way back. Only the externally-encrypted form exists on the deployed
  // wrapper — checked against the bytecode — so no contract can mediate an
  // unwrap, which is why the session tools do not offer one.
  { type: "function", name: "unwrap", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes32" }] },
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
  { type: "function", name: "openRedeems", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
  { type: "function", name: "requestUnwind", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimUnwound", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "claimShares", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;

/**
 * The session module.
 *
 * `remainingOf` is the number the owner most wants to see and CAN see: the
 * budget handle is granted to the owner as well as the session key at open, so
 * this decrypts with the same permit as everything else. The session key's own
 * token balance is NOT readable by the owner, which is correct rather than a
 * gap -- the ACL grants that one to the key alone.
 */
export const MODULE_ABI = [
  { type: "function", name: "remainingOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "bytes32" }] },
  {
    type: "function", name: "sessionOf", stateMutability: "view", inputs: [{ type: "address" }],
    outputs: [{ type: "tuple", components: [
      { name: "owner", type: "address" }, { name: "expiry", type: "uint48" },
      { name: "maxTxCount", type: "uint24" }, { name: "txCount", type: "uint24" },
    ] }],
  },
] as const;
