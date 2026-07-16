import { buildPrehistoricGateKeys, buildProgressionScope } from "@/lib/progression-scope"

describe("engine-scoped progression keys", () => {
  test("historic readiness keeps an engine-specific authority and legacy deploy mirror", () => {
    expect(buildProgressionScope("bingx-x01", "main").prehistoricKey).toBe(
      "prehistoric:bingx-x01:main",
    )
    expect(buildPrehistoricGateKeys("bingx-x01", "main", "done")).toEqual({
      scoped: "prehistoric:bingx-x01:main:done",
      legacy: "prehistoric:bingx-x01:done",
    })
    expect(buildPrehistoricGateKeys("bingx-x01", "preset", "firstpass:done")).toEqual({
      scoped: "prehistoric:bingx-x01:preset:firstpass:done",
      legacy: "prehistoric:bingx-x01:firstpass:done",
    })
  })

  test("unsafe Redis separators are normalized consistently", () => {
    expect(buildPrehistoricGateKeys("conn:one", "main/live")).toEqual({
      scoped: "prehistoric:conn_one:main_live:done",
      legacy: "prehistoric:conn_one:done",
    })
  })
})
