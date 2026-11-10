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
| 3 (rest), 9 major | Nonce check and totals are not atomic under KV; every read lists every record | Next: move intents to a Durable Object, which serializes writes per stock, keeps live totals, and expires records. Until then the Worker says its limits are a brake | - |
