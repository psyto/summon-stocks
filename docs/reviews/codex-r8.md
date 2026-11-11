1. **Blocker — fixed.** `foundry.toml:10`, `test/SummonRound.t.sol:727`

   IR is now the default compiler mode. `forge build --sizes` reports `SummonFactory` at 23,071-byte runtime / 23,905-byte initcode; all emitted contracts are below EIP-170 and EIP-3860. The updated test genuinely detects regression: forcing `FOUNDRY_VIA_IR=false` makes `test_seedLargeEnoughToPrice` fail with factory runtime size 28,109 bytes. The time-test conversion is not vacuous: test code now consistently reads `vm.getBlockTimestamp()` after warps.

   Proposed fix: none; retain the config and size assertion.

2. **Major — fixed.** `src/SummonRound.sol:267`, `src/SummonRound.sol:300-301`, `src/SummonRound.sol:538-542`

   Both auction start and fill reject a seed below 10,000 raw units. Thus the prior 6-decimal/$9m/$10-round case cannot start; it remains Funded and expires/refunds. Without the start gate, `test_seedLargeEnoughToPrice` fails at its explicit expected revert (`test/SummonRound.t.sol:741-742`).

   With the deployed 20% LP split, `q > qLp >= 1e4`: ceiling a seed quantity moves its implied price by `< 1/qLp < 1 bp`, and filler over-delivery is smaller still. The minimum also leaves nonzero seed amounts/liquidity; a later price increase that makes the seed too small only rejects that fill and eventually expires the round.

   Proposed fix: none.

3. **Minor — configurable 50% LP splits invalidate the claimed `q > qLp` invariant.** `src/SummonRound.sol:85-90`, `src/SummonRound.sol:301`; `src/SummonFactory.sol:76-80`

   The shipped deployment uses 20%, but the contracts permit `lpBps = 5000`. For a valid 6-decimal token, $10 target, $23.45 reference, and 3 bp elapsed spread, both sides receive $5: `qLp = 213,220` while `q = 213,156`. `fill()` reverts at line 301 even though `qLp >= 1e4`; every nonzero-spread fill is blocked. The round eventually expires, but its advertised Dutch auction cannot fill normally.

   Proposed fix: constrain LP share to a conservative maximum such as 4,950 bps (which preserves `q > qLp` even at 1% spread and the minimum seed), and add a boundary test.

VERDICT: APPROVE