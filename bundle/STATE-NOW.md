# STATE-NOW

Factual header. Every number below was read from chain, from a test run, or from an
HTTP response on **2026-09-03**, not from the README. Where a project document claims
something different, the difference is recorded rather than reconciled.

- Working tree: commit `45edab4` on `master`, clean.
- Chain: Ethereum Sepolia, chain id `11155111`.
- Reference block: `11627617`, timestamp `2026-09-03T16:04:48Z`.
- RPC used: `https://ethereum-sepolia-rpc.publicnode.com`.

---

## 1. Live addresses

Source of truth: `out/deployment.json`. Verification status read from the public
Etherscan pages on 2026-09-03; there is no Etherscan API key in this environment, so
the check was made against the rendered address pages.

### Ours

| Contract | Address | Deployed code | Etherscan |
|---|---|---|---|
| `ConfidentialPrizePool` | `0xa9B69Dc9F9f4C4512c926ba9eA432eBcF0026631` | 17,771 B | **Verified — Exact Match** |
| `SteakhouseReplicaSource` | `0xDa596e47029839eA7E1990f97F106fd6d2e33695` | 6,867 B | **Verified — _Similar_ Match** ⚠ |
| `SaveTogetherSession` | `0xE5c667c0C58242f89ee59f9269111A3EfB836Cf6` | 9,978 B | **Verified — Exact Match** |

All three are verified, so the README's "all three of our contracts Etherscan-verified"
holds. But `SteakhouseReplicaSource` is a **Similar Match**, not an Exact Match:
Etherscan renders it with the amber check rather than the green one. Similar Match means
the runtime bytecode matches while the trailing metadata hash does not — normally a
compiler-settings or source-path difference between the verification input and the
build that was deployed. The README's single "3 verified" badge does not distinguish
the two, and `scripts/verify-all.sh` does not assert the match type.

Compiler on all three: `v0.8.27+commit.40a35a09`.

### Zama's, which we call and never deploy

| Contract | Address | Confirmed on chain |
|---|---|---|
| cUSDC (`ERC7984ERC20Wrapper`) | `0x7c5BF43B851c1dff1a4feE8dB225b87f2C223639` | `name() = "Confidential USDC (Mock)"`, `symbol() = "cUSDCMock"`, `decimals() = 6` |
| Mock USDC (underlying) | `0x9b5Cd13b8eFbB58Dc25A05CF411D8056058aDFfF` | `name() = "USD Coin (Mock)"`, `symbol() = "USDCMock"` |
| Deposit batcher | `0x48758559c14d4d92b4C74A99660B6a8dbe85F53b` | `fromToken() = cUSDC`, `toToken() = 0x13F7d3…28c4`, `currentBatchId() = 295` |
| Redeem batcher | `0xe94E9afdDd43a19C2914739e9279cb6Fe287BEb0` | `fromToken() = 0x13F7d3…28c4`, `toToken() = cUSDC`, `currentBatchId() = 232` |
| Vault share (csteakcUSDC) | `0x13F7d34A4f0102734F19E3Ff16e068Fe194B28c4` | `name() = "Confidential steakcUSDC (Mock)"`, `symbol() = "csteakcUSDC (Mock)"` |
| ERC-4626 | `0x6AB54988261AEC573a2CA13cF802d3B1114f864C` | `name() = "Steakhouse Confidential Prime USDC"`, `symbol() = "steakcUSDC"`, `decimals() = 18` |

`frontend/lib/addresses.ts` agrees with `out/deployment.json` on every address.

**Zama's published address table does not.** `docs.zama.org/protocol/confidential-vault/reference/addresses`
names the Sepolia cShare as `0x7E93d5c150A2178B1fCde0278582Acf59478eA5f`. That address
is live and is a different contract — `Confidential mvUSDC` / `cmvUSDC`. The deployed
deposit batcher's own `toToken()` returns `0x13F7d34A…`, which is what we hold. Both
wrap the same ERC-4626. We follow the batcher; the published table is stale. Recorded in
full in `CONFIDENTIAL-TOKENS-BUNDLE.md` § disagreements.

