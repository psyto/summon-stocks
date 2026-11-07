// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {MarketStateRegistry} from "market-state/MarketStateRegistry.sol";
import {MarketStateCheck} from "market-state/MarketStateCheck.sol";
import {PythRef} from "hl-price-guard/PythRef.sol";
import {SummonFactory} from "../src/SummonFactory.sol";
import {SummonRound} from "../src/SummonRound.sol";
import {SummonHook, ISummonRegistry} from "../src/SummonHook.sol";
import {SummonPrice} from "../src/SummonPrice.sol";
import {SummonPool} from "../src/SummonPool.sol";
import {SummonSwap} from "../src/SummonSwap.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MockERC20, MockB20, MockPolicyRegistry, MockOracleRegistry} from "./mocks/Mocks.sol";
import {GuardPriceFeed} from "../src/testnet/GuardPriceFeed.sol";

contract SummonRoundTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

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
                maxPythAge: 60,
                maxConfBps: 50,
                maxJumpBps: 300,
                cooldownSeconds: 3600
            })
        );
        hook.setFactory(ISummonRegistry(address(factory)));
        factory.list(address(token), address(pyth), GME);
        round = factory.openRound(address(token), 10_000e6, uint64(block.timestamp + 7 days), 100, 7 days);

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
        return _update(PX, CONF, uint64(block.timestamp));
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
        vm.warp(block.timestamp + secs);
        _heartbeat();
        bytes[] memory u = _fresh();
        vm.prank(ap);
        round.fill{value: 1}(u);
    }

    function _expectFillRevert(bytes memory err) internal {
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
        vm.warp(block.timestamp + 7 days);
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
        vm.warp(block.timestamp + 450);
        assertEq(round.currentSpreadBps(), 25);
        vm.warp(block.timestamp + 1350);
        assertEq(round.currentSpreadBps(), 100);
        vm.warp(block.timestamp + 1000);
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
        vm.warp(block.timestamp + 301);
        _expectFillRevert(abi.encodeWithSelector(MarketStateCheck.MarketStateStale.selector, uint64(block.timestamp - 301)));
    }

    function test_beforeResume() public {
        _start();
        uint64 resume = uint64(block.timestamp + 600);
        market.setState(address(token), false, 0, resume);
        _expectFillRevert(abi.encodeWithSelector(MarketStateCheck.NotYetResumed.selector, resume));
    }

    /// Pyth keeps the newest price, so an older update cannot make it stale; time passing does.
    function test_stalePythPrice() public {
        _start();
        vm.warp(block.timestamp + 61);
        _heartbeat();
        bytes[] memory none = new bytes[](0);
        vm.prank(ap);
        vm.expectRevert(abi.encodeWithSelector(PythRef.PythStale.selector, GME, 61, 60));
        round.fill(none);
    }

    function test_wideConfidence() public {
        _start();
        vm.warp(block.timestamp + 1);
        bytes[] memory wide = _update(PX, 23_450, uint64(block.timestamp)); // 100 bp
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
        uint256 eff = block.timestamp + 1800;
        token.setEffectiveAt(eff);
        _expectFillRevert(abi.encodeWithSelector(SummonRound.CorporateActionWindow.selector, eff));
        // far enough away, the same scheduled change does not block
        token.setEffectiveAt(block.timestamp + 2 days);
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
        vm.warp(block.timestamp + 60);
        _heartbeat();
        bytes[] memory jumped = _update(PX * 104 / 100, CONF, uint64(block.timestamp)); // +4% > 3%
        vm.prank(ap);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.PriceJumped.selector, 400, 300));
        round.fill{value: 1}(jumped);
    }

    // ------------------------------------------------------------------ A6: expiry and refunds

    function test_expiresAtDeadline() public {
        vm.prank(alice);
        round.pledge(3_000e6);
        vm.prank(bob);
        round.pledge(2_000e6);
        vm.warp(block.timestamp + 7 days + 1);
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
            vm.warp(block.timestamp + 3601);
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
        vm.warp(block.timestamp + 3601);
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
        factory.openRound(address(usdc), 1e6, uint64(block.timestamp + 1 days), 100, 1 days);
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.RoundActive.selector, address(round)));
        factory.openRound(address(token), 1e6, uint64(block.timestamp + 1 days), 100, 1 days);
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.AlreadyListed.selector, address(token)));
        factory.list(address(token), address(pyth), bytes32(uint256(1)));
        vm.prank(alice);
        vm.expectRevert(SummonFactory.NotOwner.selector);
        factory.list(address(usdc), address(pyth), bytes32(uint256(1)));
        // spread above 1% is refused
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(SummonRound.BadParams.selector);
        factory.openRound(address(token), 1e6, uint64(block.timestamp + 1 days), 101, 1 days);
        // after expiry a new round may open; after a fill it may not
        SummonRound r2 = factory.openRound(address(token), 1e6, uint64(block.timestamp + 1 days), 100, 1 days);
        assertTrue(address(r2) != address(round));
    }

    function test_minTarget() public {
        assertEq(factory.minTarget(), 0); // testnet: no minimum
        vm.prank(alice);
        vm.expectRevert(SummonFactory.NotOwner.selector);
        factory.setMinTarget(1_000e6);
        factory.setMinTarget(20_000e6);
        vm.warp(block.timestamp + 8 days); // the setUp round has expired, so a new one may open
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.TargetTooSmall.selector, 10_000e6, 20_000e6));
        factory.openRound(address(token), 10_000e6, uint64(block.timestamp + 1 days), 100, 1 days);
        factory.openRound(address(token), 20_000e6, uint64(block.timestamp + 1 days), 100, 1 days);
    }

    function test_noNewRoundAfterFill() public {
        _start();
        _fillAfter(60);
        vm.expectRevert(abi.encodeWithSelector(SummonFactory.TokenLive.selector, address(round)));
        factory.openRound(address(token), 1e6, uint64(block.timestamp + 1 days), 100, 1 days);
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
        SummonSwap router = new SummonSwap(IPoolManager(address(pm)));
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
        router = new SummonSwap(IPoolManager(address(pm)));
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
        vm.warp(block.timestamp + 301);
        assertEq(_buy(router, key, usdcIs0), closed);
    }

    function test_swapStopsWhileHalted() public {
        (SummonSwap router, PoolKey memory key, bool usdcIs0) = _summoned();
        market.setState(address(token), true, market.REASON_PRIMARY_HALT(), 0);
        vm.prank(alice);
        vm.expectRevert(); // the PoolManager wraps the hook's MarketHalted
        router.swapExactIn(key, usdcIs0, 100e6, 1, alice);
        // resumed, but not before resumeAfter
        market.setState(address(token), false, 0, uint64(block.timestamp + 120));
        vm.prank(alice);
        vm.expectRevert();
        router.swapExactIn(key, usdcIs0, 100e6, 1, alice);
        vm.warp(block.timestamp + 120);
        _heartbeat();
        assertGt(_buy(router, key, usdcIs0), 0);
    }

    function test_swapStopsInCorporateActionWindow() public {
        (SummonSwap router, PoolKey memory key, bool usdcIs0) = _summoned();
        token.setEffectiveAt(block.timestamp + 1800); // inside the 3600 s cooldown
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
        token.setEffectiveAt(block.timestamp + 600);
        vm.expectRevert(abi.encodeWithSelector(SummonRound.CorporateActionWindow.selector, block.timestamp + 600));
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
        vm.warp(block.timestamp + 7 days + 1);
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
        factory.list(address(t2), address(feed), GME);
        r = factory.openRound(address(t2), 10_000e6, uint64(block.timestamp + 1 days), 100, 1 days);
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
        feed.post(GME, PX, CONF, EXPO, block.timestamp);
        r.startAuction(none);
        vm.warp(block.timestamp + 900);
        address[] memory ts = new address[](1);
        ts[0] = address(t2);
        market.heartbeat(ts);
        feed.post(GME, PX, CONF, EXPO, block.timestamp);
        vm.prank(ap);
        r.fill(none);
        assertEq(uint8(r.state()), uint8(SummonRound.State.Filled));
        assertEq(r.fillRef(), 23.45e18);
        assertEq(r.fillSpreadBps(), 50);
    }

    function test_guardFeedGoesStaleWhenGuardStops() public {
        (SummonRound r,, GuardPriceFeed feed) = _guardRound();
        bytes[] memory none = new bytes[](0);
        feed.post(GME, PX, CONF, EXPO, block.timestamp);
        r.startAuction(none);
        vm.warp(block.timestamp + 61); // the guard posted nothing since
        vm.prank(ap);
        vm.expectRevert(abi.encodeWithSelector(PythRef.PythStale.selector, GME, 61, 60));
        r.fill(none);
    }

    function test_guardFeedRules() public {
        GuardPriceFeed feed = new GuardPriceFeed(address(this));
        vm.expectRevert(GuardPriceFeed.NotUpdater.selector);
        feed.post(GME, PX, CONF, EXPO, block.timestamp);
        feed.setUpdater(address(this), true);
        vm.expectRevert(GuardPriceFeed.PriceFeedNotFound.selector);
        feed.getPriceUnsafe(GME);
        feed.post(GME, PX, CONF, EXPO, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(GuardPriceFeed.NotNewer.selector, block.timestamp, block.timestamp));
        feed.post(GME, PX, CONF, EXPO, block.timestamp);
        vm.expectRevert(GuardPriceFeed.BadPrice.selector);
        feed.post(GME, PX, CONF, EXPO, block.timestamp + 31);
        vm.expectRevert(GuardPriceFeed.BadPrice.selector);
        feed.post(GME, 0, CONF, EXPO, block.timestamp + 1);
        bytes[] memory one = new bytes[](1);
        vm.expectRevert(GuardPriceFeed.NoUpdateData.selector);
        feed.updatePriceFeeds(one);
        vm.prank(alice);
        vm.expectRevert(GuardPriceFeed.NotOwner.selector);
        feed.setUpdater(alice, true);
    }

    receive() external payable {}
}
