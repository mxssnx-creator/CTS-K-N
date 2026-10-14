import { NextRequest } from "next/server"

// nanoid is ESM-only; a deterministic CJS stand-in keeps generated ids unique.
let mockNanoidCounter = 0
jest.mock("nanoid", () => ({
  nanoid: () => `generated-${process.pid}-${++mockNanoidCounter}`,
}))

import { GET, POST } from "@/app/api/presets/route"
import { execute, query } from "@/lib/db"
import { getRedisClient, initRedis } from "@/lib/redis-db"

describe("preset CRUD over the Redis SQL shim", () => {
  const createdIds: string[] = []

  afterAll(async () => {
    const client = getRedisClient()
    for (const id of createdIds) {
      await client.srem("presets", id)
      await client.del(`presets:${id}`)
    }
    await client.srem("shim_rows", `shim-row-${process.pid}`)
    await client.del(`shim_rows:shim-row-${process.pid}`)
  })

  test("an INSERT that supplies the id stores the row under that id", async () => {
    await initRedis()
    const id = `shim-row-${process.pid}`
    await execute("INSERT INTO shim_rows (id, name, enabled) VALUES ($1, $2, $3)", [id, "row", true])

    const rows = await query("SELECT * FROM shim_rows WHERE id = $1", [id])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, name: "row", enabled: "true" })
  })

  test("POST /api/presets returns the created preset and GET parses its stored flags", async () => {
    await initRedis()
    const response = await POST(new NextRequest("http://localhost/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Preset ${process.pid}`, dca_adjustment_enabled: true, is_predefined: true }),
    }))
    expect(response.status).toBe(201)
    const created = await response.json()
    expect(typeof created.id).toBe("string")
    expect(created.name).toBe(`Preset ${process.pid}`)
    createdIds.push(created.id)

    const listResponse = await GET(new NextRequest("http://localhost/api/presets"))
    const presets = await listResponse.json()
    const listed = presets.find((preset: any) => preset.id === created.id)

    expect(listed).toBeDefined()
    // Defaults and explicit values were stored as "true"/"false" strings.
    expect(listed.trailing_enabled).toBe(true)
    expect(listed.block_adjustment_enabled).toBe(true)
    expect(listed.dca_adjustment_enabled).toBe(true)
    expect(listed.backtest_enabled).toBe(true)
    expect(listed.is_active).toBe(true)
    expect(listed.is_predefined).toBe(true)
  })

  test("an explicit false flag stays false and active=true filters on the parsed flag", async () => {
    await initRedis()
    const response = await POST(new NextRequest("http://localhost/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Inactive ${process.pid}`, trailing_enabled: false, is_active: false }),
    }))
    const created = await response.json()
    createdIds.push(created.id)

    const all = await (await GET(new NextRequest("http://localhost/api/presets"))).json()
    const listed = all.find((preset: any) => preset.id === created.id)
    expect(listed.trailing_enabled).toBe(false)
    expect(listed.is_active).toBe(false)

    const activeOnly = await (await GET(new NextRequest("http://localhost/api/presets?active=true"))).json()
    expect(activeOnly.some((preset: any) => preset.id === created.id)).toBe(false)
    expect(activeOnly.some((preset: any) => preset.id === createdIds[0])).toBe(true)
  })
})
