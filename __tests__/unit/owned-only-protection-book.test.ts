import {
  classifyConnectionOwnedProtectionBook,
  protectionClientOrderPrefix,
} from "@/lib/protection-slot-order-audit"

const CONN = "bingx-x02"
const PREFIX = protectionClientOrderPrefix(CONN) // "ctsbingxx02"
const QTY = 0.05
const ENTRY = 500

/** One of our three protection legs, addressed to this connection. */
const ownLeg = (kind: "tp" | "sl" | "sec", trigger: number) => ({
  id: `own-${kind}`,
  clientOrderID: `${PREFIX}-${kind}-1`,
  symbol: "BCH-USDT",
  side: "SELL",
  positionSide: "LONG",
  type: kind === "tp" ? "TAKE_PROFIT_MARKET" : "STOP_MARKET",
  quantity: QTY,
  stopPrice: trigger,
  reduceOnly: true,
})

/** Another system's order on the SAME symbol and direction — never ours to count. */
const foreignLeg = (id: string, trigger: number) => ({
  id,
  clientOrderID: `Gx02-${id}`,
  symbol: "BCH-USDT",
  side: "SELL",
  positionSide: "LONG",
  type: "STOP_MARKET",
  quantity: 1.23,
  stopPrice: trigger,
  reduceOnly: true,
})

const classify = (openOrders: any[]) => classifyConnectionOwnedProtectionBook({
  connectionId: CONN,
  symbol: "BCHUSDT",
  direction: "long",
  venueQuantity: QTY,
  entryPrice: ENTRY,
  openOrders,
})

describe("the protection book counts only system-owned, connection-relevant orders", () => {
  const ownBook = [ownLeg("tp", 520), ownLeg("sl", 480), ownLeg("sec", 470)]

  test("our complete book is safe on an account we share with another system", () => {
    const alone = classify(ownBook)
    expect(alone.reason).not.toBe("exact_slot_control_count_mismatch")
    // Adding foreign orders on the same symbol/direction must not change the verdict.
    const shared = classify([...ownBook, foreignLeg("g1", 460), foreignLeg("g2", 455), foreignLeg("g3", 450)])
    expect(shared.reason).toBe(alone.reason)
    expect(shared.safe).toBe(alone.safe)
  })

  test("foreign orders alone never form a book of ours", () => {
    const result = classify([foreignLeg("g1", 460), foreignLeg("g2", 455), foreignLeg("g3", 450)])
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("exact_slot_control_count_mismatch")
  })

  test("a missing own leg still fails, foreign orders cannot substitute for it", () => {
    const result = classify([ownLeg("tp", 520), ownLeg("sl", 480), foreignLeg("g1", 470)])
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("exact_slot_control_count_mismatch")
  })

  test("a duplicate own leg is still rejected — ownership does not relax the exact count", () => {
    const result = classify([...ownBook, { ...ownLeg("sec", 469), id: "own-sec-2", clientOrderID: `${PREFIX}-sec-2` }])
    expect(result.safe).toBe(false)
    expect(result.reason).toBe("exact_slot_control_count_mismatch")
  })
})
