import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
const live = src.slice(src.indexOf("private async createLiveSets("))

describe("connection-level halt short-circuits per-Set dispatch", () => {
  test("the runtime admission is read once per symbol, only for real live dispatch", () => {
    expect(live).toContain("if (isLiveTradeEnabled && connector) {")
    // Readiness must be evaluated on a document that carries the connection
    // id; the bare overlay fails closed as connection_not_allowed under an
    // allow-list, which silently disabled this whole short-circuit.
    expect(live).toContain("const connectionDocument = ((await getConnection(this.connectionId).catch(() => null)) || {}) as Record<string, unknown>")
    expect(live).toContain("{ ...connectionDocument, id: this.connectionId, connectionId: this.connectionId } as any,")
    expect(live).not.toContain("evaluateRealTradeReadiness(connectionOverlay as any")
    expect(live).toContain("readLiveEntryReadiness(haltClient, this.connectionId, configuredReadiness)")
    expect(live).toContain("if (configuredReadiness.canPlaceRealOrders && !runtimeAdmission.canPlaceRealOrders) {")
  })

  test("a halt records the whole selection as blocked and skips the loop; simulation is untouched", () => {
    expect(live).toContain("await persistUnavailableDispatch(dispatchHaltedForConnection, \"blocked\")")
    expect(live).toContain("for (const set of dispatchHaltedForConnection ? [] : dispatchSets) {")
    // The gate lives inside the live-trade branch, so the paper lifecycle
    // (isLiveTradeEnabled false) still dispatches every Set.
    const gate = live.indexOf("dispatchHaltedForConnection = String(")
    expect(live.slice(0, gate)).toContain("if (isLiveTradeEnabled && connector) {")
  })

  test("the blocked outcome cannot be overwritten by the post-loop metric write", () => {
    expect(live).toContain("if (!dispatchOutcomePersisted) {")
    const helper = live.slice(live.indexOf("const persistUnavailableDispatch = async ("))
    expect(helper).toContain("dispatchOutcomePersisted = true")
  })

  test("a slow Live stage reports its sub-phase split on the captured channel", () => {
    expect(live).toContain("live-stage split ${liveTotal}ms")
    for (const part of ["windows", "blockOverlays", "blockWindows", "persist", "marketData", "dispatch"]) {
      expect(live).toContain(`${part}=\${liveSub.${part}}ms`)
    }
    expect(live).toContain("halted=${dispatchHaltedForConnection}")
  })
})
