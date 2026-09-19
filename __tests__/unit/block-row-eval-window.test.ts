import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const files = [
  "lib/strategy-coordinator.ts",
  "app/api/settings/route.ts",
  "app/settings/page.tsx",
].map((path) => [path, readFileSync(resolve(process.cwd(), path), "utf8")] as const)

describe("Block rows are evaluated over their own, longer window", () => {
  test("every declaration site carries 30, none is left at 20", () => {
    for (const [path, source] of files) {
      expect([path, source.includes("blockRowRealEvalPosCount: 30,")]).toEqual([path, true])
      expect([path, source.includes("blockRowRealEvalPosCount: 20,")]).toEqual([path, false])
    }
  })

  test("the Block window is longer than the Set-lane windows it sits beside", () => {
    const coordinator = files[0][1]
    const block = Number(coordinator.match(/blockRowRealEvalPosCount: (\d+)/)![1])
    for (const field of ["realEvalPosCount", "liveEvalPosCount"]) {
      const match = coordinator.match(new RegExp(`${field}: (\\d+)`))
      if (!match) continue
      expect(block).toBeGreaterThan(Number(match[1]))
    }
  })

  test("the reason is recorded where the value is set", () => {
    expect(files[0][1]).toContain("A Block count only becomes meaningful once its recovery ladder has been")
  })
})
