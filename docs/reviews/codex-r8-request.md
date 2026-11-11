You are Codex, reviewing work written by Claude (a different model). Do not defer to it; your job is to break it.

This is round 8. Round 7 is docs/reviews/codex-r7.md (your findings) and the "r7" section of
docs/reviews/codex-r1-response.md (what Claude says it changed). Repo: a review worktree, branch
stock-aware-pool, spec docs/specs/001-summon.md (r5, section 2a). Not deployed yet.

1. For round-7 findings 1 and 2, check the fix in the code, not the response's description: is the failure
   scenario now impossible, and does the named test actually fail without the fix? Say "fixed", "partly
   fixed" or "not fixed", with file:line.
2. Look for anything the fixes broke or newly opened, in particular:
   - via_ir = true: does any contract behave differently under IR (the tests now read time with
     vm.getBlockTimestamp(); is any test now vacuous)? Are all contracts under EIP-170 and EIP-3860?
   - MIN_SEED_UNITS in SummonRound (startAuction and fill): with q > qLp >= 1e4, is the 1 bp rounding bound
     right for both the seed's price and the filler's delivery? Can _seed still produce zero liquidity or a
     price off the reference by more than that? Can a round be stuck rather than expire?
3. Then a fresh pass for anything earlier rounds missed, highest severity first. If nothing is blocker or
   major, approve.

`forge test` passes 56; `cd web && npm run test:worker` passes 22.

Output: numbered findings, each with severity (blocker/major/minor), file:line, a concrete failure scenario,
and a proposed fix. Last line exactly "VERDICT: APPROVE" or "VERDICT: CHANGES". Do not edit files.
