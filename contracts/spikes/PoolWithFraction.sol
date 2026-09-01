// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, euint64, euint128, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {FHESafeMath} from "@openzeppelin/confidential-contracts/utils/FHESafeMath.sol";
import {IYieldSource} from "../interfaces/IYieldSource.sol";

/**
 * Confidential no-loss prize savings — deposits, withdrawals, and the
 * time-weighted balance record the draw is scored against.
 *
 * The draw itself is not here. This contract's whole job is to make
 * `twabBetween(user, t0, t1)` answerable later without having leaked anything
 * along the way, and the shape of that record is what the step-1 measurements
 * decided:
 *
 *   - Winner selection is an independent per-user threshold, not a prefix scan
 *     over a global ordering. PoolTogether V5 works the same way
 *     (`TierCalculationLib.isWinner`), so there is no cross-user aggregation to
 *     maintain and no draw-time snapshot of an ordering. What must be frozen is
 *     each user's own weight, which is an O(1) local checkpoint.
 *
 *   - The cumulative accumulator is `euint128`, not `euint64`. This is forced,
 *     not cautious: the cumulative is the sum of balance times elapsed seconds,
 *     and a 6-decimal balance of 1e12 held for a year reaches 3.15e19 against a
 *     2^64 ceiling of 1.84e19. It overflows in about seven months. Widening
 *     costs 955,032 HCU per observation against 527,000, which is 4.8% of the
 *     per-transaction ceiling either way.
 *
 *   - The aggregate is stored ENCRYPTED and is never continuously public. The
 *     draw needs `totalWeight` in plaintext to map a threshold into
 *     `[0, totalWeight)`, but a running total that is public at all times would
 *     publish every deposit as its own delta — the confidentiality claim would
 *     die on the first deposit. The aggregate is therefore revealed once per
 *     draw, alongside R, through the same KMS path GhostLend uses for epoch
 *     utilisation. What leaks is the change between consecutive draws, which is
 *     an anonymity-set question rather than a per-user disclosure.
 *
 * Withdrawal clamps rather than reverts, for the same reason the claim path
 * will: a revert is observable, and an observable failure is a leak.
 */
