You are Codex, reviewing work written by Claude (a different model). Do not defer to it; your job is to break it.

This is round 4. Round 3 is docs/reviews/codex-r3.md (your findings) and the "Codex r3" section of
docs/reviews/codex-r1-response.md (what Claude says it changed). Repo: a review worktree, branch
stock-aware-pool, spec docs/specs/001-summon.md (r5). Not deployed yet.

1. For each round-3 finding (1, 2, 3, 4, 8), check the fix in the code, not the response's description: is
   the failure scenario now impossible, and does the named test fail without the fix? Say "fixed",
   "partly fixed" or "not fixed", with file:line.
2. Look for anything the fixes broke or newly opened, in particular:
   - SummonRound.settleTime and the pull path through lib/hl-price-guard/src/PythRef.sol readFirstAfter
     (Pyth's parsePriceFeedUpdatesUnique). Check the window arithmetic, the fee and ETH refund, the
     PriceNotAfterStart interaction, and whether a filler can still choose the price. Is 10 s workable on
     Base (2 s blocks)? The test mock in test/SummonRound.t.sol models Pyth's uniqueness rule; is it
     faithful?
   - SummonFactory replacement: cancel() on the old round, the 10% rule, and whether a griefer can now
     cancel a healthy round, or strand funds.
   - web/worker/store.ts: totals kept as rows and adjusted on replace and sweep; the nonce-from-signing-time
     rule in index.ts and nonce pruning; the live cap. Can totals drift from the intents?
3. A fresh pass over the whole branch for anything earlier rounds missed, highest severity first.

`forge test` passes 52; `cd web && npm run test:worker` passes 20.

Output: numbered findings, each with severity (blocker/major/minor), file:line, a concrete failure scenario,
and a proposed fix. Last line exactly "VERDICT: APPROVE" or "VERDICT: CHANGES". Do not edit files.
