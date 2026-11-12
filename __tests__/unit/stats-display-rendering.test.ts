import { spawnSync } from "node:child_process"

// Use the application's TSX loader so this verifies actual rendered components
// with the same JSX settings as Next, without changing Jest's project config.
let markup: Record<string, string>
beforeAll(() => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {LiveOverviewCompact} from './components/live-trading/live-overview-compact.tsx';
    import {SimulatedBookCard} from './components/stats/simulated-book-panel.tsx';
    import {computePositionBookStats, simulatedBookForDisplay} from './lib/position-book-stats.ts';
    globalThis.React = React;
    const render = (type, props) => renderToStaticMarkup(React.createElement(type, props));
    const book = computePositionBookStats([
      {status:'simulated', symbol:'BCHUSDT', executedQuantity:1, entryPrice:100, stopLossOrderId:'sim-sl'},
      {status:'pending', executionMode:'simulation', executedQuantity:0, quantity:2},
      {status:'closed', executionMode:'simulation', executedQuantity:1, totalExecutedQuantity:1, realizedPnL:6},
      {status:'closed', executionMode:'simulation', executedQuantity:1, totalExecutedQuantity:1, realizedPnL:-2},
    ]);
    const account = {openPositions:0, openOrders:0, positionsDataAvailable:true, ordersDataAvailable:true,
      balance:{total:100, equity:123, available:87, currency:'USDT', dataAvailable:true}};
    console.log(JSON.stringify({
      unavailable:render(LiveOverviewCompact,{account:null, positions:[], positionsAvailable:false, analytics:null}),
      exchange:render(LiveOverviewCompact,{account, positions:[], analytics:null}),
      legacyBalance:render(LiveOverviewCompact,{account:{...account,balance:{...account.balance,equityDataAvailable:false,availableDataAvailable:false}},positions:[],analytics:null}),
      simulated:render(SimulatedBookCard,{book:simulatedBookForDisplay(book,{}), stale:true}),
      valued:render(SimulatedBookCard,{book}),
    }));
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 })
  if (result.status !== 0) throw new Error(result.stderr || String(result.error))
  markup = JSON.parse(result.stdout.trim())
})

test("missing snapshots and history render as unavailable instead of zero results", () => {
  expect(markup.unavailable).toContain("Order snapshot unavailable")
  expect(markup.unavailable).toContain("Position snapshot unavailable")
  expect(markup.unavailable).toContain("History unavailable")
  expect(markup.unavailable).not.toContain("0 trades")
  expect(markup.unavailable).not.toContain("0W / 0L")
})

test("exchange equity and available balance use the authoritative account fields", () => {
  expect(markup.exchange).toContain("123.00")
  expect(markup.exchange).toContain("Exchange account equity")
  expect(markup.exchange).toContain("87")
  expect(markup.exchange).toContain("Open positions")
  expect(markup.exchange).toContain("Open orders")
})

test("a wallet-only cache shows unavailable equity and free margin", () => {
  expect(markup.legacyBalance).toContain("Equity snapshot unavailable")
  expect(markup.legacyBalance).toContain("Available margin unavailable")
  expect(markup.legacyBalance).not.toContain("123.00")
  expect(markup.legacyBalance).not.toContain("Available $87")
})

test("suppressed paper valuations retain visible positions, orders and stale status", () => {
  expect(markup.simulated).toContain('data-testid="sim-card"')
  expect(markup.simulated).toContain("Tracked control orders")
  expect(markup.simulated).toContain("Pending entry intents")
  expect(markup.simulated).toContain("valuation is unavailable")
  expect(markup.simulated).toContain("showing the last simulated snapshot")
  expect(markup.simulated).not.toContain('data-testid="sim-net"')
  expect(markup.simulated).not.toContain('data-testid="sim-pf"')
})

test("a valued simulated book renders its independent after-cost profit factor", () => {
  expect(markup.valued).toContain('data-testid="sim-pf">3.00')
  expect(markup.valued).toContain('data-testid="sim-net">$4.00')
})
