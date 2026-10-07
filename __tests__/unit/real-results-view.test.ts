import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildRealResultsView, type ResultBookResponse } from "@/components/dashboard/real-results-view"

const book = (overrides: Record<string, unknown> = {}) => ({
  settled: 40, accountingPending: 2, wins: 26, losses: 14, net: 12.5, fees: 1.2,
  profitFactor: 1.84, winRate: 65,
  hours: { active: 20, profitable: 14, losing: 6, profitableShare: 70, closesPerActiveHour: 2 },
  ...overrides,
})
const response = (windows: Record<string, unknown>, ready = true) => ({ ready, coverage: { entries: 1, remaining: 7 }, windows } as ResultBookResponse)
const values = (view: ReturnType<typeof buildRealResultsView>) =>
  view.state === "ready" ? Object.fromEntries(view.metrics.map((metric) => [metric.label, metric.value])) : {}

describe("real results view", () => {
  test("trades, PF, net and the profitable-hour share of the chosen window", () => {
    const view = buildRealResultsView(response({ "24h": book(), all: book({ settled: 900 }) }), null, "24h")
    expect(values(view)).toEqual({
      Trades: "40", PF: "1.84", "Win rate": "65.0%", "Net USDT": "+12.50",
      "Profitable hours": "14/20", "Hour share": "70%", "Closes / active h": "2.0", "Accounting pending": "2",
    })
    expect(values(buildRealResultsView(response({ "24h": book(), all: book({ settled: 900 }) }), null, "all")).Trades).toBe("900")
  })

  test("a window without a losing close has an infinite PF, not a blank", () => {
    expect(values(buildRealResultsView(response({ "24h": book({ losses: 0, profitFactor: null }) }), null, "24h")).PF).toBe("∞")
  })

  test("no settled close says why instead of rendering zeros", () => {
    expect(buildRealResultsView(response({ "24h": book({ settled: 0, accountingPending: 3 }) }, false), null, "24h")).toEqual({
      state: "empty",
      message: "No settled real close in this window · 3 closed, accounting pending · ledger still building (7 rows left).",
    })
    expect(buildRealResultsView(null, null, "24h").state).toBe("loading")
    expect(buildRealResultsView(null, "HTTP 500", "24h")).toEqual({ state: "error", message: "Results ledger HTTP 500." })
  })

  test("the card is mounted in the statistics overview", () => {
    const source = readFileSync(join(process.cwd(), "components/dashboard/statistics-overview-v2.tsx"), "utf8")
    expect(source).toContain("<RealResultsCard connectionId={connectionId}")
  })
})
