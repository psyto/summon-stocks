# Summon

**Backers bring a stock onto Base.**

Coinbase has registered 298 tokenized stocks (B20) on Base. 227 of them have never been minted, and some
that were minted (DJT, AMC, GME) have no pool to trade in.

Summon is a primary-market primitive for tokenized stocks. Committed demand becomes a fill and a pool only
when the stock's market conditions hold onchain. The round contract checks them at every auction start and
fill, caps the price, refunds if nothing fills, and is the only thing that can create the stock's pool. It
reads its market data from registries and price feeds. On testnet, the guard key writes those. A stock's
backers call it onchain like this:

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

## Why it matters

- **For issuers:** 227 registered stocks have no supply. A funded Summon round is a demand signal any
  issuer can read: these backers have committed this much USDC to this ticker, and they are waiting for a
  fill.
- **For Base:** stocks reach Base in order of demand. Each one arrives with a pool, and its backers are
  the LPs.
- **For launchpads and apps:** a stock with no pool cannot be paired, routed or lent against. Once a stock
  is summoned, any launchpad can pair against it. BaseStonk's public pair list, for example, has 357 stock
  pairs on Base, and 279 of them show no liquidity, including AMCc, RIVNc and SOFIc (read 2026-11-07 from
  api.basestonk.io). A coin paired with one of those has no pool to route through.
- **For backers:** the worst price is shown before you commit (at most 1% over the reference). If the
  round does not fill, every pledge is refunded.

Built for Base's [Stocks Maxxing](https://www.base.org/stocksmaxxing) season (Programmable Stock Markets
track). **Testnet only (Base Sepolia).** Mainnet data is only read and shown.

## Status

