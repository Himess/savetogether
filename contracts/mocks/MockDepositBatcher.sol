// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * Enough of Zama's deposit batcher to test what leaving does to the buffer.
 *
 * It accepts the transfer and keeps the tokens. That is the only behaviour the
 * withdrawal path cares about: once principal is in a batch it is not in the
 * source, and `redeem` can only pay from what the source still holds.
 *
 * The receiver hook must grant the TOKEN access to the ebool it returns, or the
 * transfer reverts with ACLNotAllowed from FHEVMExecutor — a rule this codebase
 * learned by decoding selector 0x9de3392c rather than from a document.
 */
contract MockDepositBatcher is ZamaEthereumConfig {
    uint256 public currentBatchId = 1;

    function onConfidentialTransferReceived(
        address,
        address,
        euint64,
        bytes calldata
    ) external returns (ebool) {
        ebool ok = FHE.asEbool(true);
        FHE.allowThis(ok);
        FHE.allow(ok, msg.sender);
        return ok;
    }

    function claim(uint256, address) external {}

    function advance() external {
        currentBatchId += 1;
    }
}
