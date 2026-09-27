/**
 * Foreign orders/positions must never be classified as owned: another system,
 * another connection, another type of this system, malformed ids and orders
 * without any client id. Same symbol/same side exposure is attributed only up
 * to the system's own tracked quantity.
 */
jest.mock("@/lib/exchange-connectors/factory", () => ({ exchangeConnectorFactory: { getOrCreateConnector: jest.fn() } }))
jest.mock("@/lib/redis-db", () => ({ getConnection: jest.fn() }))
jest.mock("@/lib/connection-state-utils", () => ({ hasConnectionCredentials: () => true }))
jest.mock("@/lib/live-position-read-model", () => ({
  getOpenLivePositionReadModelsStrict: jest.fn(),
  getClosedLivePositionReadModelsStrict: jest.fn(),
}))

import {
  clientOrderSystemPrefix,
  clientOrderSystemTypePrefix,
  clientOrderTypeOf,
  isConnectionOwnedClientOrderId,
} from "@/lib/system-order-ownership"
import {
  attributeSystemTrackedExchangePositions,
  buildSystemExchangeTrackingScope,
  isSystemTrackedExchangeOrder,
} from "@/lib/exchange-live-state-summary"

const CONN = "bingx-x02"
const OTHER_CONN = "bingx-x01"

afterEach(() => {
  delete process.env.CTS_ACCEPT_LEGACY_ORDER_PREFIX
  delete process.env.CTS_SYSTEM_ID
})

