import { type NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { nanoid } from "nanoid"

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
        types.push({
          id,
          ...data,
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
      max_positions_per_indication: body.max_positions_per_indication || 1,
      max_positions_per_direction: body.max_positions_per_direction || 1,
      max_positions_per_range: body.max_positions_per_range || 1,
      timeout_per_indication: body.timeout_per_indication || 5,
      timeout_after_position: body.timeout_after_position || 10,
      block_enabled: body.block_enabled || false,
      block_only: body.block_only || false,
      dca_enabled: body.dca_enabled || false,
      dca_only: body.dca_only || false,
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
    
    // Set TTL (30 days)
    await (client as any).expire(key, 30 * 24 * 60 * 60)

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
