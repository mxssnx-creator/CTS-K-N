import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const mockAppSettings: Record<string, any> = {}
const mockNotified: Array<{ connectionId: string; fields: string[] }> = []

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getAppSettings: jest.fn(async () => ({ ...mockAppSettings })),
  setAppSettings: jest.fn(async (value: Record<string, any>) => {
    for (const key of Object.keys(mockAppSettings)) delete mockAppSettings[key]
    Object.assign(mockAppSettings, value)
  }),
  getAllConnections: jest.fn(async () => [{ id: "conn-a" }, { id: "conn-b" }]),
  withSharedPersistenceLease: jest.fn(async (_scope: string, work: () => Promise<unknown>) => work()),
}))

jest.mock("@/lib/settings-coordinator", () => ({
  notifySettingsChanged: jest.fn(async (connectionId: string, fields: string[]) => {
    mockNotified.push({ connectionId, fields })
  }),
}))

import { GET, PUT } from "@/app/api/settings/indications/auto/route"
import { setAppSettings } from "@/lib/redis-db"

function put(body: unknown) {
  return PUT(new Request("http://localhost/api/settings/indications/auto", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

describe("Strategy → Auto indication settings route", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockAppSettings)) delete mockAppSettings[key]
    mockNotified.length = 0
    jest.mocked(setAppSettings).mockClear()
  })

  test("GET reports the engine default (enabled) when the key was never saved", async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ success: true, settings: { enabled: true }, key: "autoEnabled" })
  })

  test("GET reads the stored string flag of the app settings", async () => {
    mockAppSettings.autoEnabled = "false"
    const body = await (await GET()).json()
    expect(body.settings.enabled).toBe(false)
  })

  test("PUT persists autoEnabled into the merged app settings and notifies every connection", async () => {
    mockAppSettings.positionCost = 0.1
    mockAppSettings.autoEnabled = true

    const response = await put({ enabled: false })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, settings: { enabled: false }, changed: true })
    // Unrelated settings survive: the full snapshot is written, not a fragment.
    expect(mockAppSettings).toEqual({ positionCost: 0.1, autoEnabled: false })
    expect(mockNotified).toEqual([
      { connectionId: "conn-a", fields: ["autoEnabled"] },
      { connectionId: "conn-b", fields: ["autoEnabled"] },
    ])
  })

  test("an unchanged value is not rewritten", async () => {
    mockAppSettings.autoEnabled = false
    const body = await (await put({ settings: { enabled: false } })).json()
    expect(body).toMatchObject({ success: true, changed: false, settings: { enabled: false } })
    expect(setAppSettings).not.toHaveBeenCalled()
    expect(mockNotified).toHaveLength(0)
  })

  test("a missing or non-boolean value is rejected instead of silently defaulting", async () => {
    for (const payload of [{}, { enabled: "maybe" }, { enabled: null }]) {
      const response = await put(payload)
      expect(response.status).toBe(400)
    }
    expect(setAppSettings).not.toHaveBeenCalled()
  })

  test("the Auto sub-tab only offers the engine-consumed toggle and uses this route", () => {
    const component = readFileSync(resolve(process.cwd(), "components/settings/auto-indication-settings.tsx"), "utf8")
    expect(component).toContain('fetch("/api/settings/indications/auto"')
    expect(component).toContain('method: "PUT"')
    for (const deadField of ["analysisWindow8h", "blockPositions", "levelMaxLevels", "dcaStep1Volume", "profitBackPercent", "simultaneousTrading"]) {
      expect(component).not.toContain(deadField)
    }
  })
})
