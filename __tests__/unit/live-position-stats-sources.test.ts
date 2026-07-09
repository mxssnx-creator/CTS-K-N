import fs from "fs"
import path from "path"

const repo = path.resolve(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8")

describe("live position stats and trade-history data sources", () => {
  test("live-stage savePosition mirrors hash snapshots into JSON keys and open/closed indexes", () => {
    const source = read("lib/trade-engine/stages/live-stage.ts")
    const saveBlock = source.slice(
      source.indexOf("async function savePosition"),
      source.indexOf("/**\n * Batch save multiple positions"),
    )

    expect(saveBlock).toContain("const posKey = `live_positions:${position.connectionId}:${position.id}`")
    expect(saveBlock).toContain("const jsonKey = `live:position:${position.id}`")
    expect(saveBlock).toContain("await client.set(jsonKey, JSON.stringify(position)")
    expect(saveBlock).toContain("await client.lrem(openIndexKey, 0, position.id)")
    expect(saveBlock).toContain("await client.lpush(closedIndexKey, position.id)")
    expect(saveBlock).toContain("await client.lpush(openIndexKey, position.id)")
  })

  test("progression stats and trade history read Redis hash fallbacks and derive effective PnL", () => {
    const statsRoute = read("app/api/connections/progression/[id]/stats/route.ts")

    expect(statsRoute).toContain("async function readLivePosition")
    expect(statsRoute).toContain("client.hgetall(`live_positions:${connectionId}:${id}`)")
    expect(statsRoute).toContain("function effectiveRealizedPnl")
    expect(statsRoute).toContain("function effectiveUnrealizedPnl")
    expect(statsRoute).toContain("const pnl = effectiveRealizedPnl(pos)")
    expect(statsRoute).toContain("const unrealizedPnl = Math.round(effectiveUnrealizedPnl(pos) * 100) / 100")
  })

  test("dashboard live stats poll every three seconds", () => {
    const overview = read("components/dashboard/statistics-overview-v2.tsx")

    expect(overview).toContain("setInterval(load, 3000)")
    expect(overview).toContain("Poll every 3s so live exchange order/position PnL")
    expect(overview).not.toContain("setInterval(load, 5000)")
  })
})
