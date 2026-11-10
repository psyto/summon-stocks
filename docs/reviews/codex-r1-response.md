# Codex r1: what changed (2026-11-10)

Codex reviewed the `stock-aware-pool` branch (spec r4) and returned CHANGES: 3 major, 4 minor, no blocker
([codex-r1.md](codex-r1.md)). All seven were reproducible from the code, and all are fixed on the branch.
Each fix has a test, and removing the fix makes that test fail.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 major | A filler starts the auction on a favorable Pyth print up to `maxPythAge` old, then fills on that same print; the jump guard passes because the anchor is the same print | `fill` requires the price to be published after `auctionStart` (`PriceNotAfterStart`). The filler can no longer settle on a print from before the auction | `test_fillNeedsAPriceFromAfterTheStart` |
| 2 major | Expired intents stay in the board total and can open a round; no maximum expiry | Totals are counted from unexpired stored intents on every read (the `summary` blob is gone); an intent lasts at most 31 days | "an expired intent stops counting at once", "an intent may last at most 31 days" |
| 3 major | An older signed intent can be posted again to restore a replaced one; limits and totals race under KV | A permanent per-wallet, per-stock nonce high-water mark; an older nonce gets 409. Totals no longer race (counted from records). The per-network limits stay a brake, not a guarantee, and the Worker's header says so; a Durable Object would make them exact | "an older signature cannot restore a replaced intent" |
| 4 minor | `SummonSwap` trades any v4 pool | It takes the factory and refuses keys no round registered (`NotASummonPool`). The deploy script now deploys it | `test_routerRefusesOtherPools` |
| 5 minor | The round page says the conditions hold without the filler's own policy, and always quotes a 0.3% fee | The checks are labelled as the ones the page can read, naming what the round checks at fill. The trade panel reads the hook's sources: it shows when and why trading is stopped, the 1.00% fee while closed, and a "Realign the pool" button after a multiplier change | (page) |
| 6 minor | The US block fails open when `request.cf.country` is missing | A missing country is refused too, except with `GEO_BLOCK=off` (local development) | "a request with no country is refused" |
| 7 minor | The README reads as if this branch's contracts were deployed; it says r3 | The deployment row and table name the older `main` contracts; spec r4 | (docs) |

Next: Codex r2 on the fixed branch, then the redeploy.

## Codex r2 (2026-11-10): what changed

Codex r2 ([codex-r2.md](codex-r2.md)) found r1 #2, #4, #5, #6 and #7 fixed, #1 and #3 partly fixed, and four
new issues (one blocker), verdict CHANGES.

| # | Finding | Fix now | Test |
|---|---|---|---|
| 8 blocker | Anyone can open a round with a far deadline and a target nobody meets, and so hold every listed ticker | A round lasts at most 30 days and locks its LP at most 30 days (`BadRoundTerms`). A round nobody has pledged to may be replaced a day after it opened; a round with a pledge never is | `test_roundsCannotSquatATicker` |
| 1 (rest) major | With Pyth, the filler can still pick the most favorable print published after the start, within 60 s | Each listing sets its oldest accepted price: 5 s where the filler supplies the update (Pyth), 60 s where the guard posts one price at a time. The choice left is within 5 s | `test_pullFeedFillNeedsARecentPrice` |
| 10 major | The round page sends empty Pyth updates, so a Pyth-priced round cannot be started or filled from it | For a Pyth-priced round the page offers no start or fill and says to use the filler script. The testnet deployment prices from the guard feed | (page) |
| 11 minor | A nonce far in the future locks the wallet out of that stock | A nonce more than a day ahead is refused | "a nonce far ahead is refused" |
| 3 (rest), 9 major | Nonce check and totals are not atomic under KV; every read lists every record | Intents moved from KV to one SQLite-backed Durable Object (`web/worker/store.ts`). It runs one request at a time and its SQL calls are synchronous, so the nonce check, both per-network limits and the write happen as one step. Totals are one indexed query over unexpired rows; an hourly alarm deletes expired intents and old counters (nonces stay, so an expired signature stays refused); the demand export comes in pages of 500 with `next`. Checked in workerd too (`wrangler dev`): a replay sent alongside its replacement gets 409 | "a replay sent at the same time as its replacement cannot win", "the per-network limit holds when the writes arrive at once", "the hourly sweep deletes expired intents but keeps their nonces", "the demand export comes in pages" |

## Codex r3 (2026-11-11): what changed

