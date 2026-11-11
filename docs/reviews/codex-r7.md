1. **Blocker — factory cannot deploy under the checked-in build configuration.** [src/SummonFactory.sol:9](src/SummonFactory.sol:9)

   Default `forge build --sizes` reports `SummonFactory` runtime bytecode of 27,975 bytes—3,399 bytes above EIP-170’s 24,576-byte limit. The documented deployment command does not enable IR compilation, so Base Sepolia contract creation will fail.

   Proposed fix: set `via_ir = true` in `foundry.toml` and make CI/deployment use it, or move `new SummonRound(...)` into a separate deployer. IR compilation produces a 22,897-byte factory and `forge test --via-ir` passes.

2. **Major — round-6 #1: partly fixed.** [src/SummonFactory.sol:50](src/SummonFactory.sol:50), [src/SummonFactory.sol:115](src/SummonFactory.sol:115), [src/SummonFactory.sol:170](src/SummonFactory.sol:170), [src/SummonRound.sol:291](src/SummonRound.sol:291)

   `MAX_TARGET = 1e15` does fix the pace overflow. While a round is Open, its elapsed time is at most 30 days, so both cross-products remain below `2^256`; the comparison has no division rounding. `test_targetBounds` does fail without the added upper/lower-bound reverts.

   But the $10 floor does not guarantee a viable, correctly priced seed for all supported B20 precision and accepted prices. A 6-decimal B20 is supported. At a valid $9m reference price, a $10 round has `$8` filler allocation and `$2` LP allocation; both round up to one raw token unit, so `qLp >= q` and `fill()` always reverts at line 295. At $7m, it fills, but the filler delivers two raw units worth $14 for $8, and the one-unit/$2 seed initializes around $2m rather than the $7m reference price. The existing test covers only an 8-decimal $23.45 token.

   Proposed fix: make admissible reference-price precision explicit: constrain listing decimals/reference bounds and derive a target minimum that guarantees `qLp < q`, nonzero liquidity, and the stated rounding bound. Add 6/8/18-decimal high-reference tests.

3. **Minor — round-6 #3: fixed in code, but untested.** [ts/e2e.ts:55](ts/e2e.ts:55), [ts/e2e.ts:82](ts/e2e.ts:82)

   After a quiet band, `pythArgs(after)` only selects a strictly later settlement band. The 2-second Base-block arithmetic keeps gas estimation and the expected inclusion band aligned, with a buffer for one additional block. The retry also now matches only Pyth’s no-print error selector/name.

   There is no named regression test for this script, so this was not demonstrated by a test that fails without the fix.

   Proposed fix: add a deterministic mocked-clock test covering a quiet `startAuction` band and asserting the second attempt uses a later band.

4. **Minor — round-6 #4: fixed.** [src/SummonRound.sol:164](src/SummonRound.sol:164), [src/SummonRound.sol:258](src/SummonRound.sol:258), [src/SummonRound.sol:534](src/SummonRound.sol:534)

   The constructor requires room for a window, `startAuction` rejects starts whose window would pass the deadline, and a funded round that becomes too late dynamically expires/refunds. An auction ending exactly at the deadline may fill then; one second later it expires. No Funded/Auction stranded-funds state remains.

   `test_noAuctionPastTheDeadline` fails without the start cutoff.

   Proposed fix: none required for the deadline issue; add a constructor-boundary test for `deadline = now + windowSeconds - 1`.

VERDICT: CHANGES