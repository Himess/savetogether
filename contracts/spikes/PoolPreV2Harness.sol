// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {PoolPreV2} from "./PoolPreV2.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/**
 * The pool as it was BEFORE the access-control and draw-floor fix.
 *
 * Kept only so the frozen surface can be compared against something rather than
 * asserted. The 306-sample equality result is a claim about accrue costing the
 * same on both sides of the threshold; this is how we show the fix did not move
 * it. Not deployed, not merged into the product.
 */
contract PoolPreV2Harness is PoolPreV2 {
    constructor(IERC7984 asset_) PoolPreV2(asset_) {}

    function forceReveal(uint32 drawId, uint64 r, uint128 total) external {
        _applyReveal(drawId, r, total);
    }
}
