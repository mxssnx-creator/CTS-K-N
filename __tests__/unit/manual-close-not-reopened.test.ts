import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { isManualCloseByOwnControlsStillOpen, manualCloseKeyOf } from "@/lib/trade-engine/stages/live-stage"

const open = (...ids: string[]) => new Set(ids)
const row = (sl?: string, tp?: string, sec?: string) => ({ stopLossOrderId: sl, takeProfitOrderId: tp, securityStopOrderId: sec }) as any

describe("a manual close is told apart from our own stop, take profit or security stop", () => {
  test("position gone while every own control is still open -> closed by hand", () => {
    expect(isManualCloseByOwnControlsStillOpen(row("SL", "TP", "SEC"), open("SL", "TP", "SEC", "OTHER"))).toBe(true)
  })
  test("our stop filled (no longer open) -> system close, the signal may trade again", () => {
    expect(isManualCloseByOwnControlsStillOpen(row("SL", "TP"), open("TP"))).toBe(false)
  })
  test("our take profit filled -> system close", () => {
    expect(isManualCloseByOwnControlsStillOpen(row("SL", "TP"), open("SL"))).toBe(false)
  })
  test("our security stop filled -> system close", () => {
    expect(isManualCloseByOwnControlsStillOpen(row("SL", "TP", "SEC"), open("SL", "TP"))).toBe(false)
  })
  test("unknown cases keep today's behaviour: no control ids, or open orders unreadable", () => {
    expect(isManualCloseByOwnControlsStillOpen(row(), open("X"))).toBe(false)
    expect(isManualCloseByOwnControlsStillOpen(row("SL", "TP"), null)).toBe(false)
  })
  test("the suppression is keyed by the originating signal, not the symbol", () => {
    expect(manualCloseKeyOf("bingx-x02", "real-123")).toBe("live:manual-close:bingx-x02:real-123")
  })
})

describe("processing continues correctly and only the same signal is not reopened", () => {
  const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  test("on a manual close our still-open controls are cancelled before the normal close books it", () => {
    const detect = src.indexOf("if (isManualCloseByOwnControlsStillOpen(position, liveOrderIdsSync)) {")
    const cancel = src.indexOf('cancelSlotOwnedControls(exchangeConnector, position, true, "ManualCloseCleanup")', detect)
    const close = src.indexOf('"exchange_externally_closed",', detect)
    expect(detect).toBeGreaterThan(0)
    expect(cancel).toBeGreaterThan(detect)
    expect(close).toBeGreaterThan(cancel)
  })
  test("an entry from a manually closed signal is rejected before any lock or venue call", () => {
    const guard = src.indexOf(".get(manualCloseKeyOf(connectionId, String(realPosition.id)))")
    const lock = src.indexOf("const acquired = await tryAcquireLock(")
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(lock)
    expect(src).toContain('pushStep(livePosition, "manual_close_not_reopened", false, livePosition.statusReason)')
  })
})
