import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
const fn = src.slice(
  src.indexOf("function isAuthoritativeVenueBookFlat("),
  src.indexOf("function isEmptyBookProtectionSafe("),
)

describe("the rollback halt retires on OUR book, not the whole venue", () => {
  test("a non-flat row blocks only when this connection owns it", () => {
    expect(fn).toContain("return !isExactSystemPositionOwner(row, scope)")
    // The caller passes the connection, so ownership can be decided at all.
    expect(src).toContain("isAuthoritativeVenueBookFlat(input.venuePositions, input.connectionId)")
  })

  test("an unattributable row still blocks — unreadable state never retires a halt", () => {
    expect(fn).toContain("if (quantity === null) return false")
    expect(fn).toContain("if (!Array.isArray(venuePositions)) return false")
    // Without a connection to attribute against, nothing is provably foreign,
    // so the strict behaviour stands rather than failing open.
    expect(fn).toContain("if (!scope) return false")
  })

  test("a flat row is flat regardless of owner", () => {
    const flatCheck = fn.indexOf("if (quantity <= 1e-10) return true")
    const ownerCheck = fn.indexOf("isExactSystemPositionOwner")
    expect(flatCheck).toBeGreaterThan(0)
    // Cheap arithmetic before the ownership decision.
    expect(flatCheck).toBeLessThan(ownerCheck)
  })

  test("the two-confirmation safeguard is untouched", () => {
    // A single transient empty read must still not retire the halt.
    expect(src).toContain("EMPTY_BOOK_HALT_CONFIRMATION_MIN_AGE_MS")
    expect(src).toContain("EMPTY_BOOK_HALT_OBSERVATION_KEY")
    expect(src).toContain("emptyBookProtectionFingerprint(")
  })

  test("own open orders still block retirement", () => {
    const safe = src.slice(src.indexOf("function isEmptyBookProtectionSafe("))
    expect(safe).toContain("systemOrderCount === 0")
    expect(safe).toContain("isConnectionOwnedClientOrderId(clientOrderId, input.connectionId)")
  })
})
