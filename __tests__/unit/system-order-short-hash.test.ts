import { clientOrderSystemPrefix, isConnectionOwnedClientOrderId, systemOrderHash } from "@/lib/system-order-ownership"

describe("own orders carry a short hash of this system and connection", () => {
  const env = { ...process.env }
  afterEach(() => { process.env = { ...env } })

  test("the hash is 6 characters, stable, and differs per connection and per system", () => {
    const x01 = systemOrderHash("bingx-x01")
    expect(x01).toMatch(/^[0-9a-z]{6}$/)
    expect(systemOrderHash("bingx-x01")).toBe(x01)
    expect(systemOrderHash("bingx-x02")).not.toBe(x01)
    process.env.CTS_SYSTEM_ID = "another-system"
    expect(systemOrderHash("bingx-x01")).not.toBe(x01)
  })
  test("an id with this system's hash is ours on its connection only", () => {
    const id = `${clientOrderSystemPrefix("bingx-x01")}slSOLUSDmuf3ojon`
    expect(isConnectionOwnedClientOrderId(id, "bingx-x01")).toBe(true)
    expect(isConnectionOwnedClientOrderId(id, "bingx-x02")).toBe(false)
  })
  test("other systems on the same account are never ours", () => {
    for (const foreign of ["ctsax1_lmuj192abc", "ctsax1_smuj1b1xyz", "cbx02lsemuj0vdo44l7y", "manualtestmuixzx79", ""]) {
      expect(isConnectionOwnedClientOrderId(foreign, "bingx-x01")).toBe(false)
    }
  })
  test("the legacy prefix stays ours for running orders, and can be switched off", () => {
    expect(isConnectionOwnedClientOrderId("ctsbingxx01slSOLUSDmuf3ojon", "bingx-x01")).toBe(true)
    process.env.CTS_ACCEPT_LEGACY_ORDER_PREFIX = "0"
    expect(isConnectionOwnedClientOrderId("ctsbingxx01slSOLUSDmuf3ojon", "bingx-x01")).toBe(false)
    expect(isConnectionOwnedClientOrderId(`${clientOrderSystemPrefix("bingx-x01")}tpSOLx`, "bingx-x01")).toBe(true)
  })
})

describe("ids name system, connection AND type", () => {
  const { clientOrderSystemTypePrefix, clientOrderTypeOf } = require("@/lib/system-order-ownership")
  test("each engine type gets its own code after the system/connection hash", () => {
    const base = clientOrderSystemPrefix("bingx-x02")
    expect(clientOrderSystemTypePrefix("bingx-x02", "main")).toBe(`${base}m`)
    expect(clientOrderSystemTypePrefix("bingx-x02", "preset")).toBe(`${base}p`)
    expect(clientOrderSystemTypePrefix("bingx-x02", "signal")).toBe(`${base}s`)
    expect(clientOrderSystemTypePrefix("bingx-x02", "direct")).toBe(`${base}d`)
    expect(clientOrderSystemTypePrefix("bingx-x02", undefined)).toBe(`${base}m`)
  })
  test("the type is read back from an id, legacy ids stay ours without a type, foreign ids are nobody's", () => {
    expect(clientOrderTypeOf(`${clientOrderSystemTypePrefix("bingx-x02", "direct")}slBTC123`, "bingx-x02")).toBe("direct")
    expect(clientOrderTypeOf(`${clientOrderSystemTypePrefix("bingx-x02", "preset")}tpSOL123`, "bingx-x02")).toBe("preset")
    expect(clientOrderTypeOf("ctsbingxx02slWLDUSDmuixy0in", "bingx-x02")).toBe("legacy")
    expect(clientOrderTypeOf("ctsax1_lmuj192", "bingx-x02")).toBeNull()
    expect(clientOrderTypeOf(`${clientOrderSystemTypePrefix("bingx-x01", "main")}slX`, "bingx-x02")).toBeNull()
  })
})
