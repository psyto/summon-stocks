# Summon

**Backers bring a stock onto Base.**

Coinbase has registered 298 tokenized stocks (B20) on Base. 227 of them have never been minted, and some
that were minted (DJT, AMC, GME) have no pool to trade in. Summon lets a stock's backers call it onchain:

1. Backers commit USDC to a ticker, up to a target.
2. When the target is reached and the market is open, anyone holding the stock token fills the round at a
   live reference price, through a capped spread auction (at most 1%, shown before anyone commits). The
   price comes from Pyth. On testnet it can instead come from a quote the guard posts (see "Price source").
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
| Round, factory, pool hook (`src/SummonRound.sol`, `SummonFactory.sol`, `SummonHook.sol`) | done, 33 tests: each fill condition failing alone, pledge cap, withdraw rules, expiry and refunds, claims under transfer policies, LP unwind, pool initialization restricted to the round, the guard price feed. Removing any of 8 checks makes a test fail |
| Base Sepolia deployment | done 2026-11-07: factory, hook, registries and a real B20 demo stock (see below) |
| Guard (`ts/guard.ts`) | done: Nasdaq halts and, for guard pricing, the quote. It writes nothing while the market is closed |
| End-to-end fill on Base Sepolia (`ts/e2e.ts`) | scripted; first run when the market opens (weekdays 09:30–16:00 ET) |
| UI: ticker board, round page, intent signing | next |


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

## Run it on Base Sepolia

Everything runs on Base Sepolia with testnet funds. The demo stock is a real B20 Asset, the same standard
as Coinbase's tokenized stocks, created through the B20 factory precompile. Its symbol is `sGME`, it
tracks GME's Pyth price, and it has no value.

```sh
npm install
# .env: DEMO_MNEMONIC (testnet wallets: 0 operator, 1-3 backers, 4 filler); PYTH_API_KEY only for
#       PRICE_SOURCE=pyth (Pyth Terminal, app.pyth.com: Hermes needs a key since 2026-08-26)
set -a; . ./.env; set +a                       # so forge sees DEMO_MNEMONIC
npm run fund                                   # operator -> demo wallets, for gas
DRY_RUN=1 npm run create-stock                 # simulate; needs no funds
npm run create-stock                           # prints STOCK_TOKEN
STOCK_TOKEN=0x… PRICE_ID=0x6f9cd89ef1b7fd39f667101a91ad578b6c6ace4579d5f7f285a4b06aa4504be6 \
  PRICE_SOURCE=guard forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --mnemonics "$DEMO_MNEMONIC"
npm run guard                                  # keep running: halts (and, for guard pricing, the quote)
npm run e2e                                    # weekdays 09:30-16:00 ET
```

**Price source.** Each listed token is bound to one feed, chosen by the factory owner:
- `PRICE_SOURCE=pyth`: Pyth Core, with update data from Hermes. This is the design Summon is built for.
  Since 2026-08-26 Hermes needs an API key, which must stay on a server.
- `PRICE_SOURCE=guard` (the default on testnet): `GuardPriceFeed`, which has Pyth's read interface. The
  demo guard posts GME's quote there while GME is open and not halted. The quote comes from Nasdaq.com's
  public endpoint, which is undocumented and possibly delayed. Treat it as demo data only:
  - Nasdaq's terms for its other products forbid automated copying, so check the site's terms before you
    run the guard;
  - a delayed price would let a filler fill only when the delay favors them, so it must never back
    real funds.

  The guard key already decides whether the market is open. With guard pricing, it also sets the price.

Both sources go through the same checks in the round: the price is at most 60 s old, its confidence is
within 50 bp, and it has not jumped more than 3% since the auction started. A guard that stops posting
therefore stops fills.

**Deployed on Base Sepolia** (2026-11-07, priced from the guard feed; addresses also in
`deployments/84532.json`):

| Contract | Address |
|---|---|
| SummonFactory | [`0xe0594Aa1c935306F711e4542504b8E84b06Bc691`](https://sepolia.basescan.org/address/0xe0594Aa1c935306F711e4542504b8E84b06Bc691) |
| SummonHook | [`0xE1e98787dcC2b0093B33123bD51F15301Af82000`](https://sepolia.basescan.org/address/0xE1e98787dcC2b0093B33123bD51F15301Af82000) |
| Demo stock sGME (B20 Asset) | [`0xB20000000000000000000065bC5A9eB6218d9E68`](https://sepolia.basescan.org/address/0xB20000000000000000000065bC5A9eB6218d9E68) |
| GuardPriceFeed (testnet) | [`0x7D875Ee915a12c0CF6DD206f4CA37181ca0a75EC`](https://sepolia.basescan.org/address/0x7D875Ee915a12c0CF6DD206f4CA37181ca0a75EC) |
| MarketStateRegistry | [`0x73c0114eE2ba4e70e03059B2C26c0888CB21C752`](https://sepolia.basescan.org/address/0x73c0114eE2ba4e70e03059B2C26c0888CB21C752) |
| DemoOracleRegistry (testnet) | [`0x164B4e102A1F668aFfbC0E2019e6287A50e2812D`](https://sepolia.basescan.org/address/0x164B4e102A1F668aFfbC0E2019e6287A50e2812D) |
| TestUSDC (testnet) | [`0xdAA34F28c1D0Fd3c6a5B52a7B41505D12Dd4D109`](https://sepolia.basescan.org/address/0xdAA34F28c1D0Fd3c6a5B52a7B41505D12Dd4D109) |

The deploy script finds a CREATE2 salt that puts the hook at an address with BEFORE_INITIALIZE as its
only flag. Contracts used on Base Sepolia: Uniswap v4 PoolManager `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`,
Pyth `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729`, and the B20 policy registry precompile
`0x8453…0002`. Three contracts exist on testnet only, and all are labelled as such: `TestUSDC`, which
anyone can mint; `DemoOracleRegistry`, which stands in for Coinbase's mainnet oracle registry; and
`GuardPriceFeed`.

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
