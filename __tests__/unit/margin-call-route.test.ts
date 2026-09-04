import { NextRequest } from "next/server"
import { GET, PATCH, POST } from "@/app/api/connections/[id]/margin-call/route"
import { authorizeAdminRequest } from "@/lib/admin-auth"
import { getConnection } from "@/lib/redis-db"
import { saveMarginCallSettings, startNewMarginCallSession } from "@/lib/margin-call"

jest.mock("@/lib/admin-auth", () => ({ authorizeAdminRequest: jest.fn(async () => ({ ok: true })) }))
jest.mock("@/lib/redis-db", () => ({ initRedis: jest.fn(async () => undefined), getConnection: jest.fn(async () => ({ id: "a" })) }))
jest.mock("@/lib/exchange-connectors/factory", () => ({
  exchangeConnectorFactory: { getOrCreateConnector: jest.fn(async () => ({ account: "selected" })) },
}))
jest.mock("@/lib/margin-call", () => ({
  getMarginCallSnapshot: jest.fn(async (id: string) => ({ connectionId: id, equityPercent: 30, session: null })),
  saveMarginCallSettings: jest.fn(async () => undefined),
  startNewMarginCallSession: jest.fn(async () => undefined),
}))

const context = (id = "a") => ({ params: Promise.resolve({ id }) })
const request = (method: string, body?: unknown) => new NextRequest("http://localhost/api/connections/a/margin-call", {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
})

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(authorizeAdminRequest).mockResolvedValue({ ok: true })
  jest.mocked(getConnection).mockResolvedValue({ id: "a" } as any)
})

test("returns the independent default for the selected connection", async () => {
  const response = await GET(request("GET"), context("b"))
  expect(await response.json()).toMatchObject({ success: true, connectionId: "b", equityPercent: 30 })
})

test("requires administrative authorization before any mutation", async () => {
  jest.mocked(authorizeAdminRequest).mockResolvedValue({ ok: false, status: 401, error: "Unauthorized" })
  expect((await PATCH(request("PATCH", { equityPercent: 50 }), context())).status).toBe(401)
  expect((await POST(request("POST", { action: "new-session" }), context())).status).toBe(401)
  expect(saveMarginCallSettings).not.toHaveBeenCalled()
  expect(startNewMarginCallSession).not.toHaveBeenCalled()
})

test.each([0, -1, 101, null, "30", true])("rejects an invalid threshold %s without changing settings", async (equityPercent) => {
  expect((await PATCH(request("PATCH", { equityPercent }), context())).status).toBe(400)
  expect(saveMarginCallSettings).not.toHaveBeenCalled()
})

test("updates only the connection in the route, ignoring a conflicting body ID", async () => {
  expect((await PATCH(request("PATCH", { connectionId: "b", equityPercent: 45 }), context("a"))).status).toBe(200)
  expect(saveMarginCallSettings).toHaveBeenCalledWith("a", 45)
})

test("rejects unknown connections and propagates the flat-account reset requirement", async () => {
  jest.mocked(getConnection).mockResolvedValueOnce(null)
  expect((await GET(request("GET"), context())).status).toBe(404)
  jest.mocked(startNewMarginCallSession).mockRejectedValueOnce(Object.assign(new Error("Account is not flat"), { statusCode: 409 }))
  const response = await POST(request("POST", { action: "new-session" }), context())
  expect(response.status).toBe(409)
  expect(startNewMarginCallSession).toHaveBeenCalledWith("a", { account: "selected" })
})