---

## 2. Draw state

| | |
|---|---|
| `drawCount()` | **32** |
| Draw 32 | opened `1788443712`, revealed `1788446184`, `totalWeight = 242029383102888844077559173149201204480` |
| Draw 1 | opened `1788361380`, revealed `1788363432` |
| Tier prizes | `25.000000` / `5.000000` / `1.000000` cUSDC |
| Tier `k` | `100` / `10` / `1` |
| `grandPrize()` | `25000000` (25 cUSDC) |
| `keeperFee()` | `200000` (0.2 cUSDC) |
| `minPeriod()` | `300` s |
| `owner()` | `0xF505e2E71df58D7244189072008f25f6b6aaE5ae` — **not renounced** |
| `yieldSource()` | `0xDa596e47029839eA7E1990f97F106fd6d2e33695` ✓ |

## 3. Participants

| | |
|---|---|
| `totalObservationCount()` | **5** |
| `Deposited` events since deploy | **5**, from **5 distinct addresses** |
| Depositors | `0xF505e2…E5Ae` (deployer), `0x12Ee5A…9BF1`, `0xc5F41c…9568`, `0x9926e6…fbB9`, `0xC79A26…49E8` |
| `Withdrawn` events | **0** |

## 4. Prizes paid to date

| | |
|---|---|
| `Accrued` events | **160** (5 participants × 32 draws — unconditional accrual, as designed) |
| `Harvested` events | **32** |
| `KeeperPaid` events | **65** |
| `Claimed` events | **0** |

**No prize has ever been claimed.** Amounts credited to `winningsOf` are encrypted
`euint64` handles and are not publicly readable, so "prizes paid to date" cannot be
stated as a number from chain data alone — but the claim path has never been exercised
on this deployment. The `claim()` function is covered by local tests only.

## 5. The vault leg

| | |
|---|---|
| `SteakhouseReplicaSource.openBatches()` | `[286]` |
| Batch 286 state | **Finalized** (enum `Pending=0, Dispatched=1, Finalized=2, Canceled=3`) |
| Batch 286 exchange rate | `1000000` — i.e. **exactly 1.000000**, 6 decimals |
| `SteakhouseReplicaSource` cUSDC balance | non-zero handle `0xf09546cd…` |
| `SteakhouseReplicaSource` csteakcUSDC balance | non-zero handle `0xc0c968ae…` |
| `openRedeems()` | empty |
| `lastAccrual()` | `1788446172` |
| `rateBps()` | `100000` (10%) |

Every one of the last ten finalized batches (285–294) settled at an exchange rate of
exactly `1.000000`. The ERC-4626's `totalAssets()` is `1058845820278` against a
`totalSupply()` of `1058845820278000000000000` — a share price of exactly 1.0 after the
6→18 decimal scaling. **This is direct on-chain confirmation of the README's claim that
the composition is real and the appreciation is not.** It is the strongest evidence in
the repository for that claim and it is currently not cited anywhere.

Observed settlement lag, batch creation to dispatch, for batches 286–294:
`12120, 2160, 9504, 372, 26628, 31560, 1368, 3072, 5160` seconds — **6 minutes to 8.8
hours**, median about 1.4 hours. Zama's documented `minBatchAge` is **1 second**. The
documented minimum says nothing useful about the real cadence.

## 6. Keeper

| | |
|---|---|
| Address | `0xF505e2E71df58D7244189072008f25f6b6aaE5ae` (also the pool `owner`) |
| Balance | **0.547764 ETH** |
| Transactions sent (nonce) | 8,946 |
| Pool transactions since deploy | 166 |
| Total ETH spent on pool transactions | 0.189276 ETH |
| Mean per pool transaction | 0.001140 ETH |
| **Mean per draw** | **0.005915 ETH** |
| **Runway at that rate** | **≈ 92 further draws** |
| Observed cadence | first pool event `2026-09-02T15:06:24Z`, last `2026-09-03T14:38:00Z` — 23.5 h for 32 draws, **≈ 44 minutes per draw** |
| **Runway in wall-clock time** | **≈ 68 hours, about 2.8 days** from 2026-09-03 |

