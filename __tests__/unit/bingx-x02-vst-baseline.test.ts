import { orderOwnerClass } from "@/scripts/bingx-x02-vst-baseline"
import { systemOrderHash } from "@/lib/system-order-ownership"

describe("X02 VST baseline owner classes", () => {
  const run = (systemId: string, type = "m") => `kt${systemOrderHash("bingx-x02", systemId)}${type}sl123`

  test("orders of this run, the deployed server and other systems are told apart", () => {
    expect(orderOwnerClass(run("cts-k-n-cloud"), "cts-k-n-cloud")).toBe("run")
    expect(orderOwnerClass(`kn${systemOrderHash("bingx-x02", "cts-k-n-cloud")}tp9`, "cts-k-n-cloud")).toBe("run")
    expect(orderOwnerClass(run("cts-k-n"), "cts-k-n-cloud")).toBe("server")
    expect(orderOwnerClass("ctsbingxx02_sl_1700000000", "cts-k-n-cloud")).toBe("server")
    expect(orderOwnerClass("ctsg_entry_1", "cts-k-n-cloud")).toBe("other-cts")
    expect(orderOwnerClass("web_123", "cts-k-n-cloud")).toBe("other")
    expect(orderOwnerClass("", "cts-k-n-cloud")).toBe("missing")
  })

  test("the system id is part of the hash", () => {
    expect(systemOrderHash("bingx-x02", "cts-k-n-cloud")).not.toBe(systemOrderHash("bingx-x02", "cts-k-n"))
    const saved = process.env.CTS_SYSTEM_ID
    process.env.CTS_SYSTEM_ID = "cts-k-n-cloud"
    try {
      expect(systemOrderHash("bingx-x02")).toBe(systemOrderHash("bingx-x02", "cts-k-n-cloud"))
    } finally {
      if (saved === undefined) delete process.env.CTS_SYSTEM_ID
      else process.env.CTS_SYSTEM_ID = saved
    }
  })
})
