import { readFileSync } from "node:fs"
import { resolve } from "node:path"

jest.mock("@/lib/redis-db", () => ({ ...jest.requireActual("@/lib/redis-db") }))

describe("closes known only by their client id are settled", () => {
  test("tracked close-side client ids without an order id are resolved on the venue", async () => {
    const { recoverCloseOrderIdsByClientId } = await import("@/lib/trade-engine/stages/live-stage")
    const lookups: string[] = []
    const connector = {
      getOrderDetails: async (_symbol: string, _orderId: unknown, clientOrderId: string) => {
        lookups.push(clientOrderId)
        return clientOrderId === "ctsbingxx02sys-closeABC" ? { orderId: "900", clientOrderId } : null
      },
    }
    const position: any = {
      symbol: "JUGGERNAUT-USDT",
      exchangeData: { clientOrderIds: [
        { clientOrderId: "ctsbingxx02entryABC", kind: "entry" },          // never a close: not looked up
        { clientOrderId: "ctsbingxx02sys-closeABC", kind: "system_close" },
        { clientOrderId: "ctsbingxx02slABC", kind: "stop_loss" },
      ] },
    }
    const ids = await recoverCloseOrderIdsByClientId(connector, position, new Set(["111"]))
    expect(ids).toEqual(["900"])
    expect(lookups).not.toContain("ctsbingxx02entryABC")
    expect(lookups).toEqual(expect.arrayContaining(["ctsbingxx02sys-closeABC", "ctsbingxx02slABC"]))
  })
  test("an order id already known is not added twice", async () => {
    const { recoverCloseOrderIdsByClientId } = await import("@/lib/trade-engine/stages/live-stage")
    const connector = { getOrderDetails: async (_s: string, _o: unknown, clientOrderId: string) => ({ orderId: "111", clientOrderId }) }
    const ids = await recoverCloseOrderIdsByClientId(connector, { symbol: "X", exchangeData: { clientOrderIds: [{ clientOrderId: "c1", kind: "stop_loss" }] } } as any, new Set(["111"]))
    expect(ids).toEqual([])
  })
  test("reconcile resolves client ids before reading settlements, and the system close is tracked", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    const at = src.indexOf("closeOrderIds.push(...await recoverCloseOrderIdsByClientId(")
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(src.indexOf("closeOrderIds.map((orderId) => readOrderSettlement(", at))
    expect(src).toContain('appendClientOrderTracking(position, action.clientOrderId, "system_close")')
  })
})
