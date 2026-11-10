Round-4 disposition: #1 accepted; #2 remains a blocker; #3 is fixed; #4 remains major; #5 is fixed.

1. **Blocker — the new activity rule restores indefinite ticker squatting.** [SummonFactory.sol:119](src/SummonFactory.sol:119), [SummonRound.sol:224](src/SummonRound.sol:224). An attacker opens a $10,000 round, then pledges $10 (exactly 0.1%) every <24 hours. It remains below 10% for the full 30 days, so no replacement is possible. Once expired, the attacker opens the next round immediately and repeats; the old pledge is refundable. On this testnet, tUSDC is freely mintable, so this permanently blocks a listed ticker at negligible cost. This also forces cancellation of a genuinely active round whose users make smaller individual pledges.

   Proposed fix: do not let a pledge be an unchallengeable keepalive. Permit inactivity replacement while preserving existing backers’ economic position—e.g. migrate compatible pledges into the successor and require backer approval for materially worse terms—or require a meaningful, slashable opener/keepalive bond. Add a test that cycles a 0.1%-per-day attacker through expiry into a successor round.

2. **Major — ticker rename is still stale until each signer replaces or expires their intent.** [store.ts:131](web/worker/store.ts:131), [store.ts:149](web/worker/store.ts:149), [index.ts:141](web/worker/index.ts:141). Totals are keyed by token now, but the stored ticker changes only on a new POST. If token X has $250 under `RKT` and the snapshot renames X to `NEW`, `GET /api/intents` still returns `RKT` for up to 31 days. If `RKT` is reassigned to token Y, the board combines X’s stale total with Y’s current total and can offer a demo round for Y based on X’s signatures.

   Proposed fix: have the Durable Object return totals keyed by token; in the Worker, resolve those tokens against the fresh snapshot before grouping by current ticker, dropping tokens no longer present. Add a rename-without-repost test and a ticker-reassignment test.

3. **Minor — the new Pyth retry covers `fill`, but not `startAuction`.** [e2e.ts:115](ts/e2e.ts:115), [e2e.ts:124](ts/e2e.ts:124). Both calls use `readFirstAfter`, so a quiet 10-second band can make `startAuction` revert before the fill retry loop is reached. This makes the documented pull-feed E2E path intermittently fail.

   Proposed fix: use the same bounded, next-window-aware retry wrapper for `startAuction` and `fill`, retrying only the “no qualifying Pyth print” failure.

The #1 band-selection argument is sound: settling near the actual fill time avoids giving a filler an hour-long option on a known stale price. The nonce count/pruning path is bounded and internally consistent, and `swapGate()` now applies the issuer-registry pause/multiplier check.

VERDICT: CHANGES