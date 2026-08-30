import fs from "node:fs"
import path from "node:path"
import { isTruthyFlag } from "@/lib/connection-state-utils"

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8")

describe("BingX VST runtime routing", () => {
  test("recognises the persisted testnet flag shapes used by X02", () => {
    expect(isTruthyFlag(true)).toBe(true)
    expect(isTruthyFlag(1)).toBe(true)
    expect(isTruthyFlag("1")).toBe(true)
    expect(isTruthyFlag("true")).toBe(true)
    expect(isTruthyFlag("0")).toBe(false)
  })

  test("uses the canonical flag decoder in every path that decodes testnet state", () => {
    const decoderPaths = [
      "lib/market-data-loader.ts",
      "lib/volume-calculator.ts",
      "lib/trade-engine/engine-manager.ts",
      "lib/trade-engine/realtime-processor.ts",
      "lib/preset-store.ts",
      "app/api/market-data/route.ts",
      "app/api/settings/connections/[id]/enable/route.ts",
      "app/api/system/verify-engine/route.ts",
      "app/api/trade-engine/resume/route.ts",
      "app/api/trade-engine/quick-start/route.ts",
    ]

    for (const file of decoderPaths) {
      const source = read(file)
      expect(source).toContain("isTruthyFlag")
      expect(source).not.toMatch(/is_(?:testnet)\s*===\s*(?:true|"true")/)
      expect(source).not.toMatch(/isTestnet\s*===\s*(?:true|"true")/)
    }

    const safetyPaths = [...decoderPaths, "lib/trade-engine/state-machine.ts"]
    for (const file of safetyPaths) {
      expect(read(file)).not.toMatch(/is_(?:testnet)\s*===\s*(?:true|"true")/)
      expect(read(file)).not.toMatch(/isTestnet\s*===\s*(?:true|"true")/)
    }
  })
})
