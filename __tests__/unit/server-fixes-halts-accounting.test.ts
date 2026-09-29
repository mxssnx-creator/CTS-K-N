import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { sweepEmptySlotProtectionHalts, SLOT_HALT_SWEEP_SECONDS } from "@/lib/trade-engine/stages/live-stage"

const src = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")
const conn = "bingx-x01"
const key = (slot: string) => `live:entry-protection-halt:${conn}:slot:${slot}`

function fakeClient(slots: string[]) {
  const store = new Set(slots.map(key))
  return {
    store,
    keys: async (pattern: string) => [...store].filter((k) => k.startsWith(pattern.replace("*", ""))),
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  }
}
const row = (symbol: string, direction: string, extra: Record<string, unknown> = {}) => ({ symbol, direction, executedQuantity: 1, status: "open", ...extra })

describe("a slot halt is cleared once its slot is empty", () => {
  test("halts on slots without any position are cleared, an occupied slot keeps its halt", async () => {
    const client = fakeClient(["BTCUSDT|long", "SOLUSDT|long", "XRPUSDT|short"])
    const cleared = await sweepEmptySlotProtectionHalts(client, conn, [row("SOL-USDT", "long")])
    expect(cleared.sort()).toEqual(["BTCUSDT|long", "XRPUSDT|short"])
    expect([...client.store]).toEqual([key("SOLUSDT|long")])
  })
  test("the direction matters: a Long row does not hold the Short slot of the same symbol", async () => {
    const client = fakeClient(["SOLUSDT|long", "SOLUSDT|short"])
    const cleared = await sweepEmptySlotProtectionHalts(client, conn, [row("SOLUSDT", "long")])
    expect(cleared).toEqual(["SOLUSDT|short"])
  })
  test("a closed, rejected or unfilled row does not occupy its slot", async () => {
    const client = fakeClient(["A|long", "B|long", "C|long", "D|long"])
    const cleared = await sweepEmptySlotProtectionHalts(client, conn, [
      row("A", "long", { status: "closed" }),
      row("B", "long", { status: "rejected" }),
      row("C", "long", { executedQuantity: 0 }),
      row("D", "long", { status: "partially_filled" }),
    ])
    expect(cleared.sort()).toEqual(["A|long", "B|long", "C|long"])
    expect([...client.store]).toEqual([key("D|long")])
  })
  test("when in doubt the halt stays: any row with quantity holds its slot, whoever it belongs to", async () => {
    const client = fakeClient(["SOLUSDT|long"])
    const cleared = await sweepEmptySlotProtectionHalts(client, conn, [row("SOLUSDT", "long", { connectionId: "other", system_tracking_id: "sys-other-x" })])
    expect(cleared).toEqual([])
  })
  test("a row without a resolvable direction holds nothing, and an empty book clears every halt", async () => {
    const client = fakeClient(["SOLUSDT|long"])
    expect(await sweepEmptySlotProtectionHalts(client, conn, [row("SOLUSDT", "")])).toEqual(["SOLUSDT|long"])
    const again = fakeClient(["A|long", "B|short"])
    expect((await sweepEmptySlotProtectionHalts(again, conn, [])).sort()).toEqual(["A|long", "B|short"])
    expect(again.store.size).toBe(0)
  })
  test("no halts, or a client without keys, do nothing", async () => {
    expect(await sweepEmptySlotProtectionHalts(fakeClient([]), conn, [row("A", "long")])).toEqual([])
    expect(await sweepEmptySlotProtectionHalts({}, conn, [])).toEqual([])
  })
  test("only this connection's halts are looked at", async () => {
    const client = fakeClient(["SOLUSDT|long"])
    client.store.add("live:entry-protection-halt:bingx-x02:slot:BTCUSDT|long")
    await sweepEmptySlotProtectionHalts(client, conn, [])
    expect([...client.store]).toEqual(["live:entry-protection-halt:bingx-x02:slot:BTCUSDT|long"])
  })
})

describe("the sync runs the sweep only with the full row list, at most once a minute", () => {
  const live = src("lib/trade-engine/stages/live-stage.ts")
  test("gated by live trading, rate limited, fed with the full list", () => {
    expect(SLOT_HALT_SWEEP_SECONDS).toBe(60)
    expect(live).toContain("if (liveTradeOn) {")
    expect(live).toContain("`live:slot-halt-sweep:${connectionId}`, String(Date.now()), { NX: true, EX: SLOT_HALT_SWEEP_SECONDS }")
    expect(live).toContain("sweepEmptySlotProtectionHalts(client, connectionId, allOpenRaw as any[])")
  })
})

describe("close-accounting stays well inside the one-minute tick", () => {
  const route = src("app/api/cron/close-accounting/route.ts")
  test("shorter budgets replace the 40 s and 55 s limits", () => {
    expect(route).toContain("const SETTLE_BUDGET_MS = 18_000")
    expect(route).toContain("const SWEEP_BUDGET_MS = 28_000")
    expect(route).toContain("Date.now() - started > SETTLE_BUDGET_MS")
    expect(route).toContain("Date.now() - started > SWEEP_BUDGET_MS")
    expect(route).not.toMatch(/started > (40_000|55_000)/)
  })
  test("every venue call is bounded", () => {
    expect(route).toContain("const VENUE_CALL_TIMEOUT_MS = 6_000")
    for (const name of ["orderDetails", "orderSettlement", "positionHistory"]) expect(route).toContain(`"close-accounting:${name}"`)
    // no venue call is left without the timeout wrapper
    expect(route).not.toMatch(/await connector\.(getOrderDetails|getOrderSettlement|getPositionHistory)/)
  })
})

