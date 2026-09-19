import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const manager = readFileSync(resolve(process.cwd(), "lib/trade-engine/pseudo-position-manager.ts"), "utf8")
const coordinator = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
const liveStage = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")

describe("the Set key is read in every spelling it is written in", () => {
  test("writers use camelCase", () => {
    expect(coordinator).toContain("strategySetKey: set.setKey")
    expect(liveStage).toContain("strategySetKey: livePosition.setKey")
  })

  test("the close path accepts both spellings, like the registration path", () => {
    expect(manager).toContain('String(position.strategy_set_key || position.strategySetKey || "").trim()')
    const closeBlock = manager.slice(manager.indexOf("Both spellings, exactly as the registration path"))
    expect(closeBlock).toContain("position.strategy_set_key || position.strategySetKey")
    expect(closeBlock).toContain("position.parent_set_key || position.parentSetKey")
  })

  test("no reader of these fields is snake_case-only any more", () => {
    // A snake_case read that is not immediately followed by a camelCase
    // fallback would silently resolve empty for camelCase-written positions.
    // Whitespace and line breaks sit between the fields, so normalise first —
    // a lookahead across raw source reports false positives on the newline.
    const flat = manager.replace(/\s+/g, " ")
    const snakeReads = [...flat.matchAll(/position\.strategy_set_key \|\| ([A-Za-z.]+)/g)].map((m) => m[1])
    expect(snakeReads.length).toBeGreaterThan(0)
    for (const next of snakeReads) expect(next).toBe("position.strategySetKey")
    const parentReads = [...flat.matchAll(/position\.parent_set_key \|\| ([A-Za-z.]+)/g)].map((m) => m[1])
    for (const next of parentReads) expect(next).toBe("position.parentSetKey")
  })

  test("the asymmetry's effect is recorded where it was fixed", () => {
    expect(manager).toContain("182 registered Sets against exactly ONE counted as active")
  })
})
