1. **Major — R3 #2: partly fixed.** [`SummonRound.sol:195`](src/SummonRound.sol:195), [`:483`](src/SummonRound.sol:483). Pyth uniqueness is correctly modeled: the mock’s `prev < min <= publish` rule matches [Pyth’s documented rule](https://api-reference.pyth.network/price-feeds/evm/parsePriceFeedUpdatesUnique). Fee payment and the normal surplus-ETH refund path are also correct.

   But `settleTime()` is recomputed on every fill. A filler can watch the first print in each 10-second band and submit only in a favorable band; they also choose when to start the auction and therefore its jump anchor. The filler no longer selects a later print within one band, but still selects among bands. `PriceNotAfterStart` additionally makes the band containing a newly started auction unusable when its first print predates `auctionStart`; a quiet feed can leave successive 10-second bands with no qualifying print. Five Base blocks per band does not solve missing Pyth/Hermes updates.

   Commit a single post-start settlement time when the auction starts (with a sufficiently long fixed availability window), and use it for every fill; or use a deterministic TWAP/keeper observation. `test_pullFeedSettlesOnTheFirstPrintAfterASetTime` would fail without the unique-parser change, but it does not test cross-window selection or quiet-feed liveness.

2. **Major — new regression in the R3 #1 replacement policy.** [`SummonFactory.sol:113`](src/SummonFactory.sol:113). After one day, anyone can cancel a round with 9.999% pledged simply by opening a replacement. A griefer can repeatedly cancel a legitimately progressing round just below 10%, force every backer to claim a refund, open an unreachable replacement, and repeat daily. On this testnet the unrestricted mintable tUSDC makes the 10% threshold non-economic.

   The old funds are not permanently stranded—the cancelled round is correctly refundable—but healthy partial rounds are permissionlessly griefable. Require an incumbent/backer-approved cancellation, carry pledges into a compatible replacement, or impose a meaningful slashable opener bond. Add a test for repeated replacement of a 9.99%-pledged round.

3. **Major — R3 #3: partly fixed; nonce storage remains unbounded by count.** [`store.ts:42`](web/worker/store.ts:42), [`:114`](web/worker/store.ts:114), [`:172`](web/worker/store.ts:172). `MAX_LIVE` caps live intents, and time-pruning removes individual nonce rows eventually. It does not cap the number of nonce rows retained during that period. A distributed-IP bot can continuously submit short-lived signed intents from fresh wallets; expiry frees live-intent capacity while nonce rows accumulate for 31–32 days.

   Add a hard nonce-row/admission cap or retain replay protection only for a bounded, globally capped issuer sequence. The three named worker tests fail if their individual cap/prune/aggregate mechanisms are removed, but none exercises cardinality pressure on `nonces`.

4. **Major — totals can permanently diverge after a ticker rename.** [`store.ts:98`](web/worker/store.ts:98), [`:116`](web/worker/store.ts:116), [`:121`](web/worker/store.ts:121). The design explicitly identifies a stock by address because its ticker can change. If token X has an RKT intent for $250, then the snapshot renames it and the wallet replaces it as NEW for $100, the intent row changes ticker but the old RKT total is never decremented. NEW receives `backers: 0, usd: -150`; after expiry, the stale RKT total remains permanently.

   Store totals by token and derive current ticker on read, or fetch the previous ticker and atomically decrement its aggregate before updating the intent. Add rename-and-expiry coverage.

5. **Minor — the UI now misstates whether swaps are available.** [`web/src/round.ts:480`](web/src/round.ts:480). The hook correctly checks issuer pause/multiplier mismatch, but `swapGate()` does not read the oracle registry. It can offer an enabled trade while the contract necessarily reverts, despite claiming to read the same sources.

   Read `D.oracleRegistry` with `oracleAbi` and apply the hook’s pause/multiplier checks before enabling trading.

6. **Fixed — R3 #1’s original stranded-old-round scenario.** [`SummonFactory.sol:116`](src/SummonFactory.sol:116), [`SummonRound.sol:247`](src/SummonRound.sol:247). Replacement cancels the prior Open round atomically; it rejects later pledges and permits refunds. [`test_roundsCannotSquatATicker`](test/SummonRound.t.sol:441) fails without cancellation or the below-10% replacement condition.

7. **Fixed — R3 #4.** [`SummonHook.sol:88`](src/SummonHook.sol:88). Issuer pause and registry/token multiplier disagreement now stop swaps. [`test_swapStopsWhileTheIssuerPauses`](test/SummonRound.t.sol:532) fails without this check.

8. **Fixed — R3 #8.** [`001-summon.md:117`](docs/specs/001-summon.md:117) now describes 10-second pull settlement separately from the 60-second push-feed policy. No named automated test applied to the documentation finding.

`forge test` passes all 52 tests. The worker suite could not be re-run in this sandbox because `tsx` is denied permission to create its local IPC socket.

VERDICT: CHANGES