describe("a failed fresh position snapshot says where the time went", () => {
  const { readFreshPositionSnapshot } = require("@/lib/fresh-position-snapshot")
  test("a connector that only answers from its cache reports the attempts and that they were cached", async () => {
    const connector = {
      getPositions: async () => [{ symbol: "BTC-USDT" }],
      getLastPositionsSnapshotStatus: () => ({ ok: true, error: "cache", at: 1 }),
    }
    await expect(readFreshPositionSnapshot(connector, undefined, 900)).rejects.toThrow(/attempts=\d+, cached-or-predating=\d+, last call \d+ ms, \d+ of 900 ms used/)
  })
  test("a call that never returns reports the timeout with the same detail", async () => {
    const connector = { getPositions: () => new Promise(() => {}), getLastPositionsSnapshotStatus: () => ({ ok: true }) }
    await expect(readFreshPositionSnapshot(connector, undefined, 300)).rejects.toThrow(/Timeout after .*\(fresh snapshot: attempts=1, cached-or-predating=0/)
  })
  test("a fresh answer is returned untouched", async () => {
    const rows = [{ symbol: "ETH-USDT" }]
    const connector = { getPositions: async () => rows, getLastPositionsSnapshotStatus: () => ({ ok: true, error: "", at: Date.now() + 10 }) }
    await expect(readFreshPositionSnapshot(connector, undefined, 1000)).resolves.toBe(rows)
  })
  test("an unavailable snapshot is still an error, never an empty account", async () => {
    const connector = { getPositions: async () => [], getLastPositionsSnapshotStatus: () => ({ ok: false }) }
    await expect(readFreshPositionSnapshot(connector, undefined, 500)).rejects.toThrow("Authoritative venue position snapshot is unavailable")
  })
})

describe("resolved unconfirmed entry holds are released", () => {
  const { sweepResolvedUnconfirmedEntryHolds } = require("@/lib/trade-engine/stages/live-stage")
  const holdKey = (slot: string) => `live:entry-rollback-cooldown:${conn}:${slot}`
  const NOW = 1_800_000_000_000
  function holds(entries: Record<string, { reason: string; ageMin: number }>) {
    const store = new Map<string, string>()
    for (const [slot, e] of Object.entries(entries)) store.set(holdKey(slot), JSON.stringify({ at: NOW - e.ageMin * 60_000, reason: e.reason }))
    return {
      store,
      keys: async (pattern: string) => [...store.keys()].filter((k) => k.startsWith(pattern.replace("*", ""))),
      get: async (k: string) => store.get(k) ?? null,
      del: async (k: string) => (store.delete(k) ? 1 : 0),
    }
  }
  test("old unconfirmed holds on unoccupied slots are released, occupied ones stay", async () => {
    const client = holds({
      "HYPEUSDT:long": { reason: "entry_protection_rollback_unconfirmed", ageMin: 600 },
      "ONUSDT:long": { reason: "entry_fill_unconfirmed", ageMin: 600 },
      "SOLUSDT:long": { reason: "entry_protection_rollback_unconfirmed", ageMin: 600 },
    })
    const released = await sweepResolvedUnconfirmedEntryHolds(client, conn, [{ symbol: "SOL-USDT", direction: "long", executedQuantity: 1, status: "open" }], NOW)
    expect(released.sort()).toEqual(["HYPEUSDT|long", "ONUSDT|long"])
    expect([...client.store.keys()]).toEqual([holdKey("SOLUSDT:long")])
  })
  test("a hold younger than the normal cooldown stays, and ordinary cooldowns are never touched", async () => {
    const client = holds({
      "AUSDT:long": { reason: "entry_protection_rollback_unconfirmed", ageMin: 5 },
      "BUSDT:short": { reason: "entry_protection_contract_incomplete", ageMin: 600 },
    })
    expect(await sweepResolvedUnconfirmedEntryHolds(client, conn, [], NOW)).toEqual([])
    expect(client.store.size).toBe(2)
  })
  test("only this connection's holds, and unreadable records are left alone", async () => {
    const client = holds({ "AUSDT:long": { reason: "entry_fill_unconfirmed", ageMin: 600 } })
    client.store.set("live:entry-rollback-cooldown:bingx-x02:BUSDT:long", JSON.stringify({ at: NOW - 600 * 60_000, reason: "entry_fill_unconfirmed" }))
    client.store.set(holdKey("CUSDT:long"), "not json")
    const released = await sweepResolvedUnconfirmedEntryHolds(client, conn, [], NOW)
    expect(released).toEqual(["AUSDT|long"])
    expect(client.store.has("live:entry-rollback-cooldown:bingx-x02:BUSDT:long")).toBe(true)
    expect(client.store.has(holdKey("CUSDT:long"))).toBe(true)
  })
  test("the sync runs it in the same gated block as the slot halt sweep", () => {
    const live = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    expect(live).toContain("sweepResolvedUnconfirmedEntryHolds(client, connectionId, allOpenRaw as any[])")
  })
})
