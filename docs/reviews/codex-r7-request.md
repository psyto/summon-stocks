You are Codex, reviewing work written by Claude (a different model). Do not defer to it; your job is to break it.

This is round 7. Round 6 is docs/reviews/codex-r6.md (your findings) and the "r6" section of
docs/reviews/codex-r1-response.md (what Claude says it changed). Repo: a review worktree, branch
stock-aware-pool, spec docs/specs/001-summon.md (r5, section 2a). Not deployed yet.

1. For each round-6 finding (1, 3, 4), check the fix in the code, not the response's description: is the
   failure scenario now impossible, and does the named test actually fail without the fix? Say "fixed",
   "partly fixed" or "not fixed", with file:line.
2. Look for anything the fixes broke or newly opened, in particular:
   - SummonFactory MIN_TARGET / MAX_TARGET: can _behindPace still overflow or misjudge anywhere in range?
     Does the floor really guarantee a nonzero pool seed for any listed token decimals and price the round
     accepts?
   - SummonRound: the constructor now requires deadline >= now + windowSeconds, and startAuction refuses
     unless now + windowSeconds <= deadline. Any state (Funded, Auction after an unfilled window) that can now
     strand funds or never expire?
   - ts/e2e.ts priced/pythArgs: are the band arithmetic and the waits right on Base's 2 s blocks?
3. Then a fresh pass for anything earlier rounds missed, highest severity first. If nothing is blocker or
   major, approve.

`forge test` passes 55; `cd web && npm run test:worker` passes 22.

Output: numbered findings, each with severity (blocker/major/minor), file:line, a concrete failure scenario,
and a proposed fix. Last line exactly "VERDICT: APPROVE" or "VERDICT: CHANGES". Do not edit files.
