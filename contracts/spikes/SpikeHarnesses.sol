// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {PoolFrozenBaseline} from "./PoolFrozenBaseline.sol";
import {PoolWithFraction} from "./PoolWithFraction.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";

/**
 * SPIKE ONLY. Two harnesses over two pools that differ by one function.
 *
 * Mirrors `PrizePoolHarness` so the accrue path can be exercised without the
 * KMS. The whole point is that these two are compared against each other and
 * nothing else, so whatever the harness adds, it adds identically to both.
 */
contract SpikeHarnessBaseline is PoolFrozenBaseline {
    constructor(IERC7984 asset_) PoolFrozenBaseline(asset_) {}

    function forceReveal(uint32 drawId, uint64 r, uint128 total) external {
        _applyReveal(drawId, r, total);
    }
}

contract SpikeHarnessVariant is PoolWithFraction {
    constructor(IERC7984 asset_) PoolWithFraction(asset_) {}

    function forceReveal(uint32 drawId, uint64 r, uint128 total) external {
        _applyReveal(drawId, r, total);
    }
}
