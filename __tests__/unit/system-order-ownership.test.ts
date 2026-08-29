import {
  clientOrderConnectionPrefix,
  isConnectionOwnedClientOrderId,
  isExactSystemPositionOwner,
} from "@/lib/system-order-ownership"

describe("exact system order ownership", () => {
  const owned = {
    connectionId: "bingx-x02",
    system_tracking_id: "sys-bingx-x02-row-1",
    connection_tracking_id: "conn-bingx-x02",
  }

  test("requires the persisted connection and both exact watermarks", () => {
    expect(isExactSystemPositionOwner(owned, "bingx-x02")).toBe(true)
    expect(isExactSystemPositionOwner({ ...owned, connectionId: "bingx-x01" }, "bingx-x02")).toBe(false)
    expect(isExactSystemPositionOwner({ ...owned, system_tracking_id: "sys-bingx-x020-row-1" }, "bingx-x02")).toBe(false)
    expect(isExactSystemPositionOwner({ ...owned, connection_tracking_id: "conn-bingx-x01" }, "bingx-x02")).toBe(false)
    expect(isExactSystemPositionOwner({ ...owned, system_tracking_id: "" }, "bingx-x02")).toBe(false)
  })

  test("uses an exact sanitized connection prefix for venue client ids", () => {
    expect(clientOrderConnectionPrefix("bingx-x02")).toBe("ctsbingxx02")
    expect(isConnectionOwnedClientOrderId("ctsbingxx02slbtc123", "bingx-x02")).toBe(true)
    expect(isConnectionOwnedClientOrderId("cts-smoke-sl-123", "bingx-x02")).toBe(false)
    expect(isConnectionOwnedClientOrderId("ctsbingxx01slbtc123", "bingx-x02")).toBe(false)
    expect(isConnectionOwnedClientOrderId("cts", "bingx-x02")).toBe(false)
  })
})
