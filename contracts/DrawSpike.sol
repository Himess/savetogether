// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/**
 * Measurement scaffolding for GhostPool step 1. NOT production code.
 *
 * Three winner-selection designs, side by side, so their cost is measured rather
 * than argued:
 *
 *   A  independent per-user threshold  — O(1) per claim, scalar comparison,
 *                                        no ordering, no global snapshot
 *   B  prefix sums recomputed in the draw — chained adds, O(N)
 *   C  prefix sums maintained on deposit  — independent comparisons, O(N)
 *
 * B and C exist to be beaten. If A holds up, the prefix designs and the whole
 * chunked-draw question go away with them.
 *
 * Every FHE operation is an external call to the coprocessor's Executor, which
 * emits an event per op. Nothing here can be optimised away, so results are not
 * artificially consumed.
 */
contract DrawSpike is ZamaEthereumConfig {
    // -----------------------------------------------------------------------
    // A — independent threshold
    // -----------------------------------------------------------------------

    mapping(address => euint64) private _weight;
    mapping(address => euint64) private _credit;

    /// Setup, not measured.
    function setWeight(externalEuint64 w, bytes calldata proof) external {
        euint64 v = FHE.fromExternal(w, proof);
        FHE.allowThis(v);
        FHE.allow(v, msg.sender);
        _weight[msg.sender] = v;
    }

    /**
     * The design under test.
     *
     * threshold is public: it is keccak256(R, msg.sender) % totalWeight, and both
     * R and totalWeight are public by construction. The secret is the weight, and
     * the only thing an observer must not learn is which side of the comparison it
     * fell on. Winner and loser run identical code on identical calldata; whether
     * they also burn identical gas is the measurement.
     */
    function claimThreshold(uint64 threshold, uint64 prize) external {
        euint64 w = _weight[msg.sender];
        ebool won = FHE.gt(w, threshold);
        euint64 c = FHE.select(won, FHE.asEuint64(prize), FHE.asEuint64(0));
        FHE.allowThis(c);
        FHE.allow(c, msg.sender);
        _credit[msg.sender] = c;
    }

    function creditOf(address who) external view returns (euint64) {
        return _credit[who];
    }

    // -----------------------------------------------------------------------
    // B / C — prefix designs
    // -----------------------------------------------------------------------

    euint64[] private _weights;
    euint64[] private _prefix;
    ebool private _lastWin;

    /**
     * Seeds ciphertexts from plaintext, in chunks.
     *
     * Trivial encryption costs 32 HCU and produces an ordinary ciphertext, so the
     * comparisons measured later are unaffected. Chunking matters because building
     * a prefix by chained addition would itself hit the depth limit — which is a
     * finding about bulk initialisation, not about the draw, and is sidestepped
     * here deliberately: in production the prefix advances by one add per deposit
     * transaction.
     */
    function seedWeights(uint64[] calldata ws) external {
        for (uint256 i = 0; i < ws.length; i++) {
            euint64 v = FHE.asEuint64(ws[i]);
            FHE.allowThis(v);
            _weights.push(v);
        }
    }

    function seedPrefix(uint64[] calldata cumulative) external {
        for (uint256 i = 0; i < cumulative.length; i++) {
            euint64 v = FHE.asEuint64(cumulative[i]);
            FHE.allowThis(v);
            _prefix.push(v);
        }
    }

    function reset() external {
        delete _weights;
        delete _prefix;
    }

    function sizes() external view returns (uint256, uint256) {
        return (_weights.length, _prefix.length);
    }

    /**
     * B — the naive draw. prefix[i] = prefix[i-1] + weight[i] inside the draw, so
     * the adds form a chain and sequential depth is expected to bind before the
     * global limit does.
     */
    function drawNaive(uint256 n, uint64 total) external {
        euint64 r = FHE.rem(FHE.randEuint64(), total);
        euint64 prefix = FHE.asEuint64(0);
        ebool last;
        for (uint256 i = 0; i < n; i++) {
            euint64 prev = prefix;
            prefix = FHE.add(prefix, _weights[i]);
            last = FHE.and(FHE.le(prev, r), FHE.lt(r, prefix));
        }
        _lastWin = last;
        FHE.allowThis(_lastWin);
    }

    /**
     * C — accumulation moved out of the draw. The comparisons no longer depend on
     * each other, so depth should stop scaling with N and the global limit should
     * become the binding one.
     */
    function drawIncremental(uint256 n, uint64 total) external {
        euint64 r = FHE.rem(FHE.randEuint64(), total);
        ebool last;
        for (uint256 i = 0; i < n; i++) {
            last = FHE.and(FHE.le(_prefix[i], r), FHE.lt(r, _prefix[i + 1]));
        }
        _lastWin = last;
        FHE.allowThis(_lastWin);
    }

    /**
     * C plus per-participant credit written at draw time, to price what deferring
     * the credit to claim time actually buys.
     */
    function drawIncrementalWithCredit(uint256 n, uint64 total, uint64 prize) external {
        euint64 r = FHE.rem(FHE.randEuint64(), total);
        euint64 zero = FHE.asEuint64(0);
        euint64 p = FHE.asEuint64(prize);
        ebool last;
        for (uint256 i = 0; i < n; i++) {
            last = FHE.and(FHE.le(_prefix[i], r), FHE.lt(r, _prefix[i + 1]));
            FHE.select(last, p, zero);
        }
        _lastWin = last;
        FHE.allowThis(_lastWin);
    }
}
