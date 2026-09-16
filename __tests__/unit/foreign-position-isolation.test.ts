import { readFileSync } from "node:fs"
import { resolve } from "node:path"

jest.mock("@/lib/redis-db", () => ({
  getConnection: jest.fn(),
  isConnectionAssignedToMain: (c: any) => String(c?.is_assigned ?? "") === "1" || c?.is_assigned === true,
}))
jest.mock("@/lib/live-order-service", () => ({
  createLiveOrderConnector: jest.fn(async () => ({ willUseRealExchange: true, connector: { real: true } })),
}))

import { getConnection } from "@/lib/redis-db"
import { createLiveOrderConnector } from "@/lib/live-order-service"
import { resolveDirectTradeLifecycleConnector } from "@/lib/direct-trade-lifecycle-connector"

const ownedDirectRow = (connectionId: string) => ({
  id: `live:${connectionId}:adopted:XLMUSDT:short:1`,
  connectionId,
  connection_id: connectionId,
  system_tracking_id: `sys-${connectionId}-abc`,
  connection_tracking_id: `conn-${connectionId}`,
  status: "open",
  executionIntent: "direct",
})

describe("foreign and non-relevant exposure is never influenced", () => {
  beforeEach(() => jest.clearAllMocks())

  test("an owned Direct row on a non-VST connection keeps the read-only fallback instead of a mutating connector", async () => {
    ;(getConnection as jest.Mock).mockResolvedValue({ id: "bingx-x01", exchange: "bingx", is_testnet: false })
    const fallback = { readOnly: true }
    const resolved = await resolveDirectTradeLifecycleConnector("bingx-x01", [ownedDirectRow("bingx-x01")] as any, fallback)
    expect(resolved).toBe(fallback)
    expect(createLiveOrderConnector).not.toHaveBeenCalled()
  })

  test("the X02 Prod-VST connection still escalates to its scoped mutating connector", async () => {
    ;(getConnection as jest.Mock).mockResolvedValue({ id: "bingx-x02", exchange: "bingx", is_testnet: true })
    const resolved = await resolveDirectTradeLifecycleConnector("bingx-x02", [ownedDirectRow("bingx-x02")] as any, { readOnly: true })
    expect(resolved).toEqual({ real: true })
    expect(createLiveOrderConnector).toHaveBeenCalledTimes(1)
  })

  test("rows that are not exactly system-owned never trigger a connector switch at all", async () => {
    const fallback = { readOnly: true }
    const foreign = { ...ownedDirectRow("bingx-x02"), system_tracking_id: "sys-other-conn-zzz", connection_tracking_id: "conn-other" }
    const resolved = await resolveDirectTradeLifecycleConnector("bingx-x02", [foreign] as any, fallback)
    expect(resolved).toBe(fallback)
    expect(getConnection).not.toHaveBeenCalled()
  })

  test("the cron never reconciles a connection that is not assigned to Main", () => {
    const route = readFileSync(resolve(process.cwd(), "app/api/cron/sync-live-positions/route.ts"), "utf8")
    const gate = route.indexOf("if (!isConnectionAssignedToMain(conn as any)) {")
    const reconcile = route.indexOf("reconcileLivePositions(connId, connector)")
    expect(gate).toBeGreaterThan(0)
    expect(reconcile).toBeGreaterThan(gate)
    expect(route).toContain("summary.connectionsNotRelevant++")
  })
})