The configured `PERIOD` is 300 s and `minPeriod()` on chain is 300 s, but the observed
cadence is ~2,646 s — **8.8× the configured minimum**. The keeper is not running slow;
it is waiting on Zama's batcher settlement, whose lag is measured in § 5. Any statement
of the form "a draw every five minutes" is not what this deployment does.

## 7. Hosted server and frontend

| | Status |
|---|---|
| `https://survivorsbyashborn.com/ghostpool` | **200 OK**, 1.43 s |
| `https://survivorsbyashborn.com/ghostpool/health` | **404** — there is no health endpoint at that path |
| `https://ghostpool-himess.vercel.app` | **200 OK**, 1.34 s |

## 8. Tests

Run on 2026-09-03 with `TS_NODE_TRANSPILE_ONLY=true`, local FHEVM mock, no network.

| Suite | Command | Result |
|---|---|---|
| Pool | `npm run test:pool` (16 files) | **96 passing**, 26 s, exit 0 |
| Session / MCP | `npm run test:session` (3 files) | **94 passing**, 16 s, exit 0 |
| **`npm test` total** | | **190 passing** |
| Sepolia suites | `npm run test:sepolia` (3 files) | **not run** — needs a funded key; no `.env` in this environment |

**The README badge says 176 passing. The real number is 190.** The badge is stale in the
safe direction, but it is stale. `README.md:20` and `README.md:527` both say 176.

Separately, `README.md:520` carries a row reading `| Local tests | 30 passing |` inside
the "rest of the numbers" table. That is not the local test count and reads as a leftover.

What the 190 cover, by area:

- The draw machine — `equality-invariants.ts`, `accrual.ts`, `draw-ordering.ts`, `tiers.ts`
- Non-leakage — `c1-indistinguishability.ts` (312 accruals, 81 winners, 231 losers),
  `aa1-weight-leak.ts`, `frozen-surface.ts`
- Reserve and payout ordering — `reserve-order.ts`, `yield.ts`
- The vault round trip, both directions — `withdraw-buffer.ts`, `replica-source.ts`
- Keeper properties — `phase-b.ts` (fee never displaces a prize, dead keeper cannot brick
  the pool, ownership can be renounced), `aa2-cancel-window.ts`
- The conversational layer — `mcp.ts`, `mcp-protocol.ts`, `SaveTogetherSession.ts`
- Cost — `storage-cost.ts`

Measurement lives in `spikes/`: **21 experiments** (26 entries less `out/`,
`PlaintextFreeSpike.sol`, `_shared.ts`, `accounts.ts`, `registry.ts`). The README's
"21 standalone experiments" is **correct**.

---

## 9. Open defects and limitations

Every item names the test or measurement that pins it. Items 1–11 are the README's own
list, re-checked. Items 12–17 were found while building this corpus and are **not**
currently disclosed anywhere in the repository.

### Carried from the README, confirmed

1. **The reserve can under-pay silently.** A tier-0 win before the reserve can cover it
   credits zero, and a declined `tryDecrease` is indistinguishable from losing.
   Simulated at 3.2–3.6%, concentrated in the first four rounds after a deploy.
   → `test/reserve-order.ts`, `spikes/y2-reserve-simulation.ts`
2. **The first draw after a deploy cannot pay.** Observed live on this pool: draw 1
   said WIN tier 1 under the public rule and paid nothing. With a sole depositor the
   ordinary tier is won with certainty — 97.3%, not 3%. Mitigated by keeper sequencing.
   → draw 1 on chain; `scripts/keeper.ts`
