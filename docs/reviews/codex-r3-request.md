You are Codex, reviewing work written by Claude (a different model). Do not defer to it; your job is to break it.

This is round 3. Round 2 is docs/reviews/codex-r2.md (your findings) and the "r2" section of
docs/reviews/codex-r1-response.md (what Claude says it changed). Repo: a review worktree, branch
stock-aware-pool, spec docs/specs/001-summon.md (r4). Not deployed yet; deployments/84532.json is the older
main deployment.

1. For each round-2 finding still open after round 2 (1 rest, 3 rest, 8, 9, 10, 11), check the fix in the
   code, not the response's description: is the failure scenario now impossible, and does the named test
   actually fail without the fix? Say "fixed", "partly fixed" or "not fixed", with file:line.
2. Look for anything the fixes broke or newly opened, in particular:
   - SummonFactory: round terms are capped at 30 days, and an Open round with no pledges can be replaced one
     day after it opened. Can a griefer still block a ticker cheaply (e.g. a dust pledge, or replacing a
     round someone is about to pledge to), and can replacement strand anyone's funds?
   - Per-listing maxAge (Pyth 5 s, guard 60 s): can a fair Pyth fill still stall, and is the remaining
     choice window acceptable?
   - web/worker/store.ts: intents now live in one SQLite-backed Durable Object. Is every check-and-write
     really free of awaits between the check and the write? Is the alarm sweep correct (nonces kept,
     counters dropped)? Is the paged demand export (`after`/`next`) complete and free of duplicates? Is one
     global object an acceptable bottleneck for this use, and is anything still unbounded?
3. Then a fresh pass over the whole branch for anything earlier rounds missed, highest severity first.

`forge test` passes 51 tests; `cd web && npm run test:worker` passes 17. The worker tests use node:sqlite in
place of ctx.storage.sql; it was also checked once under `wrangler dev` (workerd).

Output: numbered findings, each with severity (blocker/major/minor), file:line, a concrete failure scenario,
and a proposed fix. Last line exactly "VERDICT: APPROVE" or "VERDICT: CHANGES". Do not edit files.
