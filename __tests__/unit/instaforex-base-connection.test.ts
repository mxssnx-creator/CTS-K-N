import fs from "node:fs"
import path from "node:path"

const root = path.resolve(__dirname, "../..")

describe("canonical InstaForex base startup", () => {
  test("creates canonical connections before applying per-connection symbol defaults", () => {
    const source = fs.readFileSync(path.join(root, "lib/pre-startup.ts"), "utf8")
    const importIndex = source.indexOf('import("@/lib/default-exchanges-seeder")')
    const ensureIndex = source.indexOf("await ensureDefaultExchangesExist()")
    const symbolSeedIndex = source.indexOf("await seedPredefinedConnections()", ensureIndex)

    expect(importIndex).toBeGreaterThan(-1)
    expect(ensureIndex).toBeGreaterThan(importIndex)
    expect(symbolSeedIndex).toBeGreaterThan(ensureIndex)
    expect(source).toContain('throw new Error("Canonical base-connection seeding failed")')
  })
})
