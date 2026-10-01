import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pruneInactiveSymbolRows, symbolRowHasContent, type SymbolStatsRow } from "@/lib/statistics-symbol-rows"

const win = (trades: number) => ({ trades })
const empty = (symbol: string): SymbolStatsRow => ({ symbol, disabled: false, disabledDirections: { long: false, short: false }, openPositions: 0, windows: { positions12: win(0), positions50: win(0), hours8: win(0), hours48: win(0) } })
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")

describe("rows of symbols that carry nothing are not sent (statistics/indications was 73 MB)", () => {
  test("2 of 548 symbols with a trade: only those 2 remain", () => {
    const rows: SymbolStatsRow[] = Array.from({ length: 548 }, (_, i) => empty(`S${i}USDT`))
    rows[0] = { ...rows[0], windows: { positions12: win(1), positions50: win(1), hours8: win(0), hours48: win(1) } }
    rows[7] = { ...rows[7], windows: { positions12: win(0), positions50: win(0), hours8: win(0), hours48: win(3) } }
    const pruned = pruneInactiveSymbolRows(rows, false)
    expect(pruned.map((r) => r.symbol)).toEqual(["S0USDT", "S7USDT"])
  })
  test("an open position, a disabled symbol and a disabled direction each keep a row", () => {
    expect(symbolRowHasContent({ ...empty("A"), openPositions: 1 })).toBe(true)
    expect(symbolRowHasContent({ ...empty("B"), disabled: true })).toBe(true)
    expect(symbolRowHasContent({ ...empty("C"), disabledDirections: { long: false, short: true } })).toBe(true)
    expect(symbolRowHasContent(empty("D"))).toBe(false)
  })
  test("includeInactive=1 returns every row, in the same order, and the input is not modified", () => {
    const rows = [empty("A"), { ...empty("B"), openPositions: 2 }, empty("C")]
    const all = pruneInactiveSymbolRows(rows, true)
    expect(all.map((r) => r.symbol)).toEqual(["A", "B", "C"])
    expect(all).not.toBe(rows)
    expect(rows).toHaveLength(3)
  })
  test("a row with no windows at all is empty; missing numbers count as zero", () => {
    expect(symbolRowHasContent({ symbol: "X" })).toBe(false)
    expect(symbolRowHasContent({ symbol: "Y", windows: { positions12: {} } })).toBe(false)
  })
  test("the route prunes the signal sources and both type lists and offers includeInactive", () => {
    const route = read("app/api/statistics/indications/route.ts")
    expect(route).toContain('const includeInactive = searchParams.get("includeInactive") === "1"')
    expect((route.match(/pruneInactiveSymbolRows\(/g) || []).length).toBe(2)
    expect((route.match(/\), includeInactive\)/g) || []).length).toBe(2)
    expect(route).toContain('import { pruneInactiveSymbolRows } from "@/lib/statistics-symbol-rows"')
  })
})

describe("simulated rows are not sent with the live positions (10.3 MB on X02, three copies of 3.5 MB)", () => {
  test("positions, simulatedPositions and simulatedBook lists are empty unless asked for", () => {
    const route = read("app/api/trading/live-positions/route.ts")
    expect(route).toContain('const includeSimulated = searchParams.get("includeSimulated") === "1" || sourceFilter === "simulated"')
    expect(route).toContain('positions: (includeSimulated ? filtered : filtered.filter((p) => p.dataSource !== "simulated")).map(viewFor),')
    expect(route).toContain("simulatedPositions: includeSimulated ? simulatedPositions.map(viewFor) : [],")
    expect(route).toContain('open: includeSimulated ? simulatedPositions.filter((p) => positionBookRowState(p) === "open").map(viewFor) : [],')
    expect(route).toContain('closed: includeSimulated ? simulatedPositions.filter((p) => positionBookRowState(p) === "closed").map(viewFor) : [],')
  })
  test("the counts and the stats stay, so nothing reads 'zero positions' by accident", () => {
    const route = read("app/api/trading/live-positions/route.ts")
    expect(route).toContain("simulated: simulatedPositions.length,")
    expect(route).toContain("realPositions: realPositions.map(viewFor),")
  })
})
