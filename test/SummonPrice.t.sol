// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SummonPrice} from "../src/SummonPrice.sol";

contract SummonPriceHarness {
    /// Pyth (price, expo) scaled to 18 decimals the way PythRef.read does, then the multiplier.
    function ref(int64 p, int32 e, uint256 m) external pure returns (uint256) {
        require(p > 0 && e <= 0 && e >= -18, "bad pyth");
        return SummonPrice.refPerToken(uint256(int256(p)) * 10 ** uint256(int256(18 + e)), m);
    }

    function refWad(uint256 u, uint256 m) external pure returns (uint256) {
        return SummonPrice.refPerToken(u, m);
    }

    function usdcFor(uint256 q, uint256 r, uint256 s, uint8 d) external pure returns (uint256) {
        return SummonPrice.usdcFor(q, r, s, d);
    }

    function tokensFor(uint256 u, uint256 r, uint256 s, uint8 d) external pure returns (uint256) {
        return SummonPrice.tokensFor(u, r, s, d);
    }
}

contract SummonPriceTest is Test {
    SummonPriceHarness h = new SummonPriceHarness();

    /// GME at $23.45 (Pyth expo -5), multiplier 1: 100 whole tokens (8 decimals) at 0 spread = $2,345.
    function test_basicUnits() public view {
        uint256 r = h.ref(2_345_000, -5, 1e18);
        assertEq(r, 23.45e18);
        assertEq(h.usdcFor(100e8, r, 0, 8), 2_345e6);
        assertEq(h.tokensFor(2_345e6, r, 0, 8), 100e8);
        // 100 bp spread: the filler gets 1% more USDC for the same tokens.
        assertEq(h.usdcFor(100e8, r, 100, 8), 2_368.45e6);
    }

    /// A4: a 10:1 split (multiplier ×10, underlying ÷10) leaves the price per token unchanged.
    function test_splitLeavesTokenPriceUnchanged() public view {
        uint256 before = h.ref(23_450_000_000, -8, 1e18); // $234.50
        uint256 afterSplit = h.ref(2_345_000_000, -8, 10e18); // $23.45 × 10
        assertEq(afterSplit, before);
    }

    /// A4, second half: pricing that forgets the multiplier is caught by the same comparison.
    function test_ignoringMultiplierWouldBeCaught() public view {
        uint256 before = h.ref(23_450_000_000, -8, 1e18);
        uint256 wrong = h.ref(2_345_000_000, -8, 1e18); // multiplier dropped
        assertTrue(wrong != before);
    }

    /// A dividend (multiplier 1.02) makes a token worth 2% more than a share.
    function test_dividendMultiplier() public view {
        assertEq(h.ref(10_000_000_000, -8, 1.02e18), 102e18);
    }

    /// F2 at the price level, fuzzed (A3): for the tokens the filler must deliver for `u` USDC,
    /// the USDC those tokens are worth is never less than `u` (rounding favors backers), and is at
    /// most `u` plus the value of one raw unit plus 1 USDC unit.
    function testFuzz_roundTripFavorsBackers(
        uint64 usdcIn,
        int64 price,
        uint8 expoNeg,
        uint64 multRaw,
        uint16 spread,
        uint8 decRaw
    ) public view {
        uint256 u = bound(uint256(usdcIn), 1, 10_000_000e6);
        price = int64(int256(bound(int256(price), 1e3, 1e12)));
        int32 expo = -int32(int256(bound(uint256(expoNeg), 5, 8)));
        uint256 m = bound(uint256(multRaw), 0.5e18, 20e18);
        uint256 s = bound(uint256(spread), 0, 100);
        uint8 d = uint8(bound(uint256(decRaw), 6, 18));
        if (d != 6 && d != 8 && d != 18) d = 8;

        uint256 r = h.ref(price, expo, m);
        vm.assume(r > 0);
        uint256 q = h.tokensFor(u, r, s, d);
        uint256 worth = h.usdcFor(q, r, s, d);
        assertGe(worth, u, "filler delivered less than it was paid for");
        uint256 oneUnit = h.usdcFor(1, r, s, d);
        assertLe(worth, u + oneUnit + 1, "filler over-delivered beyond rounding");
    }

    function test_rejectsBadInputs() public {
        vm.expectRevert(SummonPrice.BadPythPrice.selector);
        h.refWad(0, 1e18);
        vm.expectRevert(SummonPrice.BadMultiplier.selector);
        h.refWad(1e18, 0);
        vm.expectRevert(SummonPrice.BadDecimals.selector);
        h.usdcFor(1, 1e18, 0, 5);
        vm.expectRevert(SummonPrice.SpreadTooWide.selector);
        h.usdcFor(1, 1e18, 10_001, 8);
    }
}
