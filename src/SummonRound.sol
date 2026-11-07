// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {IB20} from "base-std/interfaces/IB20.sol";
import {IPolicyRegistry} from "base-std/interfaces/IPolicyRegistry.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {HLPriceGuard} from "hl-price-guard/HLPriceGuard.sol";
import {PythRef, IPyth} from "hl-price-guard/PythRef.sol";
import {MarketStateRegistry} from "market-state/MarketStateRegistry.sol";
import {MarketStateCheck} from "market-state/MarketStateCheck.sol";
import {SummonPrice} from "./SummonPrice.sol";
import {SummonPool} from "./SummonPool.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// The token's multiplier and scheduled ERC-8056 change (B20 Asset).
interface IB20AssetMin {
    function multiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}

/// Coinbase's oracle registry on Base mainnet (0x3f3E…5CaD), selector 0xd4197e82; a mock on Sepolia.
interface IOracleParams {
    function getOracleParams(address token) external view returns (uint256 multiplier, bool paused);
}

/// @title SummonRound
/// @notice Spec 001: one round per ticker. Backers pledge USDC up to a target; once it is reached and the
///         market is open, a Dutch auction on the spread lets any holder of the stock token fill at the Pyth
///         reference price; part of the round seeds a Uniswap v4 pool that the backers own pro rata.
contract SummonRound is IUnlockCallback {
    using HLPriceGuard for HLPriceGuard.JumpLatch;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    enum State {
        Open,
        Funded,
        Auction,
        Filled,
        Expired
    }

    struct Deps {
        address usdc;
        address policyRegistry;
        address marketState;
        address oracleRegistry; // address(0): no issuer registry on this chain
        address poolManager;
        address hook;
    }

    struct Params {
        address token;
        address priceSource; // Pyth, or a feed with Pyth's read interface; bound to the token by the factory owner
        bytes32 priceId;
        uint256 target; // USDC, 6 decimals
        uint64 deadline;
        uint16 maxSpreadBps; // <= 100
        uint16 lpBps; // share of the round that seeds the pool, <= 5000
        uint32 rampSeconds;
        uint32 windowSeconds;
        uint8 maxAuctions;
        uint32 lpLockSeconds;
        uint32 maxGuardAge;
        uint32 maxPythAge;
        uint16 maxConfBps;
        uint16 maxJumpBps;
        uint32 cooldownSeconds; // corporate-action window around a scheduled multiplier change
    }

    uint16 public constant MAX_SPREAD_CAP_BPS = 100;
    uint16 public constant MAX_LP_BPS = 5000;
    uint8 internal constant OP_UNWIND = 0;
    uint8 internal constant OP_SEED = 1;
    uint8 internal constant OP_REALIGN = 2;

    Deps internal d;
    Params internal p;
    address public immutable factory;
    uint8 public immutable tokenDecimals;

    State internal _state;
    uint256 public pledged;
    mapping(address => uint256) public pledgeOf;

    uint64 public auctionStart;
    uint8 public auctionsRun;
    uint256 public multiplierAtStart;
    HLPriceGuard.JumpLatch internal latch;

    // fill results
    uint64 public filledAt;
    address public filler;
    uint256 public fillSpreadBps;
    uint256 public fillRef; // USD per whole token, 18 decimals
    uint256 public backerTokens; // raw token units owed to backers in total
    uint256 public backerUsdcDust; // seed USDC the pool did not take, owed to backers in total
    uint128 public liquidity;
    uint256 public poolMultiplier; // the token multiplier the pool is priced at (§5.5a)
    uint256 public idleTokens; // what realign could not put back, owed to backers at unwind
    uint256 public idleUsdc;
    mapping(address => bool) public claimed;

    // LP unwind
    bool public unwound;
    uint256 public lpTokens;
    uint256 public lpUsdc;
    mapping(address => bool) public claimedLP;

    uint256 private _lock = 1;

    error BadParams();
    error WrongState(State actual);
    error NotFactory();
    error NotPoolManager();
    error Reentrancy();
    error NothingToDo();
    error IssuerPaused();
    error MultiplierMismatch(uint256 registry, uint256 token);
    error MultiplierChanged(uint256 atStart, uint256 nowValue);
    error CorporateActionWindow(uint256 effectiveAt);
    error TokenPaused();
    error PolicyForbids(bytes32 scope, address account);
    error PriceJumped(uint256 observedBps, uint256 limitBps);
    error LpLocked(uint64 until);
    error TransferFailed();

    event Pledged(address indexed backer, uint256 amount, uint256 total);
    event Withdrawn(address indexed backer, uint256 amount, uint256 total);
    event Funded(uint256 target);
    event AuctionStarted(uint8 auction, uint256 ref, uint64 at);
    event AuctionEnded(uint8 auction, State next);
    event Filled(address indexed filler, uint256 spreadBps, uint256 ref, uint256 tokensIn, uint256 usdcOut, uint128 liquidity);
    event Claimed(address indexed backer, uint256 tokens, uint256 usdc);
    event Refunded(address indexed backer, uint256 amount);
    event LPUnwound(uint256 tokens, uint256 usdc);
    event LPClaimed(address indexed backer, uint256 tokens, uint256 usdc);
    event Realigned(uint256 fromMultiplier, uint256 toMultiplier, uint160 sqrtPriceX96, uint128 liquidity);

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(Deps memory deps_, Params memory params_) {
        if (
            params_.token == address(0) || params_.priceSource == address(0) || params_.target == 0 || params_.deadline <= block.timestamp
                || params_.maxSpreadBps > MAX_SPREAD_CAP_BPS || params_.lpBps == 0 || params_.lpBps > MAX_LP_BPS
                || params_.rampSeconds == 0 || params_.windowSeconds < params_.rampSeconds || params_.maxAuctions == 0
                || params_.maxPythAge == 0 || params_.maxGuardAge == 0 || params_.maxJumpBps == 0
        ) revert BadParams();
        factory = msg.sender;
        d = deps_;
        p = params_;
        tokenDecimals = IERC20Min(params_.token).decimals();
    }

    // ------------------------------------------------------------------ views

    function params() external view returns (Params memory) {
        return p;
    }

    function deps() external view returns (Deps memory) {
        return d;
    }

    /// The state with time-based transitions applied, as the next call would see it.
    function state() public view returns (State) {
        (State s,) = _timed();
        return s;
    }

    /// The spread a fill would get now, in bps.
    function currentSpreadBps() public view returns (uint256) {
        uint256 elapsed = block.timestamp - auctionStart;
        if (elapsed >= p.rampSeconds) return p.maxSpreadBps;
        return uint256(p.maxSpreadBps) * elapsed / p.rampSeconds;
    }

    /// The Uniswap v4 key of this round's pool; registered with the factory at creation.
    function poolKey() public view returns (PoolKey memory key) {
        (Currency c0, Currency c1) = p.token < d.usdc
            ? (Currency.wrap(p.token), Currency.wrap(d.usdc))
            : (Currency.wrap(d.usdc), Currency.wrap(p.token));
        key = PoolKey(c0, c1, SummonPool.FEE, SummonPool.TICK_SPACING, IHooks(d.hook));
    }

    // ------------------------------------------------------------------ Open

    function pledge(uint256 amount) external nonReentrant {
        _sync();
        if (_state != State.Open) revert WrongState(_state);
        uint256 room = p.target - pledged;
        uint256 take = amount < room ? amount : room;
        if (take == 0) revert NothingToDo();
        pledgeOf[msg.sender] += take;
        pledged += take;
        emit Pledged(msg.sender, take, pledged);
        if (pledged == p.target) {
            _state = State.Funded;
            emit Funded(p.target);
        }
        _pull(d.usdc, msg.sender, take);
    }

    function withdraw(uint256 amount) external nonReentrant {
        _sync();
        if (_state != State.Open) revert WrongState(_state);
        if (amount == 0 || amount > pledgeOf[msg.sender]) revert NothingToDo();
        pledgeOf[msg.sender] -= amount;
        pledged -= amount;
        emit Withdrawn(msg.sender, amount, pledged);
        _push(d.usdc, msg.sender, amount);
    }

    // ------------------------------------------------------------------ auction

    /// Anyone may start the auction once the round is funded and every fill condition holds now.
    function startAuction(bytes[] calldata pythUpdate) external payable nonReentrant {
        _sync();
        if (_state != State.Funded) revert WrongState(_state);
        uint256 ref = _checkConditions(pythUpdate);
        auctionStart = uint64(block.timestamp);
        auctionsRun += 1;
        multiplierAtStart = IB20AssetMin(p.token).multiplier();
        latch.rearm(ref);
        _state = State.Auction;
        emit AuctionStarted(auctionsRun, ref, auctionStart);
        _refundEth();
    }

    /// The caller delivers the stock token and receives USDC at the reference price plus the current spread.
    function fill(bytes[] calldata pythUpdate) external payable nonReentrant {
        _sync();
        if (_state != State.Auction) revert WrongState(_state);
        uint256 ref = _checkConditions(pythUpdate);
        uint256 nowMultiplier = IB20AssetMin(p.token).multiplier();
        if (nowMultiplier != multiplierAtStart) revert MultiplierChanged(multiplierAtStart, nowMultiplier);
        (HLPriceGuard.Breach breach, uint256 observed, uint256 limit) = latch.observe(ref, p.maxJumpBps);
        if (breach != HLPriceGuard.Breach.None) revert PriceJumped(observed, limit);
        _requireAuthorized(IB20(p.token).TRANSFER_SENDER_POLICY(), msg.sender);

        uint256 s = currentSpreadBps();
        uint256 usdcLp = pledged * p.lpBps / 1e4;
        uint256 usdcFiller = pledged - usdcLp;
        uint256 q = SummonPrice.tokensFor(usdcFiller, ref, s, tokenDecimals);
        uint256 qLp = SummonPrice.tokensFor(usdcLp, ref, 0, tokenDecimals);
        if (qLp >= q) revert BadParams(); // lpBps <= 5000 and spread <= 1% make this unreachable

        _state = State.Filled;
        filledAt = uint64(block.timestamp);
        filler = msg.sender;
        fillSpreadBps = s;
        fillRef = ref;
        poolMultiplier = nowMultiplier;

        _pull(p.token, msg.sender, q);
        _push(d.usdc, msg.sender, usdcFiller);

        (uint256 tokenUsed, uint256 usdcUsed, uint128 l) = _seed(qLp, usdcLp);
        liquidity = l;
        backerTokens = q - tokenUsed;
        backerUsdcDust = usdcLp - usdcUsed;
        emit Filled(msg.sender, s, ref, q, usdcFiller, l);
        _refundEth();
    }

    /// Ends an auction whose window passed without a fill; the round goes back to Funded or expires.
    function endAuction() external {
        State before = _state;
        _sync();
        if (before != State.Auction || _state == State.Auction) revert NothingToDo();
    }

    // ------------------------------------------------------------------ after

    function claim() external nonReentrant {
        _sync();
        if (_state != State.Filled) revert WrongState(_state);
        uint256 share = pledgeOf[msg.sender];
        if (share == 0 || claimed[msg.sender]) revert NothingToDo();
        claimed[msg.sender] = true;
        uint256 tokens = backerTokens * share / pledged;
        uint256 usdc = backerUsdcDust * share / pledged;
        _requireCanReceive(msg.sender);
        emit Claimed(msg.sender, tokens, usdc);
        _push(p.token, msg.sender, tokens);
        if (usdc != 0) _push(d.usdc, msg.sender, usdc);
    }

    function refund() external nonReentrant {
        _sync();
        if (_state != State.Expired) revert WrongState(_state);
        uint256 amount = pledgeOf[msg.sender];
        if (amount == 0) revert NothingToDo();
        pledgeOf[msg.sender] = 0;
        emit Refunded(msg.sender, amount);
        _push(d.usdc, msg.sender, amount);
    }

    /// Once, after the lock: removes the whole position and records what each backer may claim.
    function unwindLP() external nonReentrant {
        _sync();
        if (_state != State.Filled) revert WrongState(_state);
        if (unwound) revert NothingToDo();
        uint64 until = filledAt + p.lpLockSeconds;
        if (block.timestamp < until) revert LpLocked(until);
        unwound = true;
        (uint256 t, uint256 u) = abi.decode(
            IPoolManager(d.poolManager).unlock(abi.encode(OP_UNWIND, uint256(0), uint256(0))), (uint256, uint256)
        );
        lpTokens = t + idleTokens;
        lpUsdc = u + idleUsdc;
        emit LPUnwound(t, u);
    }

    /// §5.5a: after a corporate action, re-prices the backers' pool by the multiplier's change, so the first
    /// trader cannot take the difference. Anyone may call it once the action window has passed.
    function realign() external nonReentrant {
        _sync();
        if (_state != State.Filled) revert WrongState(_state);
        if (unwound) revert NothingToDo();
        uint256 m = IB20AssetMin(p.token).multiplier();
        uint256 from = poolMultiplier;
        if (m == from) revert NothingToDo();
        uint256 eff = IB20AssetMin(p.token).effectiveAt();
        if (_inActionWindow(eff)) revert CorporateActionWindow(eff);
        if (d.oracleRegistry != address(0)) {
            (uint256 rm,) = IOracleParams(d.oracleRegistry).getOracleParams(p.token);
            if (rm != m) revert MultiplierMismatch(rm, m);
        }
        (uint256 t, uint256 u, uint128 l, uint160 sqrtP) = abi.decode(
            IPoolManager(d.poolManager).unlock(abi.encode(OP_REALIGN, m, from)), (uint256, uint256, uint128, uint160)
        );
        idleTokens += t;
        idleUsdc += u;
        liquidity = l;
        poolMultiplier = m;
        emit Realigned(from, m, sqrtP, l);
    }

    function claimLP() external nonReentrant {
        if (!unwound) revert NothingToDo();
        uint256 share = pledgeOf[msg.sender];
        if (share == 0 || claimedLP[msg.sender]) revert NothingToDo();
        claimedLP[msg.sender] = true;
        uint256 t = lpTokens * share / pledged;
        uint256 u = lpUsdc * share / pledged;
        _requireCanReceive(msg.sender);
        emit LPClaimed(msg.sender, t, u);
        if (t != 0) _push(p.token, msg.sender, t);
        if (u != 0) _push(d.usdc, msg.sender, u);
    }

    // ------------------------------------------------------------------ pool

    /// `data` is (op, a, b): seed (a = token, b = USDC), unwind, or realign (a = new multiplier, b = old).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != d.poolManager) revert NotPoolManager();
        (uint8 op, uint256 a, uint256 b) = abi.decode(data, (uint8, uint256, uint256));
        IPoolManager pm = IPoolManager(d.poolManager);
        PoolKey memory key = poolKey();
        bool tokenIs0 = p.token < d.usdc;
        if (op == OP_SEED) {
            uint160 sqrtP = tokenIs0 ? SummonPool.sqrtPriceX96(a, b) : SummonPool.sqrtPriceX96(b, a);
            pm.initialize(key, sqrtP);
            (uint256 tokenUsed, uint256 usdcUsed, uint128 l) = _addFullRange(pm, key, sqrtP, a, b);
            return abi.encode(tokenUsed, usdcUsed, l);
        }
        (uint256 t, uint256 u) = _removeAll(pm, key);
        if (op == OP_UNWIND) return abi.encode(t, u);
        // realign: the pool is empty now, so a swap moves its price and moves no tokens. The price is
        // currency1 per currency0, so it scales by new/old multiplier when the token is currency0.
        (uint160 sqrtNow,,,) = pm.getSlot0(key.toId());
        uint160 target = tokenIs0 ? SummonPool.scaledSqrtPrice(sqrtNow, a, b) : SummonPool.scaledSqrtPrice(sqrtNow, b, a);
        if (target != sqrtNow) {
            pm.swap(key, IPoolManager.SwapParams({zeroForOne: target < sqrtNow, amountSpecified: -1, sqrtPriceLimitX96: target}), "");
        }
        (uint256 tUsed, uint256 uUsed, uint128 l2) = _addFullRange(pm, key, target, t, u);
        return abi.encode(t - tUsed, u - uUsed, l2, target);
    }

    function _addFullRange(IPoolManager pm, PoolKey memory key, uint160 sqrtP, uint256 tokenAmt, uint256 usdcAmt)
        internal
        returns (uint256 tokenUsed, uint256 usdcUsed, uint128 l)
    {
        bool tokenIs0 = p.token < d.usdc;
        (uint256 a0, uint256 a1) = tokenIs0 ? (tokenAmt, usdcAmt) : (usdcAmt, tokenAmt);
        l = SummonPool.fullRangeLiquidity(sqrtP, a0, a1);
        (BalanceDelta delta,) = pm.modifyLiquidity(
            key, IPoolManager.ModifyLiquidityParams(SummonPool.tickLower(), SummonPool.tickUpper(), int256(uint256(l)), 0), ""
        );
        uint256 paid0 = _settleOwed(pm, key.currency0, delta.amount0());
        uint256 paid1 = _settleOwed(pm, key.currency1, delta.amount1());
        (tokenUsed, usdcUsed) = tokenIs0 ? (paid0, paid1) : (paid1, paid0);
    }

    /// Removes the whole position, fees included, into the round; returns (tokens, USDC).
    function _removeAll(IPoolManager pm, PoolKey memory key) internal returns (uint256, uint256) {
        (BalanceDelta delta,) = pm.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams(SummonPool.tickLower(), SummonPool.tickUpper(), -int256(uint256(liquidity)), 0),
            ""
        );
        uint256 got0 = _takeOwed(pm, key.currency0, delta.amount0());
        uint256 got1 = _takeOwed(pm, key.currency1, delta.amount1());
        return p.token < d.usdc ? (got0, got1) : (got1, got0);
    }

    function _seed(uint256 tokenAmt, uint256 usdcAmt) internal returns (uint256, uint256, uint128) {
        bytes memory r = IPoolManager(d.poolManager).unlock(abi.encode(OP_SEED, tokenAmt, usdcAmt));
        return abi.decode(r, (uint256, uint256, uint128));
    }

    function _settleOwed(IPoolManager pm, Currency c, int128 amount) internal returns (uint256 paid) {
        if (amount >= 0) return 0;
        paid = uint256(uint128(-amount));
        pm.sync(c);
        _push(Currency.unwrap(c), address(pm), paid);
        pm.settle();
    }

    function _takeOwed(IPoolManager pm, Currency c, int128 amount) internal returns (uint256 got) {
        if (amount <= 0) return 0;
        got = uint256(uint128(amount));
        pm.take(c, address(this), got);
    }

    // ------------------------------------------------------------------ conditions (spec 5.2)

    function _checkConditions(bytes[] calldata pythUpdate) internal returns (uint256 ref) {
        // 2. market state, fail closed
        MarketStateCheck.requireOpen(MarketStateRegistry(d.marketState), p.token, p.maxGuardAge);
        // 3. a fresh Pyth price with a narrow confidence interval (stops publishing outside the session)
        HLPriceGuard.Ref memory r = PythRef.updateAndReadFresh(IPyth(p.priceSource), pythUpdate, p.priceId, p.maxPythAge, p.maxConfBps);
        uint256 m = IB20AssetMin(p.token).multiplier();
        ref = SummonPrice.refPerToken(r.price, m);
        // 4. issuer registry: not paused, and its multiplier agrees with the token's
        if (d.oracleRegistry != address(0)) {
            (uint256 rm, bool paused) = IOracleParams(d.oracleRegistry).getOracleParams(p.token);
            if (paused) revert IssuerPaused();
            if (rm != m) revert MultiplierMismatch(rm, m);
        }
        // 5. no scheduled multiplier change near now
        uint256 eff = IB20AssetMin(p.token).effectiveAt();
        if (_inActionWindow(eff)) revert CorporateActionWindow(eff);
        // 6. transfers not paused; an unreadable answer counts as paused
        try IB20(p.token).isPaused(IB20.PausableFeature.TRANSFER) returns (bool isP) {
            if (isP) revert TokenPaused();
        } catch {
            revert TokenPaused();
        }
        // 7. the round and the PoolManager may send, receive and execute transfers
        bytes32 sender = IB20(p.token).TRANSFER_SENDER_POLICY();
        bytes32 receiver = IB20(p.token).TRANSFER_RECEIVER_POLICY();
        bytes32 executor = IB20(p.token).TRANSFER_EXECUTOR_POLICY();
        _requireAuthorized(sender, address(this));
        _requireAuthorized(receiver, address(this));
        _requireAuthorized(executor, address(this));
        _requireAuthorized(sender, d.poolManager);
        _requireAuthorized(receiver, d.poolManager);
        _requireAuthorized(executor, d.poolManager);
    }

    function _inActionWindow(uint256 eff) internal view returns (bool) {
        return eff != 0 && block.timestamp + p.cooldownSeconds >= eff && block.timestamp <= eff + p.cooldownSeconds;
    }

    function _requireCanReceive(address account) internal view {
        _requireAuthorized(IB20(p.token).TRANSFER_RECEIVER_POLICY(), account);
    }

    function _requireAuthorized(bytes32 scope, address account) internal view {
        uint64 id = IB20(p.token).policyId(scope);
        IPolicyRegistry reg = IPolicyRegistry(d.policyRegistry);
        if (!reg.policyExists(id) || !reg.isAuthorized(id, account)) revert PolicyForbids(scope, account);
    }

    // ------------------------------------------------------------------ time

    function _timed() internal view returns (State s, uint8 runs) {
        s = _state;
        runs = auctionsRun;
        if ((s == State.Open || s == State.Funded) && block.timestamp > p.deadline) return (State.Expired, runs);
        if (s == State.Auction && block.timestamp > uint256(auctionStart) + p.windowSeconds) {
            if (runs >= p.maxAuctions || block.timestamp > p.deadline) return (State.Expired, runs);
            return (State.Funded, runs);
        }
    }

    function _sync() internal {
        State before = _state;
        (State s,) = _timed();
        if (s != before) {
            _state = s;
            if (before == State.Auction) emit AuctionEnded(auctionsRun, s);
        }
    }

    // ------------------------------------------------------------------ transfers

    function _pull(address token, address from, uint256 amount) internal {
        if (!IERC20Min(token).transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) internal {
        if (!IERC20Min(token).transfer(to, amount)) revert TransferFailed();
    }

    function _refundEth() internal {
        uint256 bal = address(this).balance;
        if (bal != 0) {
            (bool ok,) = msg.sender.call{value: bal}("");
            if (!ok) revert TransferFailed();
        }
    }
}