3. **Withdrawal is all-or-nothing.** Asking for more than you hold, or more than the
   pool has liquid, moves nothing and still succeeds. → `test/withdraw-buffer.ts`
   *(See defect 12 — the README misattributes the cause.)*
4. **Accrual is O(participants) where PoolTogether is O(winners).** 386,608 gas each;
   100 depositors is 38.7M gas per draw, over a Sepolia block. → `test/storage-cost.ts`
5. **Amounts are hidden, identities are not.** Confirmed on chain: 5 `Deposited` events,
   5 distinct depositor addresses, all public. FHE is not a mixer.
6. **The prize is a plaintext `uint64`.** → `docs/tier-derivation.md` §4
7. **`totalWeight` is published.** Deliberate: encrypting it costs 8.3× and removes
   public auditability of the draw. → `spikes/a2-encrypted-total.ts`
8. **The keeper is one process with one key.** Confirmed: `owner()` is the keeper address
   and ownership is **not** renounced. → `test/phase-b.ts`
9. **The replica's yield is pre-funded, not earned.** Confirmed on chain — every batch
   settles at exchange rate exactly 1.000000. → § 5 above
10. **`euint128` for the cumulative accumulator is required, not optional.** A 1e12
    balance held a year overflows `2^64` in about seven months.
11. **No confirmation-depth policy.** Fine on Sepolia, not on mainnet.

### Found while building this corpus, not currently disclosed

12. **The README attributes clamp-to-zero to the wrong layer.** `README.md:650` says
    "ERC-7984's transfer clamps to zero rather than paying out partially." ERC-7984 does
    not require that. The specification says a transfer **"MAY revert if the caller's
    balance does not have enough tokens to spend"** — permissive, not prescriptive.
    Clamp-to-zero is **OpenZeppelin's implementation choice**: `ERC7984._update` computes
    `transferred = FHE.select(success, amount, FHE.asEuint64(0))`. The limitation is real;
    its stated cause is wrong, and a reader checking it against the ERC would not find it.
    → `CONFIDENTIAL-TOKENS-BUNDLE.md` §1 and §5
13. **`SteakhouseReplicaSource` is an Etherscan _Similar_ Match, not an Exact Match.**
    Not distinguished by the README badge and not asserted by `scripts/verify-all.sh`.
    → § 1 above
14. **The test badge is stale.** 176 claimed, 190 actual. → § 8 above
15. **RESOLVED — code comments cited a file that does not exist in this repository.**
    Several comments justified their reasoning against a file in a different repository,
    which a reader of this one cannot open. The reasoning was sound and the guards are
    correct; the citations were unfollowable. Every one has been rewritten to state the
    property directly, and the tests that pin it are named instead.
16. **We build against `@fhevm/solidity` 0.11.1; Zama's deployed batcher was compiled
    against 0.13.0.** Read from the batcher's own verified metadata in
    `out/batcher-src.txt`. Two minor versions apart, across a contract boundary we call
    in both directions. Nothing observed to be broken by it, and nothing testing it
    either. *(The OpenZeppelin confidential-contracts version agrees: the batcher uses
    0.5.3 and our `node_modules` resolves `^0.5.1` to 0.5.3.)*
17. **The batcher carries two documented brick conditions that our integration does not
    handle.** From the deployed source: `// If wrapper is full, this reverts. Will brick
    batcher.` and `// If output is less than toToken().rate() batch can never be
    finalized.` Neither appears on any Zama documentation page, and
    `SteakhouseReplicaSource` has no path that notices either. Our principal is currently
    in a finalized batch, so nothing is stranded today.
    → `out/batcher-src.txt`; `ZAMA-DOCS-BUNDLE.md` §7

### Environment limitations of this snapshot

- No `.env` in this checkout, so `npm run test:sepolia` and `scripts/status.ts` were not
  run. Everything in §§ 1–7 was obtained through public RPC and public HTTP instead.
- Encrypted values (positions, winnings, reserve) cannot be decrypted without a
  depositor key, so this file reports handles and event counts, never balances.