contract PoolWithFraction is ZamaEthereumConfig {
    /// The ERC-7984 token this pool holds. Deposits arrive already confidential.
    IERC7984 public immutable asset;

    /**
     * One point in a balance's history.
     *
     * `timestamp` is plaintext, and that is the load-bearing detail: every
     * lookup is a binary search over these, so PoolTogether's search structure
     * ports to FHE untouched. Only the payload is encrypted.
     */
    struct Observation {
        uint40 timestamp;
        euint64 balance; // balance as of this observation
        euint128 cumulative; // sum of balance * elapsed seconds, up to this timestamp
    }

    mapping(address => Observation[]) private _userObs;

    /// The pool-wide aggregate. Encrypted here; revealed only at draw time.
    Observation[] private _totalObs;

    /**
     * A draw's life, and the order is the security property.
     *
     *   Open       weights frozen and R drawn, in one transaction
     *   Revealed   R and the total weight are public
     *
     * The ordering matters because the per-user threshold is
     * `keccak256(R, address)`, a pure function of public inputs. Anyone who
     * learns R before the eligible set is fixed can grind addresses until one
     * yields a near-zero threshold and win with dust. Freezing the snapshot and
     * drawing R in the same transaction makes that impossible: R does not exist
     * before the snapshot, and does not become public until the KMS reveal.
     */
    enum DrawStatus {
        None,
        Open,
        Revealed
    }

    struct Draw {
        uint40 periodStart;
        uint40 snapshotAt;
        DrawStatus status;
        euint64 encR;
        euint128 encTotalWeight;
        uint64 r;
        uint128 totalWeight;
    }

    uint32 public drawCount;

    /// Per-winner prize, plaintext and fixed. §5.4 sizes the reserve against it.
    uint64 public prize;

    /// Funds the prizes. Encrypted, because its size is a claim about the pool.
    euint64 private _reserve;

    /**
     * Where idle principal earns. Optional, and the pool works without one —
     * a pool with no source simply has no yield, which is what this contract
     * did before the source existed and what the tests without one still
     * exercise.
     */
    IYieldSource public yieldSource;

    /**
     * Credits won but not yet folded into a balance.
     *
     * `accrue` deliberately does NOT write an observation. Writing one would cost
     * another cumulative extrapolation per user per draw, and the fold-in is free
     * on any path that was already going to write one — which is every deposit
     * and every withdrawal.
     */
    mapping(address => euint64) private _pending;

    /// Lifetime winnings, kept for the EIP-712 read the bounty asks for.
    mapping(address => euint64) private _winnings;

    /// Plaintext, and it leaks nothing: accrual happens for everyone.
    mapping(uint32 => mapping(address => bool)) public accrued;

    /**
     * Cumulative at a draw's snapshot, cached.
     *
     * An optimisation and nothing more. Draw N's window opens where draw N-1's
     * closed, so the value is computed twice unless it is kept. A cold cache is
     * correct and merely costs more, and accruing draws out of order is correct
     * for the same reason — see the note on `_snapshotCumulative`.
     */
    mapping(uint32 => mapping(address => euint128)) private _cumAt;

    mapping(uint32 => Draw) private _draws;

    /// Start of the first draw's window.
    uint40 public immutable genesis;

    event DrawOpened(uint32 indexed drawId, uint40 periodStart, uint40 snapshotAt);
    event DrawRevealed(uint32 indexed drawId, uint64 r, uint128 totalWeight);

    error DrawNotOpen();
    error PreviousDrawUnresolved();
    error NothingStaked();
    error DrawNotRevealed();
    error PrizeNotSet();

    event Accrued(address indexed user, uint32 indexed drawId);
    event ReserveFunded(uint40 timestamp);
    event YieldSourceSet(address indexed source);
    event Harvested(uint40 timestamp);

    event Deposited(address indexed user, uint40 timestamp, uint256 observationIndex);
    event Withdrawn(address indexed user, uint40 timestamp, uint256 observationIndex);

    error NoObservations();
    error TimestampInFuture();

    constructor(IERC7984 asset_, uint40 minPeriod_) {
        asset = asset_;
        genesis = uint40(block.timestamp);
    }

    // -----------------------------------------------------------------------
    // deposit / withdraw
    // -----------------------------------------------------------------------

    /**
     * Pulls `encAmount` from the caller into the pool.
     *
     * The caller must have granted this contract operator rights on the asset
     * first (`IERC7984.setOperator`). The amount actually moved is whatever the
     * token reports as `transferred` — never the requested amount — because a
     * short balance is clamped by the token to an encrypted zero rather than
     * reverting, and booking the request instead of the transfer would credit
     * deposits that never arrived.
     */
    /**
     * SPIKE ONLY. A fraction of the caller's balance, with no plaintext.
     *
     * Deliberately shares no code with the frozen surface: it reaches _drain
     * and the two TWAB pushes exactly the way deposit() does, and touches
     * accrue, _snapshotCumulative, _cumulativeAt, thresholdFor and _uniform
     * not at all.
     */
    function depositShifted(euint64 balanceHandle, uint8 shift) external {
        _drain(msg.sender);
        euint64 amount = FHE.shr(balanceHandle, shift);

        FHE.allowTransient(amount, address(asset));
        euint64 received = asset.confidentialTransferFrom(msg.sender, address(this), amount);

        if (address(yieldSource) != address(0)) {
            FHE.allowTransient(received, address(yieldSource));
            yieldSource.supply(received);
        }

        (, euint64 newUser) = FHESafeMath.tryAdd(_balanceOf(_userObs[msg.sender]), received);
        (, euint64 newTotal) = FHESafeMath.tryAdd(_balanceOf(_totalObs), received);

        _push(_userObs[msg.sender], newUser, msg.sender);
        _push(_totalObs, newTotal, address(0));

        emit Deposited(msg.sender, uint40(block.timestamp), _userObs[msg.sender].length - 1);
    }
    function deposit(externalEuint64 encAmount, bytes calldata inputProof) external {
        _drain(msg.sender);
        euint64 amount = FHE.fromExternal(encAmount, inputProof);

        // Transient is enough: the token consumes it inside this call, and the
        // handle it returns is itself transient, so everything derived from it
        // has to be settled before this function returns.
        FHE.allowTransient(amount, address(asset));
        euint64 received = asset.confidentialTransferFrom(msg.sender, address(this), amount);

        // Principal does not sit here. It goes straight to the yield source, so
        // it is earning from the moment it arrives rather than from whenever a
        // keeper next remembers to move it.
        if (address(yieldSource) != address(0)) {
            FHE.allowTransient(received, address(yieldSource));
            yieldSource.supply(received);
        }

        (, euint64 newUser) = FHESafeMath.tryAdd(_balanceOf(_userObs[msg.sender]), received);
        (, euint64 newTotal) = FHESafeMath.tryAdd(_balanceOf(_totalObs), received);

        _push(_userObs[msg.sender], newUser, msg.sender);
        _push(_totalObs, newTotal, address(0));

        emit Deposited(msg.sender, uint40(block.timestamp), _userObs[msg.sender].length - 1);
    }

    /**
     * Returns up to `encAmount` to the caller.
     *
     * Asking for more than the balance moves an encrypted zero and leaves the
     * balance untouched. It does not revert: a revert is visible on chain, and
     * "this account tried to withdraw more than it had" is exactly the kind of
     * fact this pool exists to keep private.
     */
    /**
     * SPIKE ONLY. A fraction of the position, out.
     *
     * The asymmetry with depositShifted is the whole point: on the way OUT the
     * pool already owns the handle it needs to compute on, because it wrote it
     * with allowThis. No ACL grant, no second transaction, and the caller never
     * chooses a number.
     */
    function withdrawShifted(uint8 shift) external {
        _drain(msg.sender);
        euint64 balance = _balanceOf(_userObs[msg.sender]);
        euint64 amount = FHE.shr(balance, shift);

        (ebool within, euint64 decreased) = FHESafeMath.tryDecrease(balance, amount);
        euint64 request = FHE.select(within, amount, FHE.asEuint64(0));

        euint64 sent;
        if (address(yieldSource) != address(0)) {
            FHE.allowTransient(request, address(yieldSource));
            sent = yieldSource.redeem(request, msg.sender);
        } else {
            FHE.allowTransient(request, address(asset));
            sent = asset.confidentialTransfer(msg.sender, request);
        }

        (, euint64 newUser) = FHESafeMath.tryAdd(decreased, FHE.sub(request, sent));
        (, euint64 newTotal) = FHESafeMath.tryDecrease(_balanceOf(_totalObs), sent);

        _push(_userObs[msg.sender], newUser, msg.sender);
        _push(_totalObs, newTotal, address(0));
    }
    function withdraw(externalEuint64 encAmount, bytes calldata inputProof) external {
        _drain(msg.sender);
        euint64 amount = FHE.fromExternal(encAmount, inputProof);
        euint64 balance = _balanceOf(_userObs[msg.sender]);

        (ebool within, euint64 decreased) = FHESafeMath.tryDecrease(balance, amount);
        euint64 request = FHE.select(within, amount, FHE.asEuint64(0));

        // With a source, the principal is over there and comes back straight to
        // the withdrawer — one transfer rather than two. Without one, the pool
        // still holds it and pays directly. Both paths are tested.
        euint64 sent;
        if (address(yieldSource) != address(0)) {
            FHE.allowTransient(request, address(yieldSource));
            sent = yieldSource.redeem(request, msg.sender);
        } else {
            FHE.allowTransient(request, address(asset));
            sent = asset.confidentialTransfer(msg.sender, request);
        }

        // The token may move less than asked even after the clamp. Whatever it
        // declined to move is returned to the balance in the same transaction,
        // because `sent` is transient and cannot be reconciled in a later one.
        euint64 refund = FHE.sub(request, sent);
        (, euint64 newUser) = FHESafeMath.tryAdd(decreased, refund);
        (, euint64 newTotal) = FHESafeMath.trySub(_balanceOf(_totalObs), sent);

        _push(_userObs[msg.sender], newUser, msg.sender);
        _push(_totalObs, newTotal, address(0));

        emit Withdrawn(msg.sender, uint40(block.timestamp), _userObs[msg.sender].length - 1);
    }

    // -----------------------------------------------------------------------
    // the record
    // -----------------------------------------------------------------------

    /**
     * Appends an observation, carrying the cumulative forward.
     *
     * The widening happens BEFORE the multiply. Multiplying at 64 bits and
     * casting afterwards would overflow exactly where A5 says it does, and
     * silently — an FHE multiply has no revert to notice.
     */
    function _push(Observation[] storage obs, euint64 newBalance, address reader) private {
        uint40 nowTs = uint40(block.timestamp);
        euint128 cumulative;

        if (obs.length == 0) {
            cumulative = FHE.asEuint128(0);
        } else {
            Observation storage last = obs[obs.length - 1];
            uint128 dt = uint128(nowTs - last.timestamp);
            cumulative = FHE.add(last.cumulative, FHE.mul(FHE.asEuint128(last.balance), dt));
        }

        FHE.allowThis(newBalance);
        FHE.allowThis(cumulative);
        if (reader != address(0)) {
            FHE.allow(newBalance, reader);
            FHE.allow(cumulative, reader);
        }

        obs.push(Observation({timestamp: nowTs, balance: newBalance, cumulative: cumulative}));
    }

    function _balanceOf(Observation[] storage obs) private view returns (euint64) {
        if (obs.length == 0) return euint64.wrap(0);
        return obs[obs.length - 1].balance;
    }

    /**
     * Index of the last observation at or before `target`.
     *
     * A binary search over plaintext timestamps — the same structure
     * `TwabController` uses, unchanged by anything confidential. Reverts if
     * `target` predates the first observation, because there is no balance to
     * report rather than a zero one, and the two are different claims.
     */
    function _indexAt(Observation[] storage obs, uint40 target) private view returns (uint256) {
        uint256 len = obs.length;
        if (len == 0 || obs[0].timestamp > target) revert NoObservations();
        uint256 lo = 0;
        uint256 hi = len - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (obs[mid].timestamp <= target) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    // -----------------------------------------------------------------------
    // views
    // -----------------------------------------------------------------------

    function confidentialBalanceOf(address account) external view returns (euint64) {
        return _balanceOf(_userObs[account]);
    }

    function observationCount(address account) external view returns (uint256) {
        return _userObs[account].length;
    }

    function totalObservationCount() external view returns (uint256) {
        return _totalObs.length;
    }

    function observationAt(address account, uint256 i) external view returns (Observation memory) {
        return _userObs[account][i];
    }

    function indexAt(address account, uint40 target) external view returns (uint256) {
        if (target > uint40(block.timestamp)) revert TimestampInFuture();
        return _indexAt(_userObs[account], target);
    }

    /**
     * The cumulative as of `target`, extrapolated from the observation at or
     * before it — `TwabController`'s "temporary observation" step.
     *
     * Not a view: extrapolation is an FHE multiply and an add, which are calls
     * to the coprocessor. The draw will read this through a transaction.
     */
    function cumulativeAt(address account, uint40 target) external returns (euint128) {
        if (target > uint40(block.timestamp)) revert TimestampInFuture();
        Observation storage o = _userObs[account][_indexAt(_userObs[account], target)];
        euint128 extrapolated = FHE.add(
            o.cumulative,
            FHE.mul(FHE.asEuint128(o.balance), uint128(target - o.timestamp))
        );
        FHE.allowThis(extrapolated);
        FHE.allow(extrapolated, msg.sender);
        return extrapolated;
    }
    // -----------------------------------------------------------------------
    // the draw
    // -----------------------------------------------------------------------

    /**
     * Freezes the weights and draws the randomness, in that order, atomically.
     *
     * Both handles are marked publicly decryptable here and read back by
     * `revealDraw`. GhostLend paid for the traps this walks past
     * (`GhostLendPool.sol:182-183, :503-520`) and they all apply:
     *
     *   - `makePubliclyDecryptable` is permanent and irrevocable, so it is used
     *     only on the aggregate and on R, never on anything per-user.
     *   - A null handle is rejected by the KMS and bricks the machine, which is
     *     why an empty pool is refused here rather than discovered later.
     */
    function openDraw() external returns (uint32 drawId) {
        if (drawCount != 0 && _draws[drawCount].status != DrawStatus.Revealed) {
            revert PreviousDrawUnresolved();
        }
        // A pool nobody has deposited into has a null aggregate handle, and
        // handing the KMS a null handle is how the epoch machine bricks.
        if (_totalObs.length == 0) revert NothingStaked();

        uint40 periodStart = drawCount == 0 ? genesis : _draws[drawCount].snapshotAt;
        uint40 snapshotAt = uint40(block.timestamp);

        // The window's aggregate weight. Cumulative differences, not averages:
        // the threshold compares a ratio, so dividing by the window length would
        // cancel on both sides and only cost precision.
        euint128 total = FHE.sub(
            _cumulativeAt(_totalObs, snapshotAt),
            _cumulativeAt(_totalObs, periodStart)
        );
        euint64 r = FHE.randEuint64();

        FHE.allowThis(total);
        FHE.allowThis(r);
        FHE.makePubliclyDecryptable(total);
        FHE.makePubliclyDecryptable(r);

        drawId = ++drawCount;
        _draws[drawId] = Draw({
            periodStart: periodStart,
            snapshotAt: snapshotAt,
            status: DrawStatus.Open,
            encR: r,
            encTotalWeight: total,
            r: 0,
            totalWeight: 0
        });

        emit DrawOpened(drawId, periodStart, snapshotAt);
    }

    /**
     * Publishes R and the total weight once the KMS has signed off on them.
     *
     * The status check comes BEFORE `checkSignatures`, and that ordering is the
     * point: `checkSignatures` carries no replay guard of its own
     * (`GhostLendPool.sol:520` says so in as many words), so without this a
     * draw could be finalised repeatedly. Re-finalising is also how a keeper
     * would grind R, which makes this guard the A6 mitigation rather than
     * housekeeping.
     */
    function revealDraw(
        uint32 drawId,
        bytes calldata cleartexts,
        bytes calldata decryptionProof
    ) external {
        Draw storage d = _draws[drawId];
        if (d.status != DrawStatus.Open) revert DrawNotOpen();

        // Rebuilt from storage in the same order the off-chain request used.
        bytes32[] memory handles = new bytes32[](2);
        handles[0] = FHE.toBytes32(d.encR);
        handles[1] = FHE.toBytes32(d.encTotalWeight);
        FHE.checkSignatures(handles, cleartexts, decryptionProof);

        (uint256 r, uint256 total) = abi.decode(cleartexts, (uint256, uint256));
        _applyReveal(drawId, uint64(r), uint128(total));
    }

    /**
     * Records a revealed draw.
     *
     * Split out from `revealDraw` only so a test harness can reach it: the KMS
     * round trip needs real signatures and is exercised on Sepolia, but every
     * behaviour that depends on a draw BEING revealed has to be testable without
     * a network. Production has exactly one caller, and it is the one above.
     */
    function _applyReveal(uint32 drawId, uint64 r, uint128 total) internal virtual {
        Draw storage d = _draws[drawId];
        d.r = r;
        d.totalWeight = total;
        d.status = DrawStatus.Revealed;
        emit DrawRevealed(drawId, r, total);
    }

    /**
     * The per-user threshold, in plaintext.
     *
     * This is PoolTogether V5's own construction, not an FHE workaround:
     * `TierCalculationLib` maps `keccak256(drawId, vault, user, ...)` uniformly
     * into `[0, vaultTwabTotalSupply)` and compares it against a zone scaled by
     * the user's own TWAB. Each user is evaluated independently, with no
     * cross-user aggregation — which is why SaveTogether needs no prefix sums and
     * no global ordering.
     *
     * Because every input is public, the rejection sampling that removes modulo
     * bias runs in plaintext and costs no FHE at all.
     */
    function thresholdFor(uint32 drawId, address user) public view returns (uint128) {
        Draw storage d = _draws[drawId];
        if (d.status != DrawStatus.Revealed) revert DrawNotRevealed();
        return uint128(_uniform(uint256(keccak256(abi.encode(d.r, drawId, user))), d.totalWeight));
    }

    /**
     * PoolTogether's `UniformRandomNumber.uniform`, ported.
     *
     * A bare modulus over-represents the low end of the range by the remainder,
     * which for a lottery is a bias in who wins. Rejection sampling removes it
     * exactly rather than bounding it.
     */
    function _uniform(uint256 entropy, uint256 upperBound) internal pure returns (uint256) {
        if (upperBound == 0) return 0;
        uint256 min = (type(uint256).max - upperBound + 1) % upperBound;
        uint256 random = entropy;
        while (random < min) {
            random = uint256(keccak256(abi.encode(random)));
        }
        return random % upperBound;
    }

    /**
     * A user's weight for a draw: the cumulative accrued inside the window.
     *
     * An account with no observation at or before `snapshotAt` contributes zero,
     * and `FHE.gt` is strict, so an address created after the snapshot can never
     * win no matter what its threshold turns out to be. That is the arithmetic
     * half of the A6 ordering defence; `openDraw` is the other half.
     */
    function weightFor(uint32 drawId, address user) external returns (euint128) {
        Draw storage d = _draws[drawId];
        if (d.status == DrawStatus.None) revert DrawNotOpen();
        euint128 w = FHE.sub(
            _cumulativeAt(_userObs[user], d.snapshotAt),
            _cumulativeAt(_userObs[user], d.periodStart)
        );
        FHE.allowThis(w);
        FHE.allow(w, msg.sender);
        return w;
    }

    function drawAt(uint32 drawId) external view returns (Draw memory) {
        return _draws[drawId];
    }

    /**
     * Cumulative as of `target`, or an encrypted zero if the record starts later.
     *
     * Returning zero rather than reverting is correct here and is a different
     * question from `indexAt`'s: a user who had not joined yet genuinely had no
     * weight accruing, whereas asking `indexAt` for a balance that was never
     * recorded is asking for something that does not exist.
     */
    function _cumulativeAt(
        Observation[] storage obs,
        uint40 target
    ) private returns (euint128) {
        if (obs.length == 0 || obs[0].timestamp > target) return FHE.asEuint128(0);
        Observation storage o = obs[_indexAt(obs, target)];
        return FHE.add(o.cumulative, FHE.mul(FHE.asEuint128(o.balance), uint128(target - o.timestamp)));
    }

    // -----------------------------------------------------------------------
    // accrual
    // -----------------------------------------------------------------------

    /**
     * Points the pool at a yield source and authorises it to pull principal.
     *
     * The operator grant is what lets `supply` move tokens out of this contract;
     * without it every deposit would silently keep its principal here and the
     * prize would never be funded.
     */
    function setYieldSource(IYieldSource source) external {
        yieldSource = source;
        if (address(source) != address(0)) {
            asset.setOperator(address(source), type(uint48).max);
        }
        emit YieldSourceSet(address(source));
    }

    /**
     * Moves accrued yield into the reserve the prizes are paid from.
     *
     * Permissionless, and this is the sentence the product's claim rests on:
     * the prize comes from yield on the pool's own deposits, not from a pot
     * somebody topped up by hand.
     */
    function harvest() external {
        if (address(yieldSource) == address(0)) return;
        euint64 got = yieldSource.harvest(address(this));
        (, euint64 next) = FHESafeMath.tryAdd(_reserve, got);
        _reserve = next;
        FHE.allowThis(_reserve);
        emit Harvested(uint40(block.timestamp));
    }

    /// Sets the per-winner prize. Plaintext by design; the reserve is not.
    function setPrize(uint64 prize_) external {
        prize = prize_;
    }

    /// Seeds the reserve the prizes are paid from.
    function fundReserve(externalEuint64 encAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encAmount, inputProof);
        FHE.allowTransient(amount, address(asset));
        euint64 received = asset.confidentialTransferFrom(msg.sender, address(this), amount);
        (, euint64 next) = FHESafeMath.tryAdd(_reserve, received);
        _reserve = next;
        FHE.allowThis(_reserve);
        emit ReserveFunded(uint40(block.timestamp));
    }

    /**
     * Awards a draw to one participant. Anyone may call it, for anyone.
     *
     * Nobody claims in this protocol, and that is a security property rather than
     * a convenience. The threshold is a pure function of public inputs, so a
     * participant can work out their own result off chain with no transaction —
     * which means a loser has no reason to claim, only winners would, and "who
     * claimed" would become "who won". Removing the claim removes the signal.
     *
     * Idempotent by a plaintext flag, and the flag leaks nothing because accrual
     * happens for every participant regardless of outcome.
     */
    function accrue(address user, uint32 drawId) public {
        Draw storage d = _draws[drawId];
        if (d.status != DrawStatus.Revealed) revert DrawNotRevealed();
        if (prize == 0) revert PrizeNotSet();
        if (accrued[drawId][user]) return;
        accrued[drawId][user] = true;

        euint128 weight = FHE.sub(
            _snapshotCumulative(user, drawId, d.snapshotAt),
            drawId == 1
                ? _cumulativeAt(_userObs[user], d.periodStart)
                : _snapshotCumulative(user, drawId - 1, _draws[drawId - 1].snapshotAt)
        );

        // Public threshold, encrypted weight, strict comparison. An address with
        // no history before the snapshot has weight zero and `gt` is strict, so
        // it cannot win whatever its threshold turns out to be.
        ebool won = FHE.gt(weight, thresholdFor(drawId, user));
        euint64 credit = FHE.select(won, FHE.asEuint64(prize), FHE.asEuint64(0));

        // The prize is only awarded if the reserve can cover it. Without this a
        // tail run of winners would mint balance the pool does not hold.
        (ebool funded, euint64 nextReserve) = FHESafeMath.tryDecrease(_reserve, credit);
        euint64 paid = FHE.select(funded, credit, FHE.asEuint64(0));
        _reserve = nextReserve;
        FHE.allowThis(_reserve);

        (, euint64 nextPending) = FHESafeMath.tryAdd(_pending[user], paid);
        (, euint64 nextWinnings) = FHESafeMath.tryAdd(_winnings[user], paid);
        _pending[user] = nextPending;
        _winnings[user] = nextWinnings;

        FHE.allowThis(nextPending);
        FHE.allowThis(nextWinnings);
        FHE.allow(nextWinnings, user);

        emit Accrued(user, drawId);
    }

    /// Chunked accrual. Each entry is independent, so a chunk that reverts costs nothing else.
    function accrueMany(address[] calldata users, uint32 drawId) external {
        for (uint256 i = 0; i < users.length; i++) {
            accrue(users[i], drawId);
        }
    }

    /**
     * Folds any pending credit into the balance.
     *
     * Runs at the top of every deposit and withdrawal, which is what keeps the
     * keeper's liveness from becoming a privacy problem: anyone the keeper missed
     * is swept up by their next ordinary action instead of having to make a
     * standalone call that would single them out.
     */
    function _drain(address user) private {
        euint64 pending = _pending[user];
        if (!FHE.isInitialized(pending)) return;
        (, euint64 newBalance) = FHESafeMath.tryAdd(_balanceOf(_userObs[user]), pending);
        _pending[user] = FHE.asEuint64(0);
        FHE.allowThis(_pending[user]);
        _push(_userObs[user], newBalance, user);
        (, euint64 newTotal) = FHESafeMath.tryAdd(_balanceOf(_totalObs), pending);
        _push(_totalObs, newTotal, address(0));
    }

    /**
     * Cumulative at a draw's snapshot, memoised.
     *
     * The cache is a cost optimisation and never a correctness condition. A cold
     * entry is computed from the observation record, which is the same source the
     * cached value came from — so accruing draw 5 before draw 4 gives the same
     * answer as the other order, just more expensively.
     */
    function _snapshotCumulative(
        address user,
        uint32 drawId,
        uint40 at
    ) private returns (euint128) {
        euint128 cached = _cumAt[drawId][user];
        if (FHE.isInitialized(cached)) return cached;
        euint128 computed = _cumulativeAt(_userObs[user], at);
        FHE.allowThis(computed);
        _cumAt[drawId][user] = computed;
        return computed;
    }

    function pendingOf(address user) external view returns (euint64) {
        return _pending[user];
    }

    function winningsOf(address user) external view returns (euint64) {
        return _winnings[user];
    }

    function reserveHandle() external view returns (euint64) {
        return _reserve;
    }

}
