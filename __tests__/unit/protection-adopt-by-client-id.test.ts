import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { findPreparedProtectionAdoptions } from "@/lib/protection-slot-order-audit"

const row = (over: Record<string, any> = {}) => ({
  id: "2d2inx", symbol: "JUGGERNAUTUSDT",
  stopLossOrderId: "2102569234374156288", takeProfitOrderId: "2102569236358062080",
  pendingProtectionOrders: {
    stopLoss: { clientOrderId: "ctsbingxx02slJUGGERmudf4gw8684yh" },
    takeProfit: { clientOrderId: "ctsbingxx02tpJUGGERmudf4gwfxut4a" },
    securityStop: { clientOrderId: "ctsbingxx02secJUGGERmudf4jb8c89a" },
  },
  ...over,
})
const venueSec = { orderId: "2102570000000000001", clientOrderId: "ctsbingxx02secJUGGERmudf4jb8c89a", origQty: "1007", type: "STOP_MARKET" }

describe("protection orders that landed despite a timed-out placement are adopted", () => {
  test("the production case: security stop on the venue, no id on the row -> adopted", () => {
    const a = findPreparedProtectionAdoptions([row()], [venueSec])
    expect(a).toEqual([{ rowId: "2d2inx", leg: "securityStop", orderId: "2102570000000000001", clientOrderId: "ctsbingxx02secJUGGERmudf4jb8c89a", quantity: 1007 }])
  })
  test("a leg that already has an order id is never overwritten", () => {
    const venueSl = { orderId: "999", clientOrderId: "ctsbingxx02slJUGGERmudf4gw8684yh", origQty: "1007" }
    expect(findPreparedProtectionAdoptions([row()], [venueSl])).toEqual([])
  })
  test("an order with a different (foreign or other-row) client id is never adopted", () => {
    const foreign = { orderId: "1", clientOrderId: "ctsgsomethingelse", origQty: "1007" }
    const otherRow = { orderId: "2", clientOrderId: "ctsbingxx02secOTHERrow0000", origQty: "5" }
    expect(findPreparedProtectionAdoptions([row()], [foreign, otherRow])).toEqual([])
  })
  test("an ambiguous match (two venue orders with the same client id) is not adopted", () => {
    expect(findPreparedProtectionAdoptions([row()], [venueSec, { ...venueSec, orderId: "dup" }])).toEqual([])
  })
  test("the post-entry audit adopts before it audits", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
    const fn = src.slice(src.indexOf("async function auditEntryProtectionBeforeVenueMutation("))
    expect(fn.indexOf("findPreparedProtectionAdoptions(")).toBeGreaterThan(0)
    expect(fn.indexOf("findPreparedProtectionAdoptions(")).toBeLessThan(fn.indexOf("auditLiveEntryProtectionAdmission({"))
  })
})
