// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {MarketStateRegistry} from "market-state/MarketStateRegistry.sol";
import {MarketStateCheck} from "market-state/MarketStateCheck.sol";
import {PythRef} from "hl-price-guard/PythRef.sol";
import {SummonFactory} from "../src/SummonFactory.sol";
import {SummonRound} from "../src/SummonRound.sol";
import {SummonHook, ISummonRegistry} from "../src/SummonHook.sol";
import {SummonPrice} from "../src/SummonPrice.sol";
import {SummonPool} from "../src/SummonPool.sol";
import {SummonSwap, ISummonPools} from "../src/SummonSwap.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20, MockB20, MockB20Of, MockPolicyRegistry, MockOracleRegistry} from "./mocks/Mocks.sol";
import {GuardPriceFeed} from "../src/testnet/GuardPriceFeed.sol";

/// MockPyth with Pyth's parsePriceFeedUpdatesUnique. Each update is abi.encode(int64 price, uint64 conf,
/// uint64 publishTime, uint64 prevPublishTime); it returns the first with prev < min <= publishTime <= max.
contract UniqueMockPyth is MockPyth {
    int32 internal immutable expo;

    constructor(int32 expo_) MockPyth(60, 1) {
        expo = expo_;
    }

    function parsePriceFeedUpdatesUnique(bytes[] calldata updateData, bytes32[] calldata ids, uint64 min, uint64 max)
        external
        payable
        returns (PythStructs.PriceFeed[] memory f)
    {
        require(msg.value >= getUpdateFee(updateData), "fee");
        f = new PythStructs.PriceFeed[](1);
        for (uint256 i; i < updateData.length; i++) {
            (int64 px, uint64 conf, uint64 t, uint64 prev) = abi.decode(updateData[i], (int64, uint64, uint64, uint64));
            if (prev < min && min <= t && t <= max) {
                f[0].id = ids[0];
                f[0].price = PythStructs.Price(px, conf, expo, t);
                return f;
            }
        }
        revert("PriceFeedNotFoundWithinRange");
    }
}

