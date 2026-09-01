// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint128, ebool, externalEuint128} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * A1 — what encrypted prize tiers actually cost.
 *
 * SPIKE. Not wired to anything. It exists to be run on Sepolia so the
 * FHEVMExecutor events can be decoded and priced against HCULimit.sol, which is
 * the same method that produced the 2,582,192 warm / 3,537,224 cold figures for
 * the production `accrue`. An estimate assembled from the cost table would be a
 * guess about which operations the compiler actually emits; this is not.
 *
 * THE TIER CONSTRUCTION, and why it is PoolTogether's rather than invented.
 *
 * V5 gives each tier its own odds: `TierCalculationLib.getWinningZone` scales a
 * user's TWAB by `tierOdds`, so a rarer tier is a narrower zone. The same shape
 * falls out of our threshold if the tier widens the RANGE instead of narrowing
 * the zone:
 *
 *     threshold(t) = uniform(keccak(r, drawId, user, t), totalWeight * k[t])
 *     P(win tier t) = weight / (totalWeight * k[t])
 *
 * Summed over users that is exactly `1 / k[t]` winners per draw for tier t, so
 * k = [100, 10, 1] gives a grand prize every hundred draws, a middle prize every
 * ten, and one ordinary winner every draw. The arithmetic is identical to V5's;
 * only the direction of the scaling changed, because our comparison runs the
 * other way round.
 *
 * Every threshold is a pure function of public inputs, so the rejection sampling
 * that removes modulo bias still costs zero HCU — the property that makes this
 * affordable at all.
 *
 * WHAT IS ENCRYPTED HERE THAT IS NOT IN V5: the tier itself. In PoolTogether the
 * tier is public the moment a prize is claimed. Here the nested select collapses
 * every outcome into one euint64 credit, so winning grand and winning nothing are
 * the same operation sequence on the same handle.
 */
contract TieredAccrualSpike is ZamaEthereumConfig {
    /// Public per-draw randomness and aggregate, as the real pool has after reveal.
    uint64 public r;
    uint128 public totalWeight;

    /// A participant's encrypted weight, set once so the measurement is repeatable.
    mapping(address => euint128) private _weight;

    /// Credited prize, encrypted. One handle whatever tier was won.
    mapping(address => euint64) private _credit;

    uint32 public constant DRAW_ID = 1;

    event Accrued(address indexed user, uint8 tiers);

    function seed(uint64 r_, uint128 total_) external {
        r = r_;
        totalWeight = total_;
    }

    // externalEuint128 + proof, not a bare handle: a contract handed a handle it
    // was never granted cannot even allowThis on it, which is SenderNotAllowed and
    // is how this spike failed on its first run.
    function setWeight(externalEuint128 w, bytes calldata proof) external {
        euint128 v = FHE.fromExternal(w, proof);
        _weight[msg.sender] = v;
        FHE.allowThis(v);
    }

    /** The measurement subject: exactly `n` tiers on one participant. */
    function accrueTiered(address user, uint64[] calldata prizes, uint128[] calldata k) external {
        require(prizes.length == k.length && prizes.length > 0, "shape");
        euint128 w = _weight[user];

        // Lowest index is the grand prize, so build the select chain from the
        // cheapest tier upward and let the rarest win override it.
        euint64 credit = FHE.asEuint64(0);
        for (uint256 i = prizes.length; i > 0; i--) {
            uint256 t = i - 1;
            uint128 threshold = _thresholdFor(user, t, k[t]);
            ebool won = FHE.gt(w, threshold);
            credit = FHE.select(won, FHE.asEuint64(prizes[t]), credit);
        }

        _credit[user] = credit;
        FHE.allowThis(credit);
        FHE.allow(credit, user);
        emit Accrued(user, uint8(prizes.length));
    }

    /** The production shape, for a like-for-like baseline in the same transaction style. */
    function accrueFlat(address user, uint64 prize) external {
        euint128 w = _weight[user];
        uint128 threshold = _thresholdFor(user, 0, 1);
        ebool won = FHE.gt(w, threshold);
        euint64 credit = FHE.select(won, FHE.asEuint64(prize), FHE.asEuint64(0));
        _credit[user] = credit;
        FHE.allowThis(credit);
        FHE.allow(credit, user);
        emit Accrued(user, 1);
    }

    /**
     * A2 — the same decision with the aggregate kept ENCRYPTED.
     *
     * weight/totalWeight > r/MAX  <=>  weight * MAX > totalWeight * r
     *
     * so the public threshold disappears and both sides become ciphertext. The
     * scale factor has to be small enough that neither product leaves euint128:
     * weight is a cumulative (balance x seconds) and can be large, so this shifts
     * it down first rather than pretending the headroom is there.
     */
    function accrueEncryptedTotal(address user, euint128 encTotal, uint64 rr, uint64 prize) external {
        euint128 w = FHE.shr(_weight[user], 32);
        euint128 lhs = FHE.mul(w, uint128(1) << 32);
        euint128 rhs = FHE.mul(encTotal, uint128(rr));
        ebool won = FHE.gt(lhs, rhs);
        euint64 credit = FHE.select(won, FHE.asEuint64(prize), FHE.asEuint64(0));
        _credit[user] = credit;
        FHE.allowThis(credit);
        FHE.allow(credit, user);
        emit Accrued(user, 0);
    }

    /// The aggregate, encrypted, so the measurement has something real to read.
    function setTotal(externalEuint128 t, bytes calldata proof) external returns (euint128) {
        euint128 v = FHE.fromExternal(t, proof);
        _encTotal = v;
        FHE.allowThis(v);
        return v;
    }

    euint128 private _encTotal;

    function encTotal() external view returns (euint128) {
        return _encTotal;
    }

    function creditOf(address user) external view returns (euint64) {
        return _credit[user];
    }

    // ---------------------------------------------------------------- plaintext --

    function _thresholdFor(address user, uint256 tier, uint128 k) private view returns (uint128) {
        uint256 upper = uint256(totalWeight) * uint256(k);
        return uint128(_uniform(uint256(keccak256(abi.encode(r, DRAW_ID, user, tier))), upper));
    }

    /// PoolTogether's UniformRandomNumber.uniform. Plaintext, so it costs no HCU.
    function _uniform(uint256 entropy, uint256 upperBound) private pure returns (uint256) {
        if (upperBound == 0) return 0;
        uint256 min = (type(uint256).max - upperBound + 1) % upperBound;
        uint256 random = entropy;
        while (random < min) {
            random = uint256(keccak256(abi.encode(random)));
        }
        return random % upperBound;
    }
}
