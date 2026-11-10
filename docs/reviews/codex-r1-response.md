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