contract SummonRoundTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    // Time is read with vm.getBlockTimestamp(): under via_ir (foundry.toml) block.timestamp can keep its
    // value from before a vm.warp in the same test.

    uint256 constant MAX_TARGET = 1e15; // SummonFactory.MAX_TARGET

    bytes32 constant GME = keccak256("Equity.US.GME/USD");
    int64 constant PX = 2_345_000; // $23.45
    int32 constant EXPO = -5;
    uint64 constant CONF = 1_000; // $0.01, about 4 bp

    PoolManager pm;
    MockPyth pyth;
    MockPolicyRegistry policies;
    MockB20 token;
    MockERC20 usdc;
    MockOracleRegistry oracle;
    MarketStateRegistry market;
    SummonHook hook;
    SummonFactory factory;
    SummonRound round;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);
    address ap = address(0xA9); // the filler, playing the issuer's authorized participant

    function setUp() public {
        vm.warp(1_800_000_000);
        pm = new PoolManager(address(this));
        pyth = new MockPyth(60, 1);
        policies = new MockPolicyRegistry();
        token = new MockB20(policies);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        oracle = new MockOracleRegistry();
        market = new MarketStateRegistry(address(this));
        market.setUpdater(address(this), true);
        market.setState(address(token), false, 0, 0);

        // the hook must sit at an address whose low 14 bits are its flags: BEFORE_INITIALIZE, BEFORE_ADD_LIQUIDITY
        // and BEFORE_SWAP
        address hookAddr = address((uint160(0x5) << 152) | uint160((1 << 13) | (1 << 11) | (1 << 7)));
        deployCodeTo("SummonHook.sol:SummonHook", abi.encode(address(pm), address(this)), hookAddr);
        hook = SummonHook(hookAddr);

        factory = new SummonFactory(
            address(this),
            SummonRound.Deps({
                usdc: address(usdc),
                policyRegistry: address(policies),
                marketState: address(market),
                oracleRegistry: address(oracle),
                poolManager: address(pm),
                hook: hookAddr
            }),
            SummonFactory.Defaults({
                lpBps: 2000,
                rampSeconds: 1800,
                windowSeconds: 3600,
                maxAuctions: 3,
                maxGuardAge: 300,
                maxConfBps: 50,
                maxJumpBps: 300,
                cooldownSeconds: 3600
            })
        );
        hook.setFactory(ISummonRegistry(address(factory)));
        factory.list(address(token), address(pyth), GME, 60, false);
        round = factory.openRound(address(token), 10_000e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);

        for (uint256 i; i < 3; ++i) {
            address b = [alice, bob, carol][i];
            usdc.mint(b, 10_000e6);
            vm.prank(b);
            usdc.approve(address(round), type(uint256).max);
        }
        token.mint(ap, 1_000e8);
        vm.prank(ap);
        token.approve(address(round), type(uint256).max);
        vm.deal(ap, 1 ether);
        vm.deal(address(this), 1 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _update(int64 px, uint64 conf, uint64 at) internal view returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = pyth.createPriceFeedUpdateData(GME, px, conf, EXPO, px, conf, at);
    }

    function _fresh() internal view returns (bytes[] memory) {
        return _update(PX, CONF, uint64(vm.getBlockTimestamp()));
    }

    function _fund() internal {
        vm.prank(alice);
        round.pledge(5_000e6);
        vm.prank(bob);
        round.pledge(3_000e6);
        vm.prank(carol);
        round.pledge(2_000e6);
        assertEq(uint8(round.state()), uint8(SummonRound.State.Funded));
    }

    function _start() internal {
        _fund();
        round.startAuction{value: 1}(_fresh());
        assertEq(uint8(round.state()), uint8(SummonRound.State.Auction));
    }

    function _heartbeat() internal {
        address[] memory t = new address[](1);
        t[0] = address(token);
        market.heartbeat(t);
    }

    function _fillAfter(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
        _heartbeat();
        bytes[] memory u = _fresh();
        vm.prank(ap);
        round.fill{value: 1}(u);
    }

    function _expectFillRevert(bytes memory err) internal {
        vm.warp(vm.getBlockTimestamp() + 1); // a fill's price must be published after the auction started
        bytes[] memory u = _fresh();
        vm.prank(ap);
        vm.expectRevert(err);
        round.fill{value: 1}(u);
    }

    // ------------------------------------------------------------------ A1, locally

    function test_fullFlow() public {
        _start();
        uint256 apUsdc0 = usdc.balanceOf(ap);
        uint256 apTok0 = token.balanceOf(ap);
        _fillAfter(900); // halfway up the ramp: 50 bp

        assertEq(round.fillSpreadBps(), 50);
        uint256 ref = round.fillRef();
        assertEq(ref, 23.45e18);
        // the filler is paid for 80% of the round and delivers tokens worth that at ref × 1.005
        uint256 paid = usdc.balanceOf(ap) - apUsdc0;
        uint256 delivered = apTok0 - token.balanceOf(ap);
        assertEq(paid, 8_000e6);
        assertEq(delivered, SummonPrice.tokensFor(8_000e6, ref, 50, 8));
        // F2: tokens delivered are worth at least what the filler was paid, within one raw unit
        uint256 worth = SummonPrice.usdcFor(delivered, ref, 50, 8);
        assertGe(worth, paid);
        assertLe(worth, paid + SummonPrice.usdcFor(1, ref, 50, 8) + 1);

        // the pool exists, at the reference price, with liquidity owned by the round
        PoolKey memory key = round.poolKey();
        (uint160 sqrtP,,,) = IPoolManager(address(pm)).getSlot0(key.toId());
        uint256 qLp = SummonPrice.tokensFor(2_000e6, ref, 0, 8);
        (uint256 a0, uint256 a1) = address(token) < address(usdc) ? (qLp, uint256(2_000e6)) : (uint256(2_000e6), qLp);
        assertEq(sqrtP, SummonPool.sqrtPriceX96(a0, a1), "pool did not open at the reference price");
        assertGt(round.liquidity(), 0);
        // F1: the round holds at least what it owes backers
        assertGe(token.balanceOf(address(this)) + token.balanceOf(address(round)), round.backerTokens());
        assertLe(round.backerUsdcDust(), 2, "seed USDC left over beyond rounding");

        // claims, pro rata to pledges
        uint256 total;
        for (uint256 i; i < 3; ++i) {
            address b = [alice, bob, carol][i];
            vm.prank(b);
            round.claim();
            total += token.balanceOf(b);
        }
        assertEq(token.balanceOf(alice), round.backerTokens() * 5 / 10);
        assertLe(total, round.backerTokens());
        assertGe(total + 3, round.backerTokens());
        vm.prank(alice);
        vm.expectRevert(SummonRound.NothingToDo.selector);
        round.claim();

        // LP: locked for 7 days, then unwound once and claimed pro rata
        vm.expectRevert();
        round.unwindLP();
        vm.warp(vm.getBlockTimestamp() + 7 days);
        round.unwindLP();
        assertGt(round.lpTokens(), 0);
        assertGt(round.lpUsdc(), 0);
        uint256 lpUsdcBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        round.claimLP();
        assertEq(usdc.balanceOf(bob) - lpUsdcBefore, round.lpUsdc() * 3 / 10);
        vm.expectRevert(SummonRound.NothingToDo.selector);
        round.unwindLP();
    }

    function test_spreadRamp() public {
        _start();
        assertEq(round.currentSpreadBps(), 0);
        vm.warp(vm.getBlockTimestamp() + 450);
        assertEq(round.currentSpreadBps(), 25);
        vm.warp(vm.getBlockTimestamp() + 1350);
        assertEq(round.currentSpreadBps(), 100);
        vm.warp(vm.getBlockTimestamp() + 1000);
        assertEq(round.currentSpreadBps(), 100); // capped after the ramp
    }

    // ------------------------------------------------------------------ A5

    function test_pledgeCapsAtTarget() public {
        vm.prank(alice);
        round.pledge(9_000e6);
        vm.prank(bob);
        round.pledge(5_000e6); // only 1,000 fits
        assertEq(round.pledgeOf(bob), 1_000e6);
        assertEq(usdc.balanceOf(bob), 9_000e6);
        assertEq(uint8(round.state()), uint8(SummonRound.State.Funded));
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.WrongState.selector, SummonRound.State.Funded));
        round.pledge(1);
    }

    function test_withdrawWhileOpenOnly() public {
        vm.prank(alice);
        round.pledge(4_000e6);
        vm.prank(alice);
        round.withdraw(1_000e6);
        assertEq(round.pledged(), 3_000e6);
        vm.prank(bob);
        round.pledge(7_000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.WrongState.selector, SummonRound.State.Funded));
        round.withdraw(1);
        round.startAuction{value: 1}(_fresh());
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.WrongState.selector, SummonRound.State.Auction));
        round.withdraw(1);
    }

    // ------------------------------------------------------------------ A2: each condition alone

    function test_cannotStartWhileOpen() public {
        bytes[] memory u = _fresh();
        vm.expectRevert(abi.encodeWithSelector(SummonRound.WrongState.selector, SummonRound.State.Open));
        round.startAuction{value: 1}(u);
    }

    function test_haltedMarket() public {
        _start();
        market.setState(address(token), true, 1, 0);
        _expectFillRevert(abi.encodeWithSelector(MarketStateCheck.MarketHalted.selector, uint8(1)));
    }

    function test_quietGuard() public {
        _start();
        vm.warp(vm.getBlockTimestamp() + 301);
        _expectFillRevert(abi.encodeWithSelector(MarketStateCheck.MarketStateStale.selector, uint64(vm.getBlockTimestamp() - 301)));
    }

    function test_beforeResume() public {
        _start();
        uint64 resume = uint64(vm.getBlockTimestamp() + 600);
        market.setState(address(token), false, 0, resume);
        _expectFillRevert(abi.encodeWithSelector(MarketStateCheck.NotYetResumed.selector, resume));
    }

    /// Pyth keeps the newest price, so an older update cannot make it stale; time passing does.
    function test_stalePythPrice() public {
        _start();
        vm.warp(vm.getBlockTimestamp() + 61);
        _heartbeat();
        bytes[] memory none = new bytes[](0);
        vm.prank(ap);
        vm.expectRevert(abi.encodeWithSelector(PythRef.PythStale.selector, GME, 61, 60));
        round.fill(none);
    }

    function test_wideConfidence() public {
        _start();
        vm.warp(vm.getBlockTimestamp() + 1);
        bytes[] memory wide = _update(PX, 23_450, uint64(vm.getBlockTimestamp())); // 100 bp
        vm.prank(ap);
        vm.expectRevert(abi.encodeWithSelector(PythRef.PythConfTooWide.selector, GME, 100, 50));
        round.fill{value: 1}(wide);
    }

    function test_issuerPaused() public {
        _start();
        oracle.set(1e18, true);
        _expectFillRevert(abi.encodeWithSelector(SummonRound.IssuerPaused.selector));
    }

    function test_registryMultiplierMismatch() public {
        _start();
        oracle.set(1.02e18, false);
        _expectFillRevert(abi.encodeWithSelector(SummonRound.MultiplierMismatch.selector, 1.02e18, 1e18));
    }

    function test_corporateActionWindow() public {
        _start();
        uint256 eff = vm.getBlockTimestamp() + 1800;
        token.setEffectiveAt(eff);
        _expectFillRevert(abi.encodeWithSelector(SummonRound.CorporateActionWindow.selector, eff));
        // far enough away, the same scheduled change does not block
        token.setEffectiveAt(vm.getBlockTimestamp() + 2 days);
        _fillAfter(0);
    }

    function test_multiplierChangedSinceStart() public {
        _start();
        token.setMultiplier(1.02e18);
        oracle.set(1.02e18, false); // the registry agrees, but the auction started at 1.0
        _expectFillRevert(abi.encodeWithSelector(SummonRound.MultiplierChanged.selector, 1e18, 1.02e18));
    }

    function test_tokenPaused() public {
        _start();
        token.setTransferPaused(true);
        _expectFillRevert(abi.encodeWithSelector(SummonRound.TokenPaused.selector));
    }

    function test_unreadablePauseCountsAsPaused() public {
        _start();
        token.setPauseReadReverts(true);
        _expectFillRevert(abi.encodeWithSelector(SummonRound.TokenPaused.selector));
    }

    function test_policyForbidsRound() public {
        _start();
        policies.create(7);
        policies.setAllowed(7, address(pm), true);
        token.setPolicy(token.TRANSFER_RECEIVER_POLICY(), 7);
        _expectFillRevert(abi.encodeWithSelector(SummonRound.PolicyForbids.selector, token.TRANSFER_RECEIVER_POLICY(), address(round)));
    }

    function test_policyForbidsPoolManager() public {
        _start();
        policies.create(7);
        policies.setAllowed(7, address(round), true);
        token.setPolicy(token.TRANSFER_EXECUTOR_POLICY(), 7);
        _expectFillRevert(abi.encodeWithSelector(SummonRound.PolicyForbids.selector, token.TRANSFER_EXECUTOR_POLICY(), address(pm)));
    }

    function test_policyForbidsFiller() public {
        _start();
        policies.create(7);
        policies.setAllowed(7, address(round), true);
        policies.setAllowed(7, address(pm), true);
        token.setPolicy(token.TRANSFER_SENDER_POLICY(), 7);
        _expectFillRevert(abi.encodeWithSelector(SummonRound.PolicyForbids.selector, token.TRANSFER_SENDER_POLICY(), ap));
    }

    function test_unknownPolicyIdCountsAsForbidden() public {
        _start();
        token.setPolicy(token.TRANSFER_RECEIVER_POLICY(), 99); // never created
        _expectFillRevert(abi.encodeWithSelector(SummonRound.PolicyForbids.selector, token.TRANSFER_RECEIVER_POLICY(), address(round)));
    }

    function test_priceJumpSinceStart() public {
        _start();
        vm.warp(vm.getBlockTimestamp() + 60);
        _heartbeat();
        bytes[] memory jumped = _update(PX * 104 / 100, CONF, uint64(vm.getBlockTimestamp())); // +4% > 3%
        vm.prank(ap);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.PriceJumped.selector, 400, 300));
        round.fill{value: 1}(jumped);
    }

    // ------------------------------------------------------------------ A6: expiry and refunds

    /// Codex r1 #1: start on a favorable print up to maxPythAge old, then settle on that same print.
    function test_fillNeedsAPriceFromAfterTheStart() public {
        _fund();
        vm.warp(vm.getBlockTimestamp() + 100);
        _heartbeat();
        // a $103 spike published 55 s ago anchors the auction...
        int64 spike = PX * 103 / 100;
        round.startAuction{value: 1}(_update(spike, CONF, uint64(vm.getBlockTimestamp() - 55)));
        // ...and filling on that same print now is refused
        vm.prank(ap);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.PriceNotAfterStart.selector, vm.getBlockTimestamp() - 55, vm.getBlockTimestamp()));
        round.fill{value: 1}(new bytes[](0));
        // a print published after the start fills, at that price
        vm.warp(vm.getBlockTimestamp() + 5);
        bytes[] memory u = _update(PX, CONF, uint64(vm.getBlockTimestamp()));
        vm.prank(ap);
        round.fill{value: 1}(u);
        assertEq(round.fillRef(), SummonPrice.refPerToken(uint256(uint64(PX)) * 10 ** uint256(int256(18 + EXPO)), 1e18));
    }

    /// Codex r2 #8: nobody can hold a ticker's only round open for good.
    function test_roundsCannotSquatATicker() public {
        MockB20 t3 = new MockB20(policies);
        factory.list(address(t3), address(pyth), GME, 60, false);
        vm.expectRevert(SummonFactory.BadRoundTerms.selector);
        factory.openRound(address(t3), 10_000e6, uint64(vm.getBlockTimestamp() + 31 days), 100, 7 days);
        vm.expectRevert(SummonFactory.BadRoundTerms.selector);
        factory.openRound(address(t3), 10_000e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 31 days);
        // a squatter's round with a target nobody will meet...
        vm.prank(carol);
        SummonRound squat = factory.openRound(address(t3), MAX_TARGET, uint64(vm.getBlockTimestamp() + 30 days), 100, 30 days);
        // ...blocks a new one for a day, then anyone may replace it while nobody has pledged
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.RoundActive.selector, address(squat)));
        factory.openRound(address(t3), 10_000e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        SummonRound fair = factory.openRound(address(t3), 10_000e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);
        assertEq(factory.latestRound(address(t3)), address(fair));
        // the replaced round is cancelled in the same transaction: no pledge can land in it any more
        vm.startPrank(alice);
        usdc.approve(address(squat), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.WrongState.selector, SummonRound.State.Expired));
        squat.pledge(1e6);
        vm.stopPrank();

        // Codex r3 #1: a dust pledge does not hold a ticker; whoever pledged it gets it back
        vm.startPrank(carol);
        usdc.approve(address(fair), type(uint256).max);
        fair.pledge(1);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        SummonRound next = factory.openRound(address(t3), 10_000e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);
        assertEq(uint8(fair.state()), uint8(SummonRound.State.Expired));
        vm.prank(carol);
        fair.refund();

        // a round on pace (10% a day into a 7-day round; pace needs half of 1/7) is not replaced
        vm.startPrank(alice);
        usdc.approve(address(next), type(uint256).max);
        next.pledge(1_000e6);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.RoundActive.selector, address(next)));
        factory.openRound(address(t3), 10_000e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);
    }

    /// Codex r4 #2, r5 #1: a round keeping pace is never cancelled, however small its pledges; a squatter
    /// topping up 0.1% a day falls behind and is replaced, and so is the next round it opens.
    function test_aRoundMustKeepPaceToHoldItsTicker() public {
        MockB20 t3 = new MockB20(policies);
        factory.list(address(t3), address(pyth), GME, 60, false);
        // a healthy 7-day round, with many small pledges adding up to 750 tUSDC a day (pace needs 714)
        SummonRound r = factory.openRound(address(t3), 10_000e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);
        vm.prank(alice);
        usdc.approve(address(r), type(uint256).max);
        for (uint256 day; day < 3; ++day) {
            for (uint256 i; i < 75; ++i) {
                vm.prank(alice);
                r.pledge(10e6);
            }
            vm.warp(vm.getBlockTimestamp() + 1 days);
            vm.expectRevert(abi.encodeWithSelector(SummonFactory.RoundActive.selector, address(r)));
            factory.openRound(address(t3), MAX_TARGET, uint64(vm.getBlockTimestamp() + 30 days), 100, 30 days);
        }
        // it stalls: by day 5 pace needs 3,571 and it has 2,250
        vm.warp(vm.getBlockTimestamp() + 2 days);
        SummonRound squat = factory.openRound(address(t3), 10_000e6, uint64(vm.getBlockTimestamp() + 30 days), 100, 30 days);
        assertEq(uint8(r.state()), uint8(SummonRound.State.Expired));

        // the squatter tops up 0.1% (10 tUSDC) a day; a day in, pace needs 166
        vm.startPrank(carol);
        usdc.approve(address(squat), type(uint256).max);
        squat.pledge(10e6);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        squat.pledge(10e6);
        vm.stopPrank();
        SummonRound fair = factory.openRound(address(t3), 10_000e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);
        assertEq(uint8(squat.state()), uint8(SummonRound.State.Expired));
        assertEq(factory.latestRound(address(t3)), address(fair));
        vm.prank(carol);
        squat.refund();
    }

    function _print(int64 px, uint64 t, uint64 prev) internal pure returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = abi.encode(px, CONF, t, prev);
    }

    /// Codex r2 #1, r3 #2: where the filler supplies Pyth's update, a start or fill settles on the first print
    /// at or after settleTime(), which the block sets; a later, more favorable print is refused.
    function test_pullFeedSettlesOnTheFirstPrintAfterASetTime() public {
        UniqueMockPyth up = new UniqueMockPyth(EXPO);
        MockB20 t3 = new MockB20(policies);
        market.setState(address(t3), false, 0, 0);
        factory.list(address(t3), address(up), GME, 10, true);
        SummonRound r = factory.openRound(address(t3), 10_000e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);
        for (uint256 i; i < 3; ++i) {
            address b = [alice, bob, carol][i];
            vm.startPrank(b);
            usdc.approve(address(r), type(uint256).max);
            r.pledge([5_000e6, 3_000e6, 2_000e6][i]);
            vm.stopPrank();
        }
        t3.mint(ap, 1_000e8);
        vm.prank(ap);
        t3.approve(address(r), type(uint256).max);
        vm.warp(vm.getBlockTimestamp() + 3); // 1_800_000_003: settles on the first print at or after 1_799_999_990
        uint64 t = r.settleTime();
        assertEq(t, 1_799_999_990);
        r.startAuction{value: 1}(_print(PX, t + 1, t - 1));

        vm.warp(vm.getBlockTimestamp() + 130);
        _heartbeat();
        market.heartbeat(_one(address(t3)));
        t = r.settleTime();
        // a print 4 s into the window, $1 higher, but not the first one in it: the filler is choosing
        vm.prank(ap);
        vm.expectRevert(bytes("PriceFeedNotFoundWithinRange"));
        r.fill{value: 1}(_print(PX + 1e5, t + 4, t + 1));
        // the first print of an earlier window
        vm.prank(ap);
        vm.expectRevert(bytes("PriceFeedNotFoundWithinRange"));
        r.fill{value: 1}(_print(PX, t - 9, t - 11));
        // a quiet band (Codex r4 #1): Pyth printed nothing from t to t + 10, so this block has no price...
        vm.prank(ap);
        vm.expectRevert(bytes("PriceFeedNotFoundWithinRange"));
        r.fill{value: 1}(_print(PX, t + 12, t - 1));
        // ...and the next band's first print (t + 12) fills once the block reaches that band
        vm.warp(vm.getBlockTimestamp() + 10);
        _heartbeat();
        market.heartbeat(_one(address(t3)));
        assertEq(r.settleTime(), t + 10);
        vm.prank(ap);
        r.fill{value: 1}(_print(PX, t + 12, t - 1));
        assertEq(uint8(r.state()), uint8(SummonRound.State.Filled));
        assertEq(r.fillRef(), SummonPrice.refPerToken(uint256(uint64(PX)) * 10 ** uint256(int256(18 + EXPO)), 1e18));
    }

    /// Codex r3 #4: an issuer pause stops swaps, as it stops fills.
    function test_swapStopsWhileTheIssuerPauses() public {
        (SummonSwap router, PoolKey memory key, bool usdcIs0) = _summoned();
        oracle.set(1e18, true);
        vm.prank(alice);
        vm.expectRevert(); // the PoolManager wraps the hook's IssuerPaused
        router.swapExactIn(key, usdcIs0, 100e6, 1, alice);
        oracle.set(1e18, false);
        assertGt(_buy(router, key, usdcIs0), 0);
    }

    function _one(address a) internal pure returns (address[] memory x) {
        x = new address[](1);
        x[0] = a;
    }

    function test_expiresAtDeadline() public {
        vm.prank(alice);
        round.pledge(3_000e6);
        vm.prank(bob);
        round.pledge(2_000e6);
        vm.warp(vm.getBlockTimestamp() + 7 days + 1);
        assertEq(uint8(round.state()), uint8(SummonRound.State.Expired));
        vm.prank(alice);
        round.refund();
        vm.prank(bob);
        round.refund();
        assertEq(usdc.balanceOf(alice), 10_000e6);
        assertEq(usdc.balanceOf(bob), 10_000e6);
        assertEq(usdc.balanceOf(address(round)), 0);
        vm.prank(alice);
        vm.expectRevert(SummonRound.NothingToDo.selector);
        round.refund();
    }

    function test_expiresAfterThreeAuctions() public {
        _fund();
        for (uint256 i; i < 3; ++i) {
            _heartbeat();
            round.startAuction{value: 1}(_fresh());
            vm.warp(vm.getBlockTimestamp() + 3601);
            round.endAuction();
            if (i < 2) assertEq(uint8(round.state()), uint8(SummonRound.State.Funded));
        }
        assertEq(uint8(round.state()), uint8(SummonRound.State.Expired));
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            address b = [alice, bob, carol][i];
            uint256 before = usdc.balanceOf(b);
            vm.prank(b);
            round.refund();
            sum += usdc.balanceOf(b) - before;
        }
        assertEq(sum, 10_000e6);
    }

    function test_noFillAfterWindow() public {
        _start();
        vm.warp(vm.getBlockTimestamp() + 3601);
        _heartbeat();
        _expectFillRevert(abi.encodeWithSelector(SummonRound.WrongState.selector, SummonRound.State.Funded));
    }

    // ------------------------------------------------------------------ A7 and the factory

    function test_onlyTheRoundInitializesItsPool() public {
        PoolKey memory key = round.poolKey();
        vm.expectRevert(); // the PoolManager wraps the hook's NotTheRound
        pm.initialize(key, 79228162514264337593543950336);
    }

    function test_hookRejectsDirectCalls() public {
        PoolKey memory key = round.poolKey();
        vm.expectRevert(SummonHook.NotPoolManager.selector);
        hook.beforeInitialize(address(round), key, 0);
    }

    function test_factoryRules() public {
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.NotListed.selector, address(usdc)));
        factory.openRound(address(usdc), 10e6, uint64(vm.getBlockTimestamp() + 1 days), 100, 1 days);
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.RoundActive.selector, address(round)));
        factory.openRound(address(token), 10e6, uint64(vm.getBlockTimestamp() + 1 days), 100, 1 days);
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.AlreadyListed.selector, address(token)));
        factory.list(address(token), address(pyth), bytes32(uint256(1)), 60, false);
        vm.prank(alice);
        vm.expectRevert(SummonFactory.NotOwner.selector);
        factory.list(address(usdc), address(pyth), bytes32(uint256(1)), 60, false);
        // spread above 1% is refused
        vm.warp(vm.getBlockTimestamp() + 8 days);
        vm.expectRevert(SummonRound.BadParams.selector);
        factory.openRound(address(token), 10e6, uint64(vm.getBlockTimestamp() + 1 days), 101, 1 days);
        // after expiry a new round may open; after a fill it may not
        SummonRound r2 = factory.openRound(address(token), 10e6, uint64(vm.getBlockTimestamp() + 1 days), 100, 1 days);
        assertTrue(address(r2) != address(round));
    }

    function test_minTarget() public {
        assertEq(factory.minTarget(), 0); // testnet: no minimum
        vm.prank(alice);
        vm.expectRevert(SummonFactory.NotOwner.selector);
        factory.setMinTarget(1_000e6);
        factory.setMinTarget(20_000e6);
        vm.warp(vm.getBlockTimestamp() + 8 days); // the setUp round has expired, so a new one may open
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.TargetTooSmall.selector, 10_000e6, 20_000e6));
        factory.openRound(address(token), 10_000e6, uint64(vm.getBlockTimestamp() + 1 days), 100, 1 days);
        factory.openRound(address(token), 20_000e6, uint64(vm.getBlockTimestamp() + 1 days), 100, 1 days);
    }

    /// Codex r6 #1: a target too large for the pace check, or too small to seed a pool, is refused; a round at
    /// the cap is still replaced, and one at the floor fills and seeds its pool.
    function test_targetBounds() public {
        MockB20 t3 = new MockB20(policies);
        factory.list(address(t3), address(pyth), GME, 60, false);
        uint256 cap = factory.MAX_TARGET();
        assertEq(cap, MAX_TARGET);
        vm.expectRevert(SummonFactory.BadRoundTerms.selector);
        factory.openRound(address(t3), cap + 1, uint64(vm.getBlockTimestamp() + 30 days), 100, 30 days);
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.TargetTooSmall.selector, 10e6 - 1, 10e6));
        factory.openRound(address(t3), 10e6 - 1, uint64(vm.getBlockTimestamp() + 30 days), 100, 30 days);
        SummonRound big = factory.openRound(address(t3), cap, uint64(vm.getBlockTimestamp() + 30 days), 100, 30 days);
        vm.warp(vm.getBlockTimestamp() + 29 days);
        factory.openRound(address(t3), 10e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);
        assertEq(uint8(big.state()), uint8(SummonRound.State.Expired));

        // the setUp round has expired by now; a floor-sized one fills and seeds its pool
        SummonRound small = factory.openRound(address(token), 10e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);
        vm.prank(alice);
        usdc.approve(address(small), type(uint256).max);
        vm.prank(alice);
        small.pledge(10e6);
        _heartbeat();
        small.startAuction{value: 1}(_fresh());
        vm.warp(vm.getBlockTimestamp() + 60);
        _heartbeat();
        bytes[] memory u = _fresh();
        vm.startPrank(ap);
        token.approve(address(small), type(uint256).max);
        small.fill{value: 1}(u);
        vm.stopPrank();
        assertEq(uint8(small.state()), uint8(SummonRound.State.Filled));
        assertGt(IPoolManager(address(pm)).getLiquidity(PoolIdLibrary.toId(small.poolKey())), 0);
    }

    /// Codex r7 #2: a round too small for its token's decimals and price cannot start, so it never fills with a
    /// seed rounded far off the reference; it expires and refunds. The factory's size stays deployable (r7 #1).
    function test_seedLargeEnoughToPrice() public {
        assertLt(address(factory).code.length, 24_576);
        MockB20Of t6 = new MockB20Of(policies, 6);
        market.setState(address(t6), false, 0, 0);
        factory.list(address(t6), address(pyth), GME, 60, false);
        SummonRound r = factory.openRound(address(t6), 10e6, uint64(vm.getBlockTimestamp() + 7 days), 100, 7 days);
        vm.startPrank(alice);
        usdc.approve(address(r), type(uint256).max);
        r.pledge(10e6);
        vm.stopPrank();
        address[] memory ts = new address[](1);
        ts[0] = address(t6);
        market.heartbeat(ts);
        // at $9m a share, the $2 LP share is 0.22 raw units of a 6-decimal token
        bytes[] memory u = _update(900_000_000_000, 10_000_000, uint64(vm.getBlockTimestamp()));
        vm.expectRevert(abi.encodeWithSelector(SummonRound.SeedTooSmall.selector, 1));
        r.startAuction{value: 1}(u);
        // at $23.45 it is 85,288 units, and the auction starts
        r.startAuction{value: 1}(_fresh());
        assertEq(uint8(r.state()), uint8(SummonRound.State.Auction));
        // and expiry still refunds a round that cannot start
        vm.warp(r.params().deadline + 1);
        vm.prank(alice);
        r.refund();
    }

    /// Codex r6 #4: an auction may not start unless its whole window ends by the round's deadline.
    function test_noAuctionPastTheDeadline() public {
        // a round must leave room for one auction window
        vm.warp(vm.getBlockTimestamp() + 8 days);
        vm.expectRevert(SummonRound.BadParams.selector);
        factory.openRound(address(token), 10e6, uint64(vm.getBlockTimestamp() + 3600 - 1), 100, 1 days);
        vm.warp(vm.getBlockTimestamp() - 8 days);
        _fund();
        uint64 deadline = round.params().deadline;
        vm.warp(deadline - 3600 + 1);
        _heartbeat();
        bytes[] memory u = _fresh();
        vm.expectRevert(abi.encodeWithSelector(SummonRound.TooLateToStart.selector, deadline));
        round.startAuction{value: 1}(u);
        vm.warp(deadline - 3600);
        _heartbeat();
        round.startAuction{value: 1}(_fresh());
        vm.warp(deadline + 1);
        assertEq(uint8(round.state()), uint8(SummonRound.State.Expired));
    }

    function test_noNewRoundAfterFill() public {
        _start();
        _fillAfter(60);
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.TokenLive.selector, address(round)));
        factory.openRound(address(token), 10e6, uint64(vm.getBlockTimestamp() + 1 days), 100, 1 days);
    }

    // ------------------------------------------------------------------ claims and policy

    function test_claimBlockedByPolicyStaysClaimable() public {
        _start();
        _fillAfter(60);
        policies.create(8);
        policies.setAllowed(8, address(round), true);
        policies.setAllowed(8, bob, true);
        bytes32 receiver = token.TRANSFER_RECEIVER_POLICY();
        token.setPolicy(receiver, 8);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.PolicyForbids.selector, receiver, alice));
        round.claim();
        assertFalse(round.claimed(alice));
        policies.setAllowed(8, alice, true);
        vm.prank(alice);
        round.claim();
        assertGt(token.balanceOf(alice), 0);
    }

    function test_excessEthRefunded() public {
        _fund();
        uint256 before = address(this).balance;
        round.startAuction{value: 0.1 ether}(_fresh());
        assertEq(before - address(this).balance, 1); // only the Pyth fee
    }

    // ------------------------------------------------------------------ trading the summoned pool

    function test_swapOnSummonedPool() public {
        _start();
        _fillAfter(60);
        SummonSwap router = new SummonSwap(IPoolManager(address(pm)), ISummonPools(address(factory)));
        PoolKey memory key = round.poolKey();
        bool usdcIs0 = address(usdc) < address(token);
        (uint160 p0,, uint128 l0) = router.poolState(key);
        assertGt(l0, 0);

        // a backer buys the stock with 100 USDC
        vm.startPrank(alice);
        usdc.approve(address(router), type(uint256).max);
        uint256 before = token.balanceOf(alice);
        uint256 got = router.swapExactIn(key, usdcIs0, 100e6, 1, alice);
        vm.stopPrank();
        assertEq(token.balanceOf(alice) - before, got);
        // about $100 of stock at $23.45, less the 0.3% fee and the price impact of a 2,000-USDC pool
        uint256 worth = got * 23.45e18 / 1e8 / 1e12;
        assertGt(worth, 90e6);
        assertLt(worth, 100e6);
        (uint160 p1,,) = router.poolState(key);
        assertTrue(p1 != p0, "price moved");

        // and sells it back, with a minimum out it cannot meet
        vm.startPrank(alice);
        token.approve(address(router), type(uint256).max);
        vm.expectRevert();
        router.swapExactIn(key, !usdcIs0, uint128(got), 100e6, alice);
        uint256 back = router.swapExactIn(key, !usdcIs0, uint128(got), 1, alice);
        vm.stopPrank();
        assertLt(back, 100e6, "a round trip costs fees");
        assertEq(usdc.balanceOf(address(router)) + token.balanceOf(address(router)), 0, "router holds nothing");
    }

    // ------------------------------------------------------------------ a pool that knows the market (§5.5, §5.5a)

    function _summoned() internal returns (SummonSwap router, PoolKey memory key, bool usdcIs0) {
        _start();
        _fillAfter(60);
        router = new SummonSwap(IPoolManager(address(pm)), ISummonPools(address(factory)));
        key = round.poolKey();
        usdcIs0 = address(usdc) < address(token);
        vm.prank(alice);
        usdc.approve(address(router), type(uint256).max);
    }

    function _buy(SummonSwap router, PoolKey memory key, bool usdcIs0) internal returns (uint256) {
        vm.prank(alice);
        return router.swapExactIn(key, usdcIs0, 100e6, 1, alice);
    }

    function test_swapFeeRisesWhileClosed() public {
        (SummonSwap router, PoolKey memory key, bool usdcIs0) = _summoned();
        uint256 snap = vm.snapshotState();
        uint256 open = _buy(router, key, usdcIs0);
        vm.revertToState(snap);
        // the guard records the session closed: swaps go on, at 1.00% instead of 0.30%
        market.setState(address(token), true, market.REASON_SESSION_CLOSED(), 0);
        uint256 closed = _buy(router, key, usdcIs0);
        assertLt(closed, open);
        // 0.7% more fee on the same trade, within the price impact's rounding
        assertApproxEqRel(closed * 1e18 / open, uint256(990_000e18) / 997_000, 1e15);
        vm.revertToState(snap);
        // a guard that has gone quiet counts as closed too
        vm.warp(vm.getBlockTimestamp() + 301);
        assertEq(_buy(router, key, usdcIs0), closed);
    }

    function test_swapStopsWhileHalted() public {
        (SummonSwap router, PoolKey memory key, bool usdcIs0) = _summoned();
        market.setState(address(token), true, market.REASON_PRIMARY_HALT(), 0);
        vm.prank(alice);
        vm.expectRevert(); // the PoolManager wraps the hook's MarketHalted
        router.swapExactIn(key, usdcIs0, 100e6, 1, alice);
        // resumed, but not before resumeAfter
        market.setState(address(token), false, 0, uint64(vm.getBlockTimestamp() + 120));
        vm.prank(alice);
        vm.expectRevert();
        router.swapExactIn(key, usdcIs0, 100e6, 1, alice);
        vm.warp(vm.getBlockTimestamp() + 120);
        _heartbeat();
        assertGt(_buy(router, key, usdcIs0), 0);
    }

    function test_swapStopsInCorporateActionWindow() public {
        (SummonSwap router, PoolKey memory key, bool usdcIs0) = _summoned();
        token.setEffectiveAt(vm.getBlockTimestamp() + 1800); // inside the 3600 s cooldown
        vm.prank(alice);
        vm.expectRevert();
        router.swapExactIn(key, usdcIs0, 100e6, 1, alice);
    }

    function test_realignAfterMultiplierChange() public {
        (SummonSwap router, PoolKey memory key, bool usdcIs0) = _summoned();
        (uint160 before,, uint128 l0) = router.poolState(key);
        assertEq(round.poolMultiplier(), 1e18);

        // a 2-for-1 in shares: one token is now worth twice as much, and the pool would sell it at half price
        token.setMultiplier(2e18);
        oracle.set(2e18, false);
        vm.prank(alice);
        vm.expectRevert(); // StaleMultiplier
        router.swapExactIn(key, usdcIs0, 100e6, 1, alice);

        // not while the action window is open, and not while the issuer's registry disagrees
        token.setEffectiveAt(vm.getBlockTimestamp() + 600);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.CorporateActionWindow.selector, vm.getBlockTimestamp() + 600));
        round.realign();
        token.setEffectiveAt(0);
        oracle.set(1e18, false);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.MultiplierMismatch.selector, 1e18, 2e18));
        round.realign();
        oracle.set(2e18, false);

        // anyone can realign; the pool's price doubles (in USDC per token) and swaps resume
        vm.prank(carol);
        round.realign();
        (uint160 afterP,, uint128 l1) = router.poolState(key);
        // sqrtP is sqrt(currency1 / currency0): x sqrt(2) when the token is currency0, / sqrt(2) when it is currency1
        uint256 ratio = usdcIs0 ? uint256(before) * 1e18 / afterP : uint256(afterP) * 1e18 / before;
        assertApproxEqRel(ratio, 1.414213562373095048e18, 1e12);
        assertGt(l1, 0);
        assertLt(l1, l0 * 101 / 100);
        assertEq(round.poolMultiplier(), 2e18);
        vm.expectRevert(SummonRound.NothingToDo.selector);
        round.realign();

        uint256 got = _buy(router, key, usdcIs0);
        // $100 now buys about half as many tokens as at fill: each one is two shares at $23.45
        uint256 worth = got * 2 * 23.45e18 / 1e8 / 1e12;
        assertGt(worth, 90e6);
        assertLt(worth, 100e6);

        // what realign could not put back reaches the backers at unwind
        uint256 idleT = round.idleTokens();
        uint256 idleU = round.idleUsdc();
        vm.warp(vm.getBlockTimestamp() + 7 days + 1);
        round.unwindLP();
        assertGe(round.lpTokens(), idleT);
        assertGe(round.lpUsdc(), idleU);
    }

    function test_onlyTheRoundAddsLiquidity() public {
        (, PoolKey memory key,) = _summoned();
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(IPoolManager(address(pm)));
        usdc.mint(address(this), 1_000e6);
        token.mint(address(this), 100e8);
        usdc.approve(address(lp), type(uint256).max);
        token.approve(address(lp), type(uint256).max);
        vm.expectRevert(); // the PoolManager wraps the hook's NotTheRound
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams(-887220, 887220, 1e9, 0), "");
    }

    /// Codex r1 #4: the router trades only pools a Summon round created.
    function test_routerRefusesOtherPools() public {
        (SummonSwap router, PoolKey memory key, bool usdcIs0) = _summoned();
        PoolKey memory other = PoolKey(key.currency0, key.currency1, 3000, 60, IHooks(address(0)));
        vm.prank(alice);
        vm.expectRevert(SummonSwap.NotASummonPool.selector);
        router.swapExactIn(other, usdcIs0, 100e6, 1, alice);
    }

    function test_hookRejectsDirectSwapCalls() public {
        PoolKey memory key = round.poolKey();
        vm.expectRevert(SummonHook.NotPoolManager.selector);
        hook.beforeSwap(address(this), key, IPoolManager.SwapParams(true, -1, 0), "");
    }

    // ------------------------------------------------------------------ the guard's price feed (testnet)

    function _guardRound() internal returns (SummonRound r, MockB20 t2, GuardPriceFeed feed) {
        feed = new GuardPriceFeed(address(this));
        feed.setUpdater(address(this), true);
        t2 = new MockB20(policies);
        market.setState(address(t2), false, 0, 0);
        oracle.set(1e18, false);
        factory.list(address(t2), address(feed), GME, 60, false);
        r = factory.openRound(address(t2), 10_000e6, uint64(vm.getBlockTimestamp() + 1 days), 100, 1 days);
        for (uint256 i; i < 3; ++i) {
            address b = [alice, bob, carol][i];
            vm.startPrank(b);
            usdc.approve(address(r), type(uint256).max);
            r.pledge([5_000e6, 3_000e6, 2_000e6][i]);
            vm.stopPrank();
        }
        t2.mint(ap, 1_000e8);
        vm.prank(ap);
        t2.approve(address(r), type(uint256).max);
    }

    function test_guardFeedRound() public {
        (SummonRound r, MockB20 t2, GuardPriceFeed feed) = _guardRound();
        bytes[] memory none = new bytes[](0);
        feed.post(GME, PX, CONF, EXPO, vm.getBlockTimestamp());
        r.startAuction(none);
        vm.warp(vm.getBlockTimestamp() + 900);
        address[] memory ts = new address[](1);
        ts[0] = address(t2);
        market.heartbeat(ts);
        feed.post(GME, PX, CONF, EXPO, vm.getBlockTimestamp());
        vm.prank(ap);
        r.fill(none);
        assertEq(uint8(r.state()), uint8(SummonRound.State.Filled));
        assertEq(r.fillRef(), 23.45e18);
        assertEq(r.fillSpreadBps(), 50);
    }

    function test_guardFeedGoesStaleWhenGuardStops() public {
        (SummonRound r,, GuardPriceFeed feed) = _guardRound();
        bytes[] memory none = new bytes[](0);
        feed.post(GME, PX, CONF, EXPO, vm.getBlockTimestamp());
        r.startAuction(none);
        vm.warp(vm.getBlockTimestamp() + 61); // the guard posted nothing since
        vm.prank(ap);
        vm.expectRevert(abi.encodeWithSelector(PythRef.PythStale.selector, GME, 61, 60));
        r.fill(none);
    }

    function test_guardFeedRules() public {
        GuardPriceFeed feed = new GuardPriceFeed(address(this));
        vm.expectRevert(GuardPriceFeed.NotUpdater.selector);
        feed.post(GME, PX, CONF, EXPO, vm.getBlockTimestamp());
        feed.setUpdater(address(this), true);
        vm.expectRevert(GuardPriceFeed.PriceFeedNotFound.selector);
        feed.getPriceUnsafe(GME);
        feed.post(GME, PX, CONF, EXPO, vm.getBlockTimestamp());
        vm.expectRevert(abi.encodeWithSelector(GuardPriceFeed.NotNewer.selector, vm.getBlockTimestamp(), vm.getBlockTimestamp()));
        feed.post(GME, PX, CONF, EXPO, vm.getBlockTimestamp());
        vm.expectRevert(GuardPriceFeed.BadPrice.selector);
        feed.post(GME, PX, CONF, EXPO, vm.getBlockTimestamp() + 31);
        vm.expectRevert(GuardPriceFeed.BadPrice.selector);
        feed.post(GME, 0, CONF, EXPO, vm.getBlockTimestamp() + 1);
        bytes[] memory one = new bytes[](1);
        vm.expectRevert(GuardPriceFeed.NoUpdateData.selector);
        feed.updatePriceFeeds(one);
        vm.prank(alice);
        vm.expectRevert(GuardPriceFeed.NotOwner.selector);
        feed.setUpdater(alice, true);
    }

    receive() external payable {}
}
