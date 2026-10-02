import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { clearOwnProtectionOrderCache, confirmMissingControlOrders, ownControlOrderRefs, ownLookupLiveOrderIdSet, ownProtectionFallbackEnabled, readOwnControlOrdersById } from "@/lib/trade-engine/own-protection-orders"

const NOW = 1_790_880_000_000
const row = (over: Record<string, any> = {}) => ({ id: "r1", symbol: "NCCOGOLD2USDUSDT", status: "open", executedQuantity: 0.0024, stopLossOrderId: "SL1", takeProfitOrderId: "TP1", ...over })
const order = (status: string, extra: Record<string, any> = {}) => ({ success: true, order: { orderId: "x", status, type: "STOP_MARKET", side: "SELL", positionSide: "LONG", origQty: "0.0024", stopPrice: "4162.47", ...extra } })

function connector(answers: Record<string, any>, testnet = true) {
  const calls: string[] = []
  return { calls, credentials: { isTestnet: testnet }, getOrderDetails: async (_s: string, id: string) => { calls.push(id); const a = answers[id]; if (a instanceof Error) throw a; return a } }
}

beforeEach(() => clearOwnProtectionOrderCache())

describe("our own control orders are verified one by one when the open-order list is rate limited", () => {
  test("which ids are read from our rows: open rows with a fill, their SL, TP and security stop, once", () => {
    const refs = ownControlOrderRefs([
      row(),
      row({ id: "r2", stopLossOrderId: "SL1", takeProfitOrderId: "TP2", securityStopOrderId: "SEC1", controlOrderSetCoverage: { a: { securityStopOrderId: "SEC2" } } }),
      row({ id: "r3", status: "closed" }),
      row({ id: "r4", executedQuantity: 0 }),
      row({ id: "r5", symbol: "BTCUSDT", stopLossOrderId: "", takeProfitOrderId: "TP9" }),
    ])
    expect(refs.map((r) => `${r.symbol}|${r.id}`)).toEqual([
      "NCCOGOLD2USDUSDT|SL1", "NCCOGOLD2USDUSDT|TP1", "NCCOGOLD2USDUSDT|TP2", "NCCOGOLD2USDUSDT|SEC1", "NCCOGOLD2USDUSDT|SEC2", "BTCUSDT|TP9",
    ])
  })

  test("X02, 2026-10-01: the gold STOP_MARKET and TAKE_PROFIT_MARKET (status NEW) are found alive", async () => {
    const c = connector({ SL1: order("NEW"), TP1: order("NEW", { type: "TAKE_PROFIT_MARKET", stopPrice: "4201.72" }) })
    const live = await readOwnControlOrdersById(c, [row()], NOW)
    expect(live).toHaveLength(2)
    expect(live!.map((o) => o.orderId)).toEqual(["x", "x"])
    expect(live![0]).toMatchObject({ symbol: "NCCOGOLD2USDUSDT", status: "NEW", __ownLookup: true })
  })

  test("a filled, cancelled or expired control order is not alive; a missing one is gone, not unknown", async () => {
    const c = connector({
      SL1: order("FILLED"),
      TP1: { success: false, error: "BingX API error (code=109421): order does not exist" },
    })
    expect(await readOwnControlOrdersById(c, [row()], NOW)).toEqual([])
  })

  test("a lookup that cannot be answered (cooldown, rate limit, network) makes the fallback unavailable, never 'missing'", async () => {
    for (const failure of [
      { success: false, error: "BingX order lookup cooldown active after missing-order pressure" },
      { success: false, error: "BingX private API cooldown active until 2026-10-01T19:30:00.000Z" },
      new Error("100410 disabled period"),
      new Error("socket hang up"),
    ]) {
      clearOwnProtectionOrderCache()
      const c = connector({ SL1: order("NEW"), TP1: failure })
      expect(await readOwnControlOrdersById(c, [row()], NOW)).toBeNull()
    }
  })

  test("answers are kept for 15 s so a busy sync does not ask the venue again; a connector without getOrderDetails is unavailable", async () => {
    const c = connector({ SL1: order("NEW"), TP1: order("NEW") })
    await readOwnControlOrdersById(c, [row()], NOW)
    await readOwnControlOrdersById(c, [row()], NOW + 10_000)
    expect(c.calls).toEqual(["SL1", "TP1"])
    await readOwnControlOrdersById(c, [row()], NOW + 16_000)
    expect(c.calls).toHaveLength(4)
    expect(await readOwnControlOrdersById({}, [row()], NOW)).toBeNull()
    expect(await readOwnControlOrdersById(c, [], NOW)).toEqual([])
  })

  test("on by default for testnet accounts only; the variable forces it on or off", () => {
    expect(ownProtectionFallbackEnabled({ credentials: { isTestnet: true } }, {})).toBe(true)
    expect(ownProtectionFallbackEnabled({ credentials: { isTestnet: false } }, {})).toBe(false)
    expect(ownProtectionFallbackEnabled({}, {})).toBe(false)
    expect(ownProtectionFallbackEnabled({ credentials: { isTestnet: false } }, { CTS_PROTECTION_OWN_ORDER_FALLBACK: "1" })).toBe(true)
    expect(ownProtectionFallbackEnabled({ credentials: { isTestnet: true } }, { CTS_PROTECTION_OWN_ORDER_FALLBACK: "0" })).toBe(false)
  })

  test("the protection audit tries the list first, falls back only for a rate limit, and rethrows everything else", () => {
    const stage = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(stage).toContain("const openOrders = await readProtectionOrdersOrOwnFallback(input.connectionId, input.connector, positions as any[])")
    const start = stage.indexOf("async function readProtectionOrdersOrOwnFallback(")
    const body = stage.slice(start, stage.indexOf("async function auditEntryProtectionBeforeVenueMutation(", start))
    expect(body).toContain("const list = await readAuthoritativeProtectionOrders(connector)")
    expect(body).toContain("if (!(error instanceof AuthoritativeSnapshotUnavailableError) || !error.rateLimited) throw error")
    expect(body).toContain("if (!ownProtectionFallbackEnabled(connector)) throw error")
    expect(body).toContain("if (!own) throw error")
  })
})

