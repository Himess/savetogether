// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {ConfidentialPrizePool} from "../ConfidentialPrizePool.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/**
 * TEST-ONLY. Reveals a draw without the KMS.
 *
 * `revealDraw` needs real KMS signatures, which exist only on a live network.
 * Everything that depends on a draw having been revealed — accrual, idempotence,
 * the reserve clamp, the zero-weight defence — has to be testable without one, or
 * it gets tested once on Sepolia and never again in CI.
 *
 * The ordering guarantee is NOT weakened by this contract's existence: the guard
 * that matters is `revealDraw`'s status check running before `checkSignatures`,
 * and that path is untouched here and asserted in `test/draw-ordering.ts`.
 */
contract PrizePoolHarness is ConfidentialPrizePool {
    constructor(IERC7984 asset_, uint40 minPeriod_) ConfidentialPrizePool(asset_, minPeriod_) {}

    function forceReveal(uint32 drawId, uint64 r, uint128 total) external {
        _applyReveal(drawId, r, total);
    }
}
