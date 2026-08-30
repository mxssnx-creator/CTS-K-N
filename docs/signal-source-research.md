# Signal indication: public-source research and runtime contract

Last audited: 2026-07-26

## Scope

`Signal` does not trust or scrape third-party trading calls. It is an
independent indication engine that reads documented public OHLCV endpoints and
calculates the short-horizon direction, confidence, stop loss, and take profit
locally. No source request contains an API key, account identifier, signature,
or order operation.

All 36 sources are enabled by default: 35 crypto feeds and one official
InstaForex Charts M1 feed. Each is isolated by timeout, circuit breaker, schema
validation, deduplicated timestamps, and a bounded cache. The source request
interval is configurable in seconds, defaults to 30, and is normalized
server-side to a hard minimum of 30 seconds. The same interval controls both
source-fetch reuse and complete Signal-cycle reuse, so faster engine ticks
cannot produce faster outbound requests. Legacy millisecond cache settings are
migrated through the same minimum. Crypto and Forex symbols are routed only to
their compatible asset-class sources; Forex uses an explicit one-source broker
quorum. Priority 1
contains the liquid perpetual core, priority 2 broadens derivatives and venue
agreement, and priority 3 adds geographically independent spot/aggregator
confirmation. The default request budget keeps four liquid core venues in every
cycle and rotates complete priority-ordered pages through the remaining
compatible feeds. This reaches every enabled source in bounded cycles without
turning each symbol tick into 35 simultaneous requests. Unsupported
symbol/source pairs are skipped rather than treated as negative signals.

## Audited source inventory

