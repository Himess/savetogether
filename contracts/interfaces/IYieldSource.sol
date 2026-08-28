// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {euint64} from "@fhevm/solidity/lib/FHE.sol";

/**
 * Where the pool's idle principal earns, and where the prize comes from.
 *
 * The pool holds no opinion about what is on the other side of this. Two
 * implementations ship:
 *
 *   MockYieldSource   accrues at a fixed rate and settles immediately. What the
 *                     deployed demo uses, because it is deterministic on camera.
 *   ZamaVaultSource   Zama's own confidential ERC-4626 vault on Sepolia. Real,
 *                     tested live, and asynchronous — its batchers settle on
 *                     their own schedule, which is exactly why the demo does not
 *                     run on it.
 *
 * The split exists so "the prize is funded by yield" is a property of the
 * protocol rather than of one hardcoded mock, and so the composition story can
 * be demonstrated without putting a batching delay in the middle of a recording.
 *
 * Every amount is an `euint64` handle. A caller must grant this contract
 * transient ACL on any handle it passes in, and every method returns what
 * ACTUALLY moved rather than what was asked for — the token clamps, and booking
 * the request instead of the transfer is how a pool ends up insolvent.
 */
interface IYieldSource {
    /// The confidential token this source accepts.
    function asset() external view returns (address);

    /**
     * Takes principal in. The source pulls with `confidentialTransferFrom`, so
     * the caller must have made it an operator on the asset.
     */
    function supply(euint64 amount) external returns (euint64 supplied);

    /// Returns principal to `to`. Returns what was actually sent.
    function redeem(euint64 amount, address to) external returns (euint64 sent);

    /**
     * Moves everything accrued since the last call to `to`.
     *
     * Permissionless: a keeper calls it, and there is nothing to gain from
     * calling it early or often — the accrual is a function of elapsed time.
     */
    function harvest(address to) external returns (euint64 harvested);

    /// Principal currently held, encrypted. Readable only by whoever has ACL.
    function principal() external view returns (euint64);
}
