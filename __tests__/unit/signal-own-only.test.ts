import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  countSignalPositionOrders,
  isSystemOwnSignalRow,
  summarizeSignalCounts,
} from "@/lib/signal-position-policy"
import { clientOrderSystemTypePrefix, connectionTrackingId, systemTrackingPrefix } from "@/lib/system-order-ownership"

const src = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")
const conn = "bingx-x01"
const own = (extra: Record<string, unknown> = {}) => ({
  connectionId: conn,
  system_tracking_id: `${systemTrackingPrefix(conn)}abc`,
  connection_tracking_id: connectionTrackingId(conn),
  ...extra,
})

describe("only the system's own Signal rows count", () => {
  test("a row of this system and connection is own", () => {
    expect(isSystemOwnSignalRow(own(), conn)).toBe(true)
  })
  test("another connection, or another system's tracking id, is provably foreign", () => {
    expect(isSystemOwnSignalRow(own({ connectionId: "bingx-x02" }), conn)).toBe(false)
    expect(isSystemOwnSignalRow(own({ system_tracking_id: "sys-bingx-x02-abc" }), conn)).toBe(false)
    expect(isSystemOwnSignalRow(own({ system_tracking_id: "ctsax1_lmuj192" }), conn)).toBe(false)
    expect(isSystemOwnSignalRow(own({ connection_tracking_id: "conn-bingx-x02" }), conn)).toBe(false)
  })
  test("an older row without the tracking fields is still own: not provable is not foreign", () => {
    expect(isSystemOwnSignalRow({ id: "old-row", symbol: "BTCUSDT" }, conn)).toBe(true)
    expect(isSystemOwnSignalRow({ connectionId: conn }, conn)).toBe(true)
  })
  test("no row or no connection is never own", () => {
    expect(isSystemOwnSignalRow(null, conn)).toBe(false)
    expect(isSystemOwnSignalRow(own(), "")).toBe(false)
  })
})

describe("orders are counted own-only", () => {
  const ours = clientOrderSystemTypePrefix(conn, "signal")
  test("tracked client ids of other systems and bots are not counted", () => {
    const row = own({
      orderId: "E1",
      exchangeData: { clientOrderIds: [
        { clientOrderId: `${ours}slBTC1` },          // this system, typed
        { clientOrderId: "ctsbingxx01tpBTC1muf3o" },  // this system, legacy prefix
        { clientOrderId: "ctsax1_lmuj192abc" },       // another system on the account
        { clientOrderId: "cbx01lsemuj0vdo44l7y" },    // a bot
        { clientOrderId: "manualtest123" },           // hand-placed
      ] },
    })
    // E1 + the two own client ids; the three foreign ids add nothing
    expect(countSignalPositionOrders(row, conn)).toBe(3)
  })
  test("without a connection the count is unchanged (the previous behaviour)", () => {
    const row = { orderId: "E1", exchangeData: { clientOrderIds: [{ clientOrderId: "ctsax1_x" }] } }
    expect(countSignalPositionOrders(row)).toBe(2)
  })
  test("a foreign row has no orders here at all", () => {
    expect(countSignalPositionOrders(own({ connectionId: "bingx-x02", orderId: "E1" }), conn)).toBe(0)
  })
  test("an own row still counts as at least one order, and one position slot however many rows", () => {
    expect(countSignalPositionOrders(own(), conn)).toBe(1)
    const rows = [1, 2, 3].map((n) => ({ symbol: "SOLUSDT", direction: "long", orders: countSignalPositionOrders(own({ orderId: `E${n}` }), conn) }))
    expect(summarizeSignalCounts(rows as any)).toMatchObject({ positions: 1, long: 1, short: 0, rows: 3, orders: 3 })
  })
})

describe("wiring: a foreign row never enters the admission index, and no order is ever touched", () => {
  const live = src("lib/trade-engine/stages/live-stage.ts")
  test("index update and rebuild only take own rows", () => {
    expect(live).toContain("isSystemOwnSignalRow(position as unknown as Record<string, any>, position.connectionId)")
    expect(live).toContain("isSystemOwnSignalRow(position as unknown as Record<string, any>, connectionId) &&")
  })
  test("the order count is own-only", () => {
    expect(live).toContain("countSignalPositionOrders(row as unknown as Record<string, any>, connectionId)")
  })
  test("statistics count own rows only", () => {
    const route = src("app/api/statistics/indications/route.ts")
    expect(route).toContain("own: isSystemOwnSignalRow(position, connectionId),")
    expect(route).toContain("row.own &&")
    expect(route).toContain("countSignalPositionOrders(position, connectionId)")
  })
  test("the Signal capacity code only counts and defers: it never cancels or amends an order", () => {
    const from = live.indexOf("async function updateSignalAdmissionIndexes")
    const to = live.indexOf("async function persistSignalCapacitySnapshot")
    const reserveEnd = live.indexOf("\nasync function ", live.indexOf("async function reserveSignalPositionCapacity") + 10)
    const region = live.slice(from, Math.max(to, reserveEnd))
    expect(region.length).toBeGreaterThan(2000)
    expect(region).not.toMatch(/cancelOrder|cancelAllOrders|cancelStopOrder|cancelOrders|amendOrder|closePosition\(/)
  })
  test("the settings text and the connection card say that only system-own orders count", () => {
    expect(src("components/settings/signal-indication-settings.tsx")).toContain("Only this system's own positions and orders are counted or limited")
    expect(src("components/dashboard/active-connection-card.tsx")).toContain("System-own only")
  })
})