| # | Priority | Source | Market | Public 1-minute endpoint | Normalization notes | Official reference |
|---:|:---:|---|---|---|---|---|
| 1 | 1 | BingX Swap | Perpetual | `GET /openApi/swap/v3/quote/klines` | Object rows; compatible array fallback | [BingX API](https://bingx-api.github.io/docs/#/swapV2/market-api.html) |
| 2 | 1 | Binance USD-M | Perpetual | `GET /fapi/v1/klines` | Array OHLCV | [Binance Developers](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data) |
| 3 | 1 | Bybit Linear | Perpetual | `GET /v5/market/kline` | Reverse-order array rows normalized by timestamp | [Bybit API](https://bybit-exchange.github.io/docs/v5/market/kline) |
| 4 | 1 | OKX Swap | Perpetual | `GET /api/v5/market/candles` | Array OHLCV | [OKX API](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks) |
| 5 | 1 | KuCoin Futures | Futures | `GET /api/v1/kline/query` | Millisecond request window; KuCoin field order | [KuCoin API](https://www.kucoin.com/docs-new/rest/futures-trading/market-data/get-klines) |
| 6 | 1 | Gate.io USDT Futures | Perpetual | `GET /api/v4/futures/usdt/candlesticks` | Current object rows plus documented-compatible legacy arrays | [Gate API v4](https://www.gate.com/docs/developers/apiv4/en/#futures-candlesticks) |
| 7 | 1 | Bitget USDT Futures | Perpetual | `GET /api/v3/market/candles` | UTA `USDT-FUTURES` market array OHLCV | [Bitget API](https://www.bitget.com/api-doc/uta/public/Get-Candle-Data) |
| 8 | 1 | MEXC Contract | Perpetual | `GET /api/v1/contract/kline/{symbol}` | Parallel arrays; second-based request window | [MEXC Contract API](https://mexcdevelop.github.io/apidocs/contract_v1_en/#k-line-data) |
| 9 | 2 | HTX Linear Swap | Perpetual | `GET /linear-swap-ex/market/history/kline` | Object rows; second timestamps | [HTX API](https://huobiapi.github.io/docs/usdt_swap/v1/en/#get-kline-data) |
| 10 | 2 | CoinEx Futures | Perpetual | `GET /v2/futures/kline` | Object rows | [CoinEx API](https://docs.coinex.com/api/v2/futures/market/http/list-market-kline) |
| 11 | 2 | Phemex Perpetual | Perpetual | `GET /exchange/public/md/v2/kline/last` | Phemex array positions | [Phemex API](https://phemex-docs.github.io/#query-kline) |
| 12 | 2 | BitMart Futures | Perpetual | `GET /contract/public/kline` | Object rows; required second-based start/end | [BitMart Futures API](https://developer-pro.bitmart.com/en/futuresv2/#get-k-line) |
| 13 | 2 | BitMEX Perpetual | Perpetual | `GET /api/v1/trade/bucketed` | ISO timestamp object rows | [BitMEX API](https://docs.bitmex.com/api-explorer/get-trade-bucketed) |
| 14 | 2 | Poloniex | Spot | `GET /markets/{symbol}/candles` | Poloniex 13-field candle order | [Poloniex API](https://api-docs.poloniex.com/spot/api/public/market-data#candles) |
| 15 | 2 | AscendEX | Spot | `GET /api/pro/v1/barhist` | Nested object row | [AscendEX API](https://ascendex.github.io/ascendex-pro-api/#historical-bar-data) |
| 16 | 2 | Bitfinex | Spot | `GET /v2/candles/trade:1m:{symbol}/hist` | Bitfinex MTS/OHLCV order | [Bitfinex API](https://docs.bitfinex.com/reference/rest-public-candles) |
| 17 | 2 | Kraken Futures | Futures | `GET /api/charts/v1/trade/{symbol}/1m` | Restricted to listed supported bases | [Kraken Futures API](https://docs.kraken.com/api/docs/futures-api/charts/candles/) |
| 18 | 2 | Deribit | Perpetual | `GET /api/v2/public/get_tradingview_chart_data` | Parallel arrays; restricted supported bases | [Deribit API](https://docs.deribit.com/api-reference/market-data/public-get_tradingview_chart_data) |
| 19 | 2 | Crypto.com Exchange | Perpetual | `GET /exchange/v1/public/get-candlestick` | Compact-key object rows | [Crypto.com API](https://exchange-developer.crypto.com/exchange/v1/rest-ws/index.html#public-get-candlestick) |
| 20 | 2 | dYdX Indexer | Perpetual | `GET /v4/candles/perpetualMarkets/{market}` | ISO timestamp object rows | [dYdX Indexer](https://docs.dydx.xyz/indexer-client/http#get-candles) |
| 21 | 2 | Hyperliquid | Perpetual | `POST /info` with `candleSnapshot` | Public JSON request; compact-key objects | [Hyperliquid API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) |
| 22 | 2 | WOO X | Perpetual | `GET /v1/public/kline` | Millisecond start/end window, bounded `size`, object rows | [WOO X API](https://docs.woox.io/#kline) |
| 23 | 2 | BloFin Futures | Perpetual | `GET /api/v1/market/candles` | Array OHLCV | [BloFin API](https://docs.blofin.com/index.html#get-candlesticks) |
| 24 | 3 | LBank | Spot | `GET /v2/kline.do` | Required second-based `time`; array OHLCV | [LBank API](https://www.lbank.com/en-US/docs/index.html) |
| 25 | 3 | XT.COM | Spot | `GET /v4/public/kline` | Compact-key object rows | [XT API](https://doc.xt.com/) |
| 26 | 3 | Deepcoin | Perpetual | `GET /deepcoin/market/candles` | Array OHLCV | [Deepcoin API](https://www.deepcoin.com/docs/DeepCoinMarket/candles) |
| 27 | 3 | Backpack Exchange | Perpetual | `GET /api/v1/klines` | Second-based start/end; object rows | [Backpack API](https://docs.backpack.exchange/#tag/Markets/operation/get_klines) |
| 28 | 3 | Coinbase Exchange | Spot | `GET /products/{product}/candles` | Coinbase candle order | [Coinbase Exchange API](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles) |
| 29 | 3 | Kraken Spot | Spot | `GET /0/public/OHLC` | Dynamic pair result key | [Kraken Spot API](https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/) |
| 30 | 3 | Bitstamp | Spot | `GET /api/v2/ohlc/{pair}/` | Nested object rows | [Bitstamp API](https://www.bitstamp.net/api/#tag/Market-info/operation/GetOHLCData) |
| 31 | 3 | Gemini | Spot | `GET /v2/candles/{symbol}/1m` | Gemini USD pair and array rows | [Gemini API](https://docs.gemini.com/rest/market-data#get-candles) |
| 32 | 3 | Upbit | Spot | `GET /v1/candles/minutes/1` | Region market object rows | [Upbit API](https://global-docs.upbit.com/reference/list-candles-minutes) |
| 33 | 3 | Bithumb | Spot | `GET /public/candlestick/{pair}/1m` | Count capped at 200; Bithumb array order | [Bithumb API](https://apidocs.bithumb.com/v1.2.0/reference/candlestick-rest-api) |
| 34 | 3 | Bitkub | Spot | `GET /tradingview/history` | Parallel arrays; second-based from/to | [Bitkub official API repository](https://github.com/bitkub/bitkub-official-api-docs/blob/master/restful-api.md) |
| 35 | 3 | CryptoCompare | Aggregator | `GET /data/v2/histominute` | Nested object rows; bounded free public request | [CryptoCompare API](https://min-api.cryptocompare.com/documentation?key=Historical&cat=dataHistominute) |
| 36 | 1 | InstaForex Charts | Forex | `POST /soapservices/charts.svc` (`GetCharts`, `M1`) | SOAP/XML OHLC rows; canonical six-character FX pairs; read-only public history | [InstaForex Charts API](https://www.instaforex.com/partners/en/api_charts/) |

## Signal and risk selection

Each valid feed independently produces a one-minute candidate from EMA
momentum, RSI, candle impulse, volume confirmation, and ATR. Invalid,
insufficient, stale, contradictory, or volatility-clipped data produces no
candidate. The consensus:

1. chooses the weighted direction only after the configured source-count and
   agreement thresholds are met;
2. ranks same-direction candidates by stop-loss distance;
3. derives the stop primarily from the lower-stop half while retaining every
   agreeing source for attribution;
4. rejects a candidate rather than clipping it into an invalid risk/reward
   relationship; and
5. includes estimated round-trip costs when deriving the effective take profit.

The final SL/TP percentages are attached to the Signal lineage and become
quantity-independent reduce-only control orders in Live/Paper execution.

## Performance and Block isolation

- Source performance is a rolling ring of the latest 15 **closed** realized
  results for each `source × symbol × long|short`. Open positions never enter
  PF or PnL windows.
- A lane with negative rolling PnL is auto-disabled for its configured cooldown;
  a source can remain usable for other symbols or the opposite direction.
- Signal Block lanes are independent for
  `source × symbol × long`, `source × symbol × short`, and
  `source × symbol × overall`, with multiple Block counts.
- Real strategy Block lanes independently calculate
  `strategy × symbol × long|short|overall`.
- Every virtual lane retains results, difference, PF, and attribution. Physical
  execution is consolidated only per `connection × symbol × direction` to one
  absolute target, so 35 agreeing source lanes cannot multiply exchange volume
  35 times.
- With base volume \(B\), ratio \(R\), and eligible count \(N\), the absolute
  Block target is \(B + B \times R \times N\). Execution submits only
  `target − confirmed quantity`, including after partial fills or restarts.
- A cold enabled Block has no private progression gate and can act immediately
  from the matching normal closed-position PF. Once its own result window is
  mature, new Block execution is rejected when `Block PF < matching normal PF`.
- Disabling Block suppresses new evaluations/emissions, but internal
  calculation, result/difference/PF statistics, and reconciliation of existing
  exposure continue.

## Verification boundary

Fixture tests cover all 36 documented request/response shapes, timestamp units,
pair formats, malformed rows, and ordering. The read-only network probe imports
only this registry and reports `authenticatedRequests: 0` and
`orderEndpointsCalled: 0`. A deployment can use `pnpm test:signal-sources` to
check outbound reachability; endpoint reachability is separate from adapter
correctness because CI/sandbox egress policies may block exchange domains.
