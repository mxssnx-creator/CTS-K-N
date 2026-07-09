import fs from "fs"
import path from "path"
import { countLiveOpenPositions, isLiveOpenStatus, LIVE_OPEN_STATUSES } from "../../lib/live-position-status"

const repo = path.resolve(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(repo, file), "utf8")

describe("live position status grouping", () => {
  const regressionFixture = [
    { id: "open-1", status: "open" },
    { id: "filled-1", status: "filled" },
    { id: "partial-1", status: "partially_filled" },
    { id: "placed-1", status: "placed" },
    { id: "pending-1", status: "pending" },
    { id: "pending-fill-1", status: "pending_fill" },
    { id: "placed-unconfirmed-1", status: "placed_unconfirmed" },
    { id: "closed-1", status: "closed" },
    { id: "error-1", status: "error" },
    { id: "simulated-1", status: "simulated" },
    { id: "rejected-1", status: "rejected" },
  ]

  test("shared active/open fixture counts every live active status and excludes inactive statuses", () => {
    expect(LIVE_OPEN_STATUSES).toEqual([
      "open",
      "filled",
      "partially_filled",
      "placed",
      "pending",
      "pending_fill",
      "placed_unconfirmed",
    ])

    expect(countLiveOpenPositions(regressionFixture)).toBe(7)
    expect(regressionFixture.filter((position) => isLiveOpenStatus(position.status)).map((position) => position.status)).toEqual([
      "open",
      "filled",
      "partially_filled",
      "placed",
      "pending",
      "pending_fill",
      "placed_unconfirmed",
    ])
  })

  test("API route and logistics UI both use the shared live-open grouping helper", () => {
    const route = read("app/api/trading/live-positions/route.ts")
    const logistics = read("app/logistics/page.tsx")

    expect(route).toContain('from "@/lib/live-position-status"')
    expect(route).toContain("isLiveOpenStatus(p.status)")
    expect(route).toContain("open: countLiveOpenPositions(all)")
    expect(route).not.toContain('p.status === "open").length')

    expect(logistics).toContain('from "@/lib/live-position-status"')
    expect(logistics).toContain("const activeCount = countLiveOpenPositions(positions)")
    expect(logistics).toContain("isLiveOpenStatus(s)")
  })
})
