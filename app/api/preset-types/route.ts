import { type NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { nanoid } from "nanoid"

const toBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "on") return true
  if (value === false || value === 0 || value === "0" || value === "false" || value === "off") return false
  return fallback
}

// GET /api/preset-types - Get all preset types from Redis
export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    console.log("[v0] GET /api/preset-types - Fetching preset types...")

    await initRedis()
    const client = getRedisClient()

    // Get all preset type IDs from the index set
    const typeIds = await (client as any).smembers("preset_types:all")
    const types = []

    for (const id of typeIds) {
      if (!id) continue
      const data = await (client as any).hgetall(`preset_type:${id}`)
      if (data && Object.keys(data).length > 0) {
        const sanitized = { ...data }
        delete sanitized.trailing_only
        delete sanitized.block_only
        delete sanitized.dca_only
        types.push({
          id,
          ...sanitized,
          max_positions_per_indication: 0,
          max_positions_per_direction: 0,
          max_positions_per_range: 0,
          normal_enabled: toBoolean(data.normal_enabled, true),
          trailing_enabled: toBoolean(data.trailing_enabled, true),
          block_enabled: toBoolean(data.block_enabled, true),
          dca_enabled: toBoolean(data.dca_enabled, false),
        })
      }
    }

    // Sort by created_at descending
    types.sort((a, b) => {
      const dateA = new Date(a.created_at || 0)
      const dateB = new Date(b.created_at || 0)
      return dateB.getTime() - dateA.getTime()
    })

    console.log("[v0] Successfully fetched", types.length, "preset types")
    return NextResponse.json(types)
  } catch (error) {
    console.error("[v0] Failed to fetch preset types:", error)
    return NextResponse.json(
      { error: "Failed to fetch preset types", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

// POST /api/preset-types - Create new preset type
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    if (!body.name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 })
    }

    const id = nanoid()

    await initRedis()
    const client = getRedisClient()

    const presetType = {
      id,
      name: body.name,
      description: body.description || null,
      preset_trade_type: body.preset_trade_type || "automatic",
      // Compatibility fields are persisted as zero: all exact Preset
      // indication/config/direction lanes are unlimited.
      max_positions_per_indication: 0,
      max_positions_per_direction: 0,
      max_positions_per_range: 0,
      timeout_per_indication: body.timeout_per_indication || 5,
      timeout_after_position: body.timeout_after_position || 10,
      trailing_enabled: body.trailing_enabled !== false,
      // Normal, Block and DCA are independent execution families.
      block_enabled: body.block_enabled !== false,
      dca_enabled: body.dca_enabled || false,
      normal_enabled: body.normal_enabled !== false,
      auto_evaluate: body.auto_evaluate !== false,
      evaluation_interval_hours: body.evaluation_interval_hours || 3,
      is_active: body.is_active !== false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // Store in Redis as a hash
    const key = `preset_type:${id}`
    const hashData: Record<string, string> = {}
    for (const [k, v] of Object.entries(presetType)) {
      hashData[k] = String(v ?? "")
    }
    await (client as any).hset(key, hashData)

    // Add to index
    await (client as any).sadd("preset_types:all", id)
    
    // Preset settings are durable operator configuration, not cache data.
    await (client as any).persist(key)

    console.log("[v0] Preset type created successfully:", id)
    return NextResponse.json(presetType, { status: 201 })
  } catch (error) {
    console.error("[v0] Failed to create preset type:", error)
    return NextResponse.json(
      { error: "Failed to create preset type", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
