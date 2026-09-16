import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const route = readFileSync(resolve(process.cwd(), "app/api/positions/stats/route.ts"), "utf8")

describe("overall stats only aggregate connection-relevant lanes", () => {
  test("the unfiltered fan-out over every stored connection is gone", () => {
    expect(route).not.toMatch(/:\s*\(await getAllConnections\(\)\)\.map\(/)
    expect(route).toContain(".filter((connection: any) => isConnectionAssignedToMain(connection))")
    expect(route).toContain("isConnectionAssignedToMain")
  })

  test("an explicit connection_id is still honoured verbatim", () => {
    const branch = route.slice(route.indexOf("const connectionIds = requestedConnectionId"))
    expect(branch).toContain("? [requestedConnectionId]")
    // The filter applies only to the fan-out branch.
    expect(branch.indexOf("[requestedConnectionId]")).toBeLessThan(branch.indexOf("isConnectionAssignedToMain"))
  })

  test("the aggregation itself is unchanged — summaries are still summed per connection", () => {
    expect(route).toContain("const summaries = await Promise.all(connectionIds.map(getLiveExecutionSummary))")
    for (const field of ["totalPositions", "openPositions", "closedPositions", "realizedPnl", "unrealizedPnl"]) {
      expect(route).toContain(`summaries.reduce((sum, row) => sum + row.${field}, 0)`)
    }
  })
})
