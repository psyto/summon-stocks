# Summon

**Backers bring a stock onto Base.**

Coinbase has registered 298 tokenized stocks (B20) on Base. 227 of them have never been minted, and some
that were minted (DJT, AMC, GME) have no pool to trade in. Summon lets a stock's backers call it onchain:

1. Backers commit USDC to a ticker, up to a target.
2. When the target is reached and the market is open, anyone holding the stock token fills the round at a
   live Pyth reference price, through a capped spread auction (at most 1%, shown before anyone commits).
3. Part of the round seeds a Uniswap v4 pool. The pool can only be created by the round, and the backers
   own the LP position together.
4. A public board ranks which ticker comes next. It uses signed, non-binding intents, and no funds move.

A round fills only when every condition below holds:
- the market is open and the stock is not halted;
- the price is under 60 s old and its confidence interval is narrow;
- no corporate action is pending, i.e. no multiplier change near the fill;
- the token is not paused;
- every transfer policy allows the transfer.

Built for Base's [Stocks Maxxing](https://www.base.org/stocksmaxxing) season (Programmable Stock Markets
track). **Testnet only (Base Sepolia).** Mainnet data is only read and shown.

## Status

| Part | State |
|---|---|
| Spec ([docs/specs/001-summon.md](docs/specs/001-summon.md)) | r3, after one independent review ([docs/reviews](docs/reviews)); Codex review next |
| Price math (`src/SummonPrice.sol`, spec 5.1) | done, with tests: split invariance, dividend multiplier, fuzzed rounding |
| Round, factory, pool hook (`src/SummonRound.sol`, `SummonFactory.sol`, `SummonHook.sol`) | done, 30 tests: each fill condition failing alone, pledge cap, withdraw rules, expiry and refunds, claims under transfer policies, LP unwind, pool initialization restricted to the round. Removing any of 8 checks makes a test fail |
| Sepolia end-to-end, guard, UI, intent board | next (see spec section 10) |

## The numbers

Reproduce them with `python3 scripts/count_b20.py`. It reads public APIs and needs no keys.

| | 2026-11-07 |
|---|---|
| B20 tokenized stocks registered | 298 |
| minted (supply > 0) | 71 |
| never minted | 227 |
| with a Pyth US equity feed | 213 |
| never minted, with a Pyth feed (Summon can open a round) | 154 |

Base's Chainlink equity feeds cover 10 liquid tickers, so Summon prices from Pyth. Pyth gives the
underlying share price, and a B20 token is worth underlying × `multiplier()`.
[`SummonPrice`](src/SummonPrice.sol) applies the multiplier exactly once.

## Quickstart

```sh
git clone --recursive <this repo>
cd summon-stocks
forge test
```

Requires [Foundry](https://getfoundry.sh). The B20 precompiles exist only on Base and Base Sepolia, not on
anvil, so unit tests use mocks and the end-to-end run broadcasts to Base Sepolia.

## Parts used

- [hl-price-guard](https://github.com/fabrknt/hl-price-guard) (pinned at `v0.3.2`): `PythRef` for the
  Pyth read and confidence bound, and `JumpLatch` for the jump guard. Summon needed a Pyth-only staleness
  check, so it was added upstream first (`PythRef.readFresh`), not worked around here.
- [market-state](https://github.com/fabrknt/market-state) (pinned at `v0.1.0`): `MarketStateCheck.requireOpen`
  on every auction start and fill, and the Nasdaq Trader halts guard. The registry fails closed when the
  updater goes quiet. It was extracted from
  another of our projects as a public part, so that Summon could depend on it through a tag.
- [Uniswap v4-core](https://github.com/Uniswap/v4-core) v4.0.0,
  [pyth-sdk-solidity](https://github.com/pyth-network/pyth-sdk-solidity) v2.2.0,
  [base-std](https://github.com/base/base-std) v1.1.0.

## Built during the season

Everything in this repository was written during the Stocks Maxxing season (from 2026-11-07). The parts
listed above existed before it.

## Notes

- Not affiliated with, or endorsed by, Base, Coinbase, Pyth, Uniswap or any listed company.
- Tickers are shown as text only. A Summon round gives backers a token that tracks a stock. It gives no
  shareholder rights, such as voting.
- Coinbase tokenized stocks are not available to US persons. Summon does not serve US users.
- Unaudited. Testnet only. Do not use with real funds.

## License

Apache-2.0