describe("client order id ownership", () => {
  const own = `${clientOrderSystemTypePrefix(CONN, "main")}slBTCUSDTmabc12345`

  test("own ids fit the BingX (40) and Bybit (36) limits and name system, connection and type", () => {
    expect(clientOrderSystemTypePrefix(CONN, "main").length).toBe(9)
    expect(own.slice(0, 32).length).toBeLessThanOrEqual(32)
    expect(isConnectionOwnedClientOrderId(own, CONN)).toBe(true)
    expect(clientOrderTypeOf(own, CONN)).toBe("main")
    expect(clientOrderTypeOf(`${clientOrderSystemTypePrefix(CONN, "direct")}x`, CONN)).toBe("direct")
  })

  test("another connection's own ids are foreign", () => {
    expect(clientOrderSystemPrefix(OTHER_CONN)).not.toBe(clientOrderSystemPrefix(CONN))
    const theirs = `${clientOrderSystemTypePrefix(OTHER_CONN, "main")}slBTCUSDTabc`
    expect(isConnectionOwnedClientOrderId(theirs, CONN)).toBe(false)
    expect(clientOrderTypeOf(theirs, CONN)).toBeNull()
  })

  test("another system on the same connection is foreign", () => {
    const ours = clientOrderSystemPrefix(CONN)
    process.env.CTS_SYSTEM_ID = "another-cts"
    expect(clientOrderSystemPrefix(CONN)).not.toBe(ours)
    expect(isConnectionOwnedClientOrderId(`${ours}mslBTCabc`, CONN)).toBe(false)
  })

  test("another type of this system is not the audited type", () => {
    const direct = `${clientOrderSystemTypePrefix(CONN, "direct")}slBTCabc`
    expect(clientOrderTypeOf(direct, CONN)).toBe("direct")
    expect(clientOrderTypeOf(direct, CONN)).not.toBe("main")
  })

  test.each([
    ["no id", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["bare prefix", clientOrderSystemPrefix(CONN)],
    ["foreign system", "ctsax1_BTCUSDT_123"],
    ["bot of another system", "cbx02mbe123abc"],
    ["manual", "web_1712345678"],
    ["prefix not at start", `x${clientOrderSystemTypePrefix(CONN, "main")}abc`],
    ["numeric", 1234567890],
    ["object", { id: "kn" }],
  ])("%s is never owned", (_label, id) => {
    expect(isConnectionOwnedClientOrderId(id, CONN)).toBe(false)
    expect(clientOrderTypeOf(id, CONN)).toBeNull()
  })

  test("legacy prefix is refused once retired", () => {
    const legacy = "ctsbingxx02slBTCabc"
    expect(isConnectionOwnedClientOrderId(legacy, CONN)).toBe(true)
    process.env.CTS_ACCEPT_LEGACY_ORDER_PREFIX = "0"
    expect(isConnectionOwnedClientOrderId(legacy, CONN)).toBe(false)
  })
})

describe("exchange live-state attribution ignores foreign orders and quantity", () => {
  const scope = () => buildSystemExchangeTrackingScope(CONN, [{
    id: "live-own-btc", status: "open", executionMode: "live", orderId: "entry-own",
    symbol: "BTCUSDT", direction: "long", executedQuantity: 1, remainingQuantity: 0,
    stopLossOrderId: "sl-own",
  }])

  test("the legacy prefix no longer counts foreign orders after it is retired", () => {
    process.env.CTS_ACCEPT_LEGACY_ORDER_PREFIX = "0"
    expect(isSystemTrackedExchangeOrder({ clientOrderId: "ctsbingxx02tpBTCzz" }, scope())).toBe(false)
    expect(isSystemTrackedExchangeOrder({ orderId: "sl-own" }, scope())).toBe(true)
  })

  test("foreign orders on the same symbol and side are not counted", () => {
    const s = scope()
    expect(isSystemTrackedExchangeOrder({ symbol: "BTCUSDT", positionSide: "LONG", orderId: "foreign-1" }, s)).toBe(false)
    expect(isSystemTrackedExchangeOrder({ symbol: "BTCUSDT", positionSide: "LONG", orderId: "f2", clientOrderId: `${clientOrderSystemTypePrefix(OTHER_CONN, "main")}sl` }, s)).toBe(false)
    expect(isSystemTrackedExchangeOrder({ symbol: "BTCUSDT", positionSide: "LONG", orderId: "f3", clientOrderId: "manual-1" }, s)).toBe(false)
  })

  test("a foreign quantity netted on the same symbol/side is not attributed", () => {
    const rows = attributeSystemTrackedExchangePositions([
      { symbol: "BTCUSDT", positionAmt: 3, positionSide: "LONG" },
      { symbol: "BTCUSDT", positionAmt: 2, positionSide: "SHORT" },
    ], scope())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ direction: "long", venueQuantity: 3, quantity: 1 })
  })
})

describe("close paths never use whole-account or whole-position venue closes", () => {
  const { readFileSync } = require("node:fs")
  const src = (p: string) => readFileSync(require("node:path").resolve(process.cwd(), p), "utf8")

  test("close-all signal closes owned lifecycle rows, not the venue closeAllPositions endpoint", () => {
    const body = src("lib/trade-execution-orchestrator.ts")
    const fn = body.slice(body.indexOf("async executeCloseAllSignal("), body.indexOf("async executeCloseAllSignal(") + 2500)
    expect(fn).not.toContain('executeSwapTrade("closeAllPositions"')
    expect(fn).toContain("closeLivePosition(")
  })

  test("emergency close delegates to the ownership-checked lifecycle close", () => {
    const body = src("lib/trade-engine/state-machine.ts")
    const fn = body.slice(body.indexOf("async emergencyClose("))
    expect(fn).not.toContain("connector.closePosition(pos.symbol)")
    expect(fn).toContain("closeLivePosition(")
  })

  test("system close refuses a whole-position fallback and never absorbs unattributed slot quantity", () => {
    const live = src("lib/trade-engine/stages/live-stage.ts")
    expect(live).not.toContain(": exchangeConnector.closePosition(position.symbol, position.direction)")
    expect(live).toContain("ownership_scoped_close_unavailable")
    expect(live).toContain('"exchange_quantity_unattributed_increase"')
  })
})
