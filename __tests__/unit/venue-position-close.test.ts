import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { isManualCloseAtPrice, matchVenuePositionClose, normalizeVenuePositionHistory, ownTriggerPrices, venueCloseSettlement } from "@/lib/venue-position-close"

// Real X02 demo values: WLDUSDT short, closed by hand at 0.5313.
const venueRow = { positionId: "2103961508774940674", symbol: "WLD-USDT", positionSide: "SHORT", openTime: 1790458488000, updateTime: 1790460606000,
  avgPrice: "0.5299", avgClosePrice: "0.5313", realisedProfit: "-123.1222", netProfit: "-155.0505", positionAmt: "85616.886", closePositionAmt: "85616.886" }
const row = { id: "r", symbol: "WLDUSDT", direction: "short", executedQuantity: "84921.683", averageExecutionPrice: "0.5298",
  createdAt: "1790458495730", closedAt: "1790460610260", entryTradingFee: "0.008766", stopLoss: "1.2", takeProfit: "1.46",
  stopLossPrice: "0", takeProfitPrice: "0",
  progression: JSON.stringify([{ step: "update_sl_tp", details: "[row_exact_guard] SL 1.2% → 0.536100 (1) | TP 1.46% → 0.522100 (2)" }]) }

describe("a position closed without our own order is settled from the venue's position history", () => {
  const closes = normalizeVenuePositionHistory([venueRow])
  test("the production close matches the row", () => {
    expect(matchVenuePositionClose(row, closes)?.positionId).toBe("2103961508774940674")
  })
  test("the row is booked at the venue's close price with its prorated costs, not at 0", () => {
    const st = venueCloseSettlement(row, closes[0])
    expect(st.averageFillPrice).toBe(0.5313)
    expect(st.filledQuantity).toBeCloseTo(84921.683, 6)
    expect(st.grossRealizedPnl).toBeCloseTo((0.5298 - 0.5313) * 84921.683, 6)
    const costShare = (-123.1222 - -155.0505) * (84921.683 / 85616.886)
    expect(st.tradingFee).toBeCloseTo(costShare - 0.008766, 6)
  })
  test("two venue closes close together are ambiguous and nothing is booked", () => {
    const twin = normalizeVenuePositionHistory([venueRow, { ...venueRow, positionId: "other", updateTime: 1790460630000 }])
    expect(matchVenuePositionClose(row, twin)).toBeNull()
  })
  test("a venue close of a smaller quantity or the other side never matches", () => {
    expect(matchVenuePositionClose(row, normalizeVenuePositionHistory([{ ...venueRow, closePositionAmt: "100", positionAmt: "100" }]))).toBeNull()
    expect(matchVenuePositionClose(row, normalizeVenuePositionHistory([{ ...venueRow, positionSide: "LONG" }]))).toBeNull()
  })
})

describe("manual or own trigger", () => {
  test("the production exit is far from every armed trigger: closed by hand", () => {
    expect(ownTriggerPrices(row)).toEqual(expect.arrayContaining([0.5361, 0.5221]))
    expect(isManualCloseAtPrice(row, 0.5313)).toBe(true)
  })
  test("an exit at the armed stop or take profit is ours", () => {
    expect(isManualCloseAtPrice(row, 0.5362)).toBe(false)
    expect(isManualCloseAtPrice(row, 0.5222)).toBe(false)
  })
  test("an exit at a trailed stop recorded only in the history is ours, not manual", () => {
    const trailed = { ...row, progression: JSON.stringify([
      { step: "update_sl_tp", details: "SL 1.2% → 0.536100 (1) | TP 1.46% → 0.522100 (2)" },
      { step: "update_sl_tp", details: "[trailing] SL 0.3% → 0.531400 (3)" },
    ]) }
    expect(isManualCloseAtPrice(trailed, 0.5313)).toBe(false)
  })
  test("no known trigger: unknown, never guessed as manual", () => {
    expect(isManualCloseAtPrice({ ...row, stopLoss: "0", takeProfit: "0", progression: "[]" }, 0.5313)).toBeNull()
  })
})

describe("wiring", () => {
  const cron = readFileSync(resolve(process.cwd(), "app/api/cron/close-accounting/route.ts"), "utf8")
  const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  test("externally closed rows reach the cron and fall back to the venue position history", () => {
    expect(cron).toContain("if (!externallyClosed && !String(closeOrderId")
    expect(cron).toContain('realizedPnlSource: "venue_position_history"')
  })
  test("the cron keeps a manual close blocked for a week and releases a close at our own trigger", () => {
    expect(cron).toContain("{ EX: MANUAL_CLOSE_SUPPRESS_SECONDS }")
    expect(cron).toContain("} else if (manual === false) {")
  })
  test("every external close holds the signal back provisionally until it is classified", () => {
    expect(live).toContain("{ NX: true, EX: PROVISIONAL_EXTERNAL_CLOSE_HOLD_SECONDS }")
  })
})