describe("a valid list that lacks our control ids is confirmed per id before it is a verdict", () => {
  test("X02 gold: both ids absent from the list, the venue says NEW, so both count as alive", async () => {
    const c = connector({ SL1: order("NEW"), TP1: order("NEW", { type: "TAKE_PROFIT_MARKET" }) })
    const found = await confirmMissingControlOrders(c, [row()], new Set<string>(), NOW)
    expect(found.map((o) => o.status)).toEqual(["NEW", "NEW"])
    expect(c.calls).toEqual(["SL1", "TP1"])
  })
  test("ids already in the list are not asked for; nothing missing means no venue call", async () => {
    const c = connector({})
    expect(await confirmMissingControlOrders(c, [row()], new Set(["SL1", "TP1"]), NOW)).toEqual([])
    expect(c.calls).toEqual([])
    const c2 = connector({ TP1: order("NEW") })
    expect((await confirmMissingControlOrders(c2, [row()], new Set(["SL1"]), NOW)).length).toBe(1)
    expect(c2.calls).toEqual(["TP1"])
  })
  test("an id the venue does not know, or cannot answer for, adds nothing: the list verdict stands", async () => {
    const c = connector({ SL1: { success: false, error: "BingX API error (code=109421): order does not exist" }, TP1: { success: false, error: "BingX order lookup cooldown active after missing-order pressure" } })
    expect(await confirmMissingControlOrders(c, [row()], new Set<string>(), NOW)).toEqual([])
  })
  test("the audit confirms before it judges, for every account", () => {
    const stage = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(stage).toContain("const confirmed = await confirmMissingControlOrders(connector, positions, known).catch(() => [] as Record<string, any>[])")
    expect(stage).toContain("return [...list, ...confirmed]")
  })
})

describe("the aggregate protection book gets a live order id set from our own ids when the list is rate limited", () => {
  const banned = (answers: Record<string, any>, testnet = true, error = "100410:code:100410:The endpoint trigger frequency limit rule is currently in the disabled period") => ({
    ...connector(answers, testnet), getLastOpenOrdersSnapshotStatus: () => ({ ok: false, error }),
  })
  test("X02 BTCUSDT long, 2026-10-02: the hand-off can settle: alive ids are in the set, cancelled ones are not", async () => {
    const c = banned({ SL1: order("CANCELED"), TP1: order("NEW") })
    const set = await ownLookupLiveOrderIdSet(c, [row({ symbol: "BTCUSDT" })], NOW)
    expect(set).not.toBeNull()
    expect(set!.has("x")).toBe(true) // the TP the venue reports NEW (its orderId in the fake is "x")
    expect(set!.observedOrderCount).toBe(1)
    expect(set!.ownLookupOnly).toBe(true)
  })
  test("no set when the list did not fail for a rate limit, when it is fine, or on mainnet by default", async () => {
    expect(await ownLookupLiveOrderIdSet(banned({ SL1: order("NEW"), TP1: order("NEW") }, true, "socket hang up"), [row()], NOW)).toBeNull()
    expect(await ownLookupLiveOrderIdSet({ ...connector({}), getLastOpenOrdersSnapshotStatus: () => ({ ok: true }) }, [row()], NOW)).toBeNull()
    expect(await ownLookupLiveOrderIdSet(banned({ SL1: order("NEW"), TP1: order("NEW") }, false), [row()], NOW)).toBeNull()
    expect(await ownLookupLiveOrderIdSet({ credentials: { isTestnet: true } }, [row()], NOW)).toBeNull()
  })
  test("no set while a protection submission is pending (only the list could find it; guessing could place a second control)", async () => {
    const c = banned({ SL1: order("NEW"), TP1: order("NEW") })
    expect(await ownLookupLiveOrderIdSet(c, [row({ pendingProtectionOrders: { stopLoss: { clientOrderId: "cts-sl-1" } } })], NOW)).toBeNull()
    expect(await ownLookupLiveOrderIdSet(c, [row({ pendingProtectionOrders: { stopLoss: { clientOrderId: "" } } })], NOW)).not.toBeNull()
  })
  test("no set when an id cannot be resolved", async () => {
    const c = banned({ SL1: order("NEW"), TP1: { success: false, error: "BingX order lookup cooldown active after missing-order pressure" } })
    expect(await ownLookupLiveOrderIdSet(c, [row()], NOW)).toBeNull()
  })
  test("the book uses it only when its caller had no list", () => {
    const stage = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    const start = stage.indexOf("async function reconcileAggregateProtectionBook(")
    const head = stage.slice(start, start + 1800)
    expect(head).toContain("if (liveOrderIds === null) {")
    expect(head).toContain("const own = await ownLookupLiveOrderIdSet(connector, positions).catch(() => null)")
  })
})
