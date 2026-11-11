1. **Blocker — round-5 #1: partly fixed.** `src/SummonFactory.sol:160-163`

   The normal pace rule works: a round at or above the exact half-linear pace cannot be cancelled; it has no rounding loss, and `SummonRound` rejects a deadline at/before opening (`src/SummonRound.sol:163-169`).

   But `target` is unbounded, and `_behindPace` multiplies it by `PACE_BPS` and elapsed time. An attacker opens a round with `target > type(uint256).max / 5000`, pledges nothing, then after one day any replacement reverts from overflow at line 162. At expiry, `state()` is `Expired`, so the attacker opens the same oversized zero-pledge round again. This restores the indefinite ticker-squat path without locking a growing share.

   There is also a testnet dust path: `minTarget` is zero, so a one-unit-USDC target is allowed (`src/SummonFactory.sol:110`). Funding it makes the round non-replaceable; its LP allocation rounds to zero at `src/SummonRound.sol:288`, and seeding then reverts because both pool amounts are zero (`src/SummonPool.sol:30-35`). It remains unrecoverable without three permissionless failed-auction cycles or expiry.

   Proposed fix: use overflow-safe full-precision comparison (or a safe target cap) for the pace check, and enforce a nonzero minimum target sufficient for a nonzero LP seed. Add tests for a maximum-sized target and a fully funded sub-LP-unit target.

2. **Fixed — round-5 #2.** `web/worker/store.ts:149-155`, `web/worker/index.ts:79-90`

   Totals are now returned by normalized token address, then resolved through the current snapshot. A renamed token is immediately displayed under its new ticker; a reassigned ticker cannot combine the old token’s total with the new token’s total; absent tokens are omitted. The reviewed regression test covers rename, reassignment, and removal at `web/worker/worker.test.ts:286-300`.

3. **Major — round-5 #3: not fixed.** `ts/e2e.ts:57-67`, `ts/e2e.ts:73-83`

   `priced()` now wraps both `startAuction` and `fill`, but it does not wait for the next settlement band after a quiet-band failure, despite saying it does. For example, after a failed transaction at timestamp 14 for band `[0,10]`, Base’s two-second blocks can make retries land at 16 and 18—still settling `[0,10]`—so all three attempts fail even if `[10,20]` has a valid print.

   It also retries every revert, including a market halt, policy failure, or bad oracle state, rather than only a confirmed no-print failure.

   Proposed fix: retain the attempted band, wait until a block settles the following band before retrying, and retry only a decoded/simulated “no qualifying Pyth print” failure. Add a deterministic quiet-band test for `startAuction`.

4. **Minor — auction can run past the stated deadline.** `src/SummonRound.sol:256-266`, `src/SummonRound.sol:531-538`

   A funded round can call `startAuction()` at exactly its deadline because expiry is strict `>`. Once in `Auction`, `_timed()` ignores the deadline until the auction window ends. A 30-day round can therefore fill up to one hour after its deadline, contrary to the stated maximum round duration, while preventing a replacement round.

   Proposed fix: reject starts that cannot complete before the deadline, or expire an Auction immediately once the deadline passes; use one explicit deadline convention consistently.

VERDICT: CHANGES