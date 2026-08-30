# InstaForex integration

Forex is a first-class market in the application. InstaForex connections use
the broker's published read-only HTTP surfaces:

- Quotes: `https://quotes.instaforex.com/api/quotesTick` and `quotesList`.
- Account balance and open/closed trades: the published Client API.
- Historical candles: the published Charts API (`GetCharts`, M1 and higher).

The published HTTP interfaces do not place, cancel, close, or protect orders.
The REST transport is intentionally read-only. Account reads authenticate with
the documented Client API passkey flow; public quotes do not receive account
secrets. Main, preset, and signal execution gates therefore remain blocked for
this connector; use the data feed for analysis or simulation only.

## Runtime semantics

InstaForex uses lots as its quantity unit. One lot is 10,000 base-currency
units. The default average count is 24. Quotes carry broker bid/ask data and
the observed spread; entry/exit calculations use executable prices and apply
the configured PositionCost buffer and multiplier.

Reports are USD-normalized only when the quote-currency conversion is known.
For cross pairs, the application obtains an independently observed USD quote;
without one it refuses to synthesize USD notional or PnL. This keeps historic
evaluation, live admission, and displayed statistics on the same accounting
basis.
