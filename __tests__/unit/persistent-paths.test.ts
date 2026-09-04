import { isSafeAbsoluteRuntimePath, resolvePersistentDataDir } from "@/lib/persistent-paths"

describe("persistent runtime paths", () => {
  const original = process.env.CTS_DATA_DIR

  afterEach(() => {
    if (original === undefined) delete process.env.CTS_DATA_DIR
    else process.env.CTS_DATA_DIR = original
  })

  test("uses the durable absolute instance path when configured", () => {
    process.env.CTS_DATA_DIR = "/var/lib/cts/instances/cts-g/data/"
    expect(resolvePersistentDataDir("/workspace/data")).toBe("/var/lib/cts/instances/cts-g/data")
  })

  test.each(["", "/", "relative/data", "/var/lib/../secret", "/var//lib"])(
    "rejects unsafe runtime path %p",
    (candidate) => {
      expect(isSafeAbsoluteRuntimePath(candidate)).toBe(false)
      process.env.CTS_DATA_DIR = candidate
      expect(resolvePersistentDataDir("/workspace/data")).toBe("/workspace/data")
    },
  )
})