Codex r3 ([codex-r3.md](codex-r3.md)) found r2 #3, #10 and #11 fixed, #1, #8 and #9 partly fixed, and one
new issue, verdict CHANGES.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 major (r2 #8 rest) | A dust pledge holds a ticker for 30 days; replacing a round leaves the old one taking pledges it can never fill | An Open round a day old with under 10% of its target pledged may be replaced, and the factory cancels it in the same transaction (`SummonRound.cancel`, factory only): it becomes Expired, refunds, and refuses new pledges. A Funded round frees itself after three auctions nobody fills | `test_roundsCannotSquatATicker` (cancelled round refuses a pledge; a 1-unit pledge does not block; its owner refunds; 10% blocks) |
| 2 major (r2 #1 rest) | Within the 5 s window the filler still picks the print; a fair fill may miss the window | A pull listing settles on the first Pyth print at or after `settleTime()` (the start of the previous 10 s window), through `parsePriceFeedUpdatesUnique`. Added to hl-price-guard as `PythRef.readFirstAfter` (v0.4.0), which its own docs already recommended for a price at a set time. Push feeds (the testnet guard) keep 60 s. `ts/e2e.ts` fetches that print from Hermes and times the transaction into its window. The Pyth on Base Sepolia answers `parsePriceFeedUpdatesUnique` | `test_pullFeedSettlesOnTheFirstPrintAfterASetTime` (a later, higher print and an earlier window's print are refused) |
| 3 major (r2 #9 rest) | Live intents and nonces unbounded; totals aggregate every live row | Totals are one row per ticker. Each request deletes expired intents through the expiry index and takes them off the totals. Live intents are capped at 50,000. A nonce is the signing time in ms and an intent may last at most 31 days from it, so nonces are dropped after 31 days. The export's paging reads each page when fetched (documented) | "an intent may last at most 31 days from its nonce, and the nonce is dropped after that", "live intents are capped", "totals are kept as rows and an expired intent leaves them" |
| 4 major (new) | Swaps ignore the issuer registry's pause | `beforeSwap` reverts while the registry says paused or its multiplier differs from the token's | `test_swapStopsWhileTheIssuerPauses` |
| 6 | No page test for the Pyth start/fill suppression | Not added: the page has no test harness; checked by hand | - |
| 7 minor | A near-limit nonce can lock out for up to a day | Accepted: the page signs `Date.now()`; a nonce more than a day ahead is refused | - |
| 8 minor | The spec still says 60 s for every Pyth price | Spec r5: pull and push listings (5.1, 5.2 item 3), round replacement (2a), the hook's issuer check (5.5) | - |

Removing each fix makes its test fail (checked one at a time). `forge test`: 52. Worker tests: 20, and the
store was run again under `wrangler dev`.

## Codex r4 (2026-11-11): what changed

Codex r4 ([codex-r4.md](codex-r4.md)) found r3 #1 (stranded round), #4 and #8 fixed, #2 and #3 partly fixed,
and two new issues, verdict CHANGES.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 major (r3 #2 rest) | The filler can still choose which 10 s band to fill in; a band with no print has no price | **Kept by design, with reasons in spec 5.1.** Choosing the band is choosing when to fill: the price is still the market's at that time, the spread is capped and shown up front, and the jump latch bounds the move from the start. A settlement time fixed at the start would give the filler an hour-long option on an aging price, which is worse. A quiet band is followed by one with a price; the e2e filler tries the next band | `test_pullFeedSettlesOnTheFirstPrintAfterASetTime` now covers a quiet band and the next band filling |
| 2 major (new) | Anyone can cancel a healthy round just under 10% by replacing it, daily | The round records its last pledge of at least 0.1% of target (`lastPledgeAt`). Replacement needs under 10% pledged **and** a day with no such pledge. A round still gathering pledges cannot be cancelled; dust pledges do not keep a stalled one | `test_aRoundStillGatheringPledgesIsNotReplaced` (fails without either part) |
| 3 major (r3 #3 rest) | Nonce rows are bounded by time, not by count | Stored nonces are capped at 200,000 (count kept in a row; pruning subtracts). Past the cap, a wallet new to a stock gets 503 | "stored nonces are capped, and pruning frees room" |
| 4 major (new) | A ticker rename leaves totals behind under the old ticker | Totals are keyed by token address and carry its current ticker | "totals follow the token, so a renamed ticker leaves nothing behind" |
| 5 minor (new) | The page's `swapGate` ignores the issuer registry | `swapGate` reads it and shows why trading is stopped, as the hook does | (page) |

On testnet tUSDC is free to mint, so no rule here costs a griefer money; on mainnet the minimum target and
real USDC do. `forge test`: 53. Worker tests: 22.

## Codex r5 (2026-11-11): what changed

Codex r5 ([codex-r5.md](codex-r5.md)) accepted the band-selection argument (r4 #1), found r4 #3 and #5
fixed, and verdict CHANGES on three points.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 blocker | A 0.1%-a-day top-up keeps a round "active" for 30 days, then the squatter opens the next one | The activity rule is gone. An Open round a day old is replaceable when it is **behind pace**: under half the pledges a steady climb to the target by the deadline would have now. Holding a ticker means keeping a growing share of the target locked, and reaching the target makes the round Funded, where anyone may run its auctions. A round on pace is never cancelled, whatever the size of its pledges | `test_aRoundMustKeepPaceToHoldItsTicker` (a healthy round of many small pledges is kept for three days, then replaced when it stalls; a 0.1%-a-day squatter is replaced a day in, and refunds); `test_roundsCannotSquatATicker` |
| 2 major | The board keeps a renamed ticker until each signer posts again; a reassigned ticker merges two tokens | The store returns totals by token; the Worker names them from the current snapshot and drops tokens no longer in it | "the board names totals by the current snapshot: a rename or a reassigned ticker shows at once" |
| 3 minor | The e2e retry covers fill, not startAuction | One wrapper (`priced`) retries both, up to three bands, for pull listings | - |

`forge test`: 53 (pace rule: making it always true or "unpledged only" fails 2 tests each). Worker tests: 22.