| Part | State |
|---|---|
| Spec ([docs/specs/001-summon.md](docs/specs/001-summon.md)) | r3, after one independent review ([docs/reviews](docs/reviews)). The Codex review of the spec and the code is written up ([docs/reviews/codex-r1-request.md](docs/reviews/codex-r1-request.md)) and runs from 2026-11-10 |
| Price math (`src/SummonPrice.sol`, spec 5.1) | done, with tests: split invariance, dividend multiplier, fuzzed rounding |
| Round, factory, pool hook, swap (`src/SummonRound.sol`, `SummonFactory.sol`, `SummonHook.sol`, `SummonSwap.sol`) | done, 35 tests: each fill condition failing alone, pledge cap, withdraw rules, expiry and refunds, claims under transfer policies, LP unwind, pool initialization restricted to the round, the guard price feed, trading the summoned pool. Removing any of 8 checks makes a test fail |
| Base Sepolia deployment | done 2026-11-07: factory, hook, swap router, registries and five real B20 demo stocks (see below). Rounds: sGME [`0xa799…046D`](https://sepolia.basescan.org/address/0xa799fC499Af97a474D02878fC10fB8B733b1046D) (filled 2026-11-10) and sSOFI (open) [`0xAae4…DbEE`](https://sepolia.basescan.org/address/0xAae40400113c32D8D0345EBad6F781E56ECDDbEE) (both target 300 tUSDC) |
| Guard (`ts/guard.ts`) | done: Nasdaq Trader halts (once a minute) and, for guard pricing, the HIP-3 oracle price from Hyperliquid's chain. It writes nothing while the market is closed. `npm run guard -- --quote GME` prints the price it would post and writes nothing |
| End-to-end fill on Base Sepolia (`ts/e2e.ts`) | **first fill done 2026-11-10 (ET), sGME**: three demo backers pledged 300 tUSDC, the auction started, and the demo filler filled at a $25.115 reference (the HIP-3 oracle price the guard posted), 6 bp under it; the Uniswap v4 pool was seeded and every backer claimed. [pledge](https://sepolia.basescan.org/tx/0x3dbe7c7ad11fdd223ddeab48fbc05393fa85a334a9a2b7ed7054433b7cd7a60c) · [auction start](https://sepolia.basescan.org/tx/0x4b5831f2ca5fc62b8695315ca29670eb433421307826bad32aef927df572bb9a) · [fill](https://sepolia.basescan.org/tx/0xb71b8eb7f4cf16fd1bb060b11247b29741a0caf7151036d79965f09497ffb9eb) · [claim](https://sepolia.basescan.org/tx/0xda9dddb16b677e784f2d4bd6868c5e01fefbd6b699f63f7cc8d36d9e75b3b5dc). It picks up the stock's open round wherever it stands, so pledges made from the web page count. Weekdays 09:30–16:00 ET |
| Web (`web/`) | built 2026-11-07: the register of all 298 stocks; live round pages; signed intents, with a round opening from the register once a demo stock's intents reach $250; trading a summoned pool; a demand export issuers can verify; the US block and per-network limits (8 Worker tests). Runs locally; goes public once the Codex review is addressed |
| Demand from elsewhere | planned (from 2026-11-14): marks on the register for never-minted stocks that already trade elsewhere, by amount, not by listing. Hyperliquid HIP-3 open interest and volume; Robinhood Chain token supply. Display only: fills still price from Pyth. Counts are under "The numbers" |

First use (2026-11-07, with v1 intents; v2 also signs the token address, so that intent is to be signed
again): the author, in their own browser wallet, signed $250 of intent for SOFI. The
register then offered a round, they opened it, got test USDC, pledged 50 and took it back (the round
shows 0 pledged). One fix came out of it: the round page now makes the step you can take the primary
button (get test USDC first, then pledge). The first fill ran from the script on 2026-11-10 (above); a
fill and a trade from the page are next.

Docs:
- [docs/specs/001-summon.md](docs/specs/001-summon.md): the spec (r3)
- [docs/reviews/](docs/reviews): reviews, and the request for the next one
- [docs/design.md](docs/design.md): the web design

## Open question: who fills

Summon gives issuers a demand signal. It does not prove they will act on it. Stocks may sit unissued for
reasons other than demand: each mint has a fixed cost, plus legal and custody work. So the open question is
whether an issuer or authorized participant will fill a funded round. For them a fill is a mint against a
known buyer at the live price plus up to 1%, during market hours, so there is little inventory risk. But a
small round cannot cover a mint's fixed cost.

How Summon handles it:
- **A minimum target.** `SummonFactory.minTarget` is set by the owner (0 on testnet). It will be set from
  issuers' real fixed costs, which have not been asked yet.
- **Intents before money.** Signed intents are free and show whether a ticker could reach that minimum. A
  round opens once they get close, so backers do not lock money in a round that cannot fill.
- **A clean exit.** If nobody fills, every pledge is refunded.

Issuer policies on mainnet: Coinbase's stock tokens (NVDAc, MSTRc, GMEc, checked 2026-11-07) use a
blocklist-style transfer policy (id 5). Secondary transfers are open except to blocked addresses. Summon
checks these policies before every fill and claim.

## The numbers

Reproduce them with `python3 scripts/count_b20.py`. It reads public APIs and needs no keys.

| | 2026-11-07 |
|---|---|
| B20 tokenized stocks registered | 298 |
| minted (supply > 0) | 71 |
| never minted | 227 |
| with a Pyth US equity feed | 213 |
| never minted, with a Pyth feed (Summon can open a round) | 154 |

The same stocks elsewhere (read 2026-11-08 from public sources, no keys). Of the 227 never minted on B20:
- 80 are stock tokens on Robinhood Chain (212 tokens from its `StockFactory`
  `0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046`, chain 4663), including JPM, V, DIS, CRM and UBER;
- 24 trade as perps on Hyperliquid's HIP-3 markets, led by DELL (about $6.3M open interest);
- 164 are listed as xStocks (`api.backed.fi`). Backed lists 1,533 tokens, so a listing alone is not
  evidence of demand.

GME shows the gap on Base itself. Coinbase's GMEc is minted but has no pool, and Backed's older bGME on
Base ([`0x7212…2323`](https://basescan.org/address/0x7212088a11b4d8f6fc90fbb3dfe793b45dd72323)) has a
total supply of 0, while bNVDA has about 7,063.

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
  demo guard posts a stock's price there while it is open and not halted, and only while its round is
  Funded or in its auction. The price is the HIP-3 oracle price of the stock's perp on Hyperliquid
  (GME, RIVN and RDDT on `xyz`, SOFI on `para`; AMC has none, so sAMC cannot fill with guard pricing).
  It is public chain state, read through Hyperliquid's info API with no key. Treat it as demo data only:
  - a HIP-3 deployer sets its own oracle price, so it is not a price to back real funds;
  - until 2026-11-09 the guard read Nasdaq.com's quote endpoint. Nasdaq's terms (nasdaq.com/legal) forbid
    "any process, whether automated or manual, to capture data or content from the Service", so it no
    longer does. The halts still come from Nasdaq Trader's Trade Halt RSS feed, whose own terms allow
    this use (they forbid altering the feed), read at most once a minute as its page asks.

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
| Demo stock sAMC (B20 Asset, tracks AMC) | [`0xb20000000000000000000084246F11C15C326DD9`](https://sepolia.basescan.org/address/0xb20000000000000000000084246F11C15C326DD9) |
| Demo stock sRIVN (B20 Asset, tracks RIVN) | [`0xB2000000000000000000007ad0F0FeF5d2b4A11E`](https://sepolia.basescan.org/address/0xB2000000000000000000007ad0F0FeF5d2b4A11E) |
| Demo stock sSOFI (B20 Asset, tracks SOFI) | [`0xB2000000000000000000006b9fb9a28A08243AC4`](https://sepolia.basescan.org/address/0xB2000000000000000000006b9fb9a28A08243AC4) |
| Demo stock sRDDT (B20 Asset, tracks RDDT) | [`0xb200000000000000000000Ba2c05b1Ca0D438CF8`](https://sepolia.basescan.org/address/0xb200000000000000000000Ba2c05b1Ca0D438CF8) |
| SummonSwap | [`0xbDcD54Ece175f14b1C10DAcb6ffD16dEdB35de3D`](https://sepolia.basescan.org/address/0xbDcD54Ece175f14b1C10DAcb6ffD16dEdB35de3D) |
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

## Web

`web/` is the page and a Cloudflare Worker. The page shows the register of all 298 stocks, each with
its own guilloché seal, and a round page that reads the fill conditions live from Base Sepolia. The
Worker stores signed intents and exports them at `/api/demand`, with signatures, so an issuer can verify the
totals itself. It checks each EIP-712 signature. An intent names the stock by ticker and by its B20
contract address, and the address must match the snapshot: Base's docs say to identify a stock by address,
because its symbol can be changed. The Worker keeps one intent per wallet per stock, and refuses the project's own demo wallets, so the board never counts them. Each network may write 20
intents an hour and add 5 new wallets a day. The page's transactions carry a Base Builder Code (ERC-8021)
once one is registered (`BUILDER_CODE` in `web/src/chain.ts`, empty for now); the demo scripts' do not. The whole site, page and API, is closed to US visitors
(HTTP 451): Coinbase tokenized stocks are not offered to US persons, and projects that enable trading for
US users are out of scope. `npm run test:worker` checks these rules. The design notes are in
[docs/design.md](docs/design.md).

```sh
python3 scripts/snapshot.py        # refresh web/public/b20.json (the Coinbase API has no CORS)
cd web && npm install
npm run build && npx wrangler dev  # page and Worker on http://localhost:8787
```

## Parts used

- [hl-price-guard](https://github.com/fabrknt/hl-price-guard) (pinned at `v0.3.2`): `PythRef` for the
  Pyth read and confidence bound, and `JumpLatch` for the jump guard. Summon needed a Pyth-only staleness
  check, so it was added upstream first (`PythRef.readFresh`), not worked around here.
- [market-state](https://github.com/fabrknt/market-state) (pinned at `v0.2.0`): `MarketStateCheck.requireOpen`
  on every auction start and fill, and the Nasdaq Trader halts guard. Using it here showed the guard did
  not know exchange holidays (Thanksgiving read as open), so `v0.2.0` added NYSE's 2026-2028 holidays and
  13:00 early closes upstream first. The registry fails closed when the
  updater goes quiet. It was extracted from another of our projects as a public part, so that Summon could
  depend on it through a tag. That project now depends on the same tag.
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
