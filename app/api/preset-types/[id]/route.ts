import { type NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

const toBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "on") return true
  if (value === false || value === 0 || value === "0" || value === "false" || value === "off") return false
  return fallback
}

const toNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function serializePresetType(id: string, data: Record<string, string>) {
  const sanitized = { ...data }
  delete sanitized.trailing_only
  delete sanitized.block_only
  delete sanitized.dca_only
  return {
    id,
    ...sanitized,
    max_positions_per_indication: 0,
    max_positions_per_direction: 0,
    max_positions_per_range: 0,
    timeout_per_indication: toNumber(data.timeout_per_indication, 5),
    timeout_after_position: toNumber(data.timeout_after_position, 10),
    evaluation_interval_hours: toNumber(data.evaluation_interval_hours, 3),
    normal_enabled: toBoolean(data.normal_enabled, true),
    trailing_enabled: toBoolean(data.trailing_enabled, true),
    block_enabled: toBoolean(data.block_enabled, true),
    dca_enabled: toBoolean(data.dca_enabled, false),
    auto_evaluate: toBoolean(data.auto_evaluate, true),
    is_active: toBoolean(data.is_active, true),
  }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    await initRedis()
    const data = await getRedisClient().hgetall(`preset_type:${id}`)
    if (!data || Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Preset type not found" }, { status: 404 })
    }
    return NextResponse.json(serializePresetType(id, data))
  } catch (error) {
    console.error("[v0] Failed to fetch preset type:", error)
    return NextResponse.json({ error: "Failed to fetch preset type" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()
    await initRedis()
    const client = getRedisClient()
    const key = `preset_type:${id}`
    const existing = await client.hgetall(key)
    if (!existing || Object.keys(existing).length === 0) {
      return NextResponse.json({ error: "Preset type not found" }, { status: 404 })
    }
    const updates: Record<string, string> = {
      name: String(body.name ?? existing.name ?? "Preset"),
      description: String(body.description ?? existing.description ?? ""),
      preset_trade_type: String(body.preset_trade_type ?? existing.preset_trade_type ?? "automatic"),
      max_positions_per_indication: "0",
      max_positions_per_direction: "0",
      max_positions_per_range: "0",
      timeout_per_indication: String(body.timeout_per_indication ?? existing.timeout_per_indication ?? 5),
      timeout_after_position: String(body.timeout_after_position ?? existing.timeout_after_position ?? 10),
      normal_enabled: String(toBoolean(
        body.normal_enabled,
        toBoolean(existing.normal_enabled, true),
      )),
      trailing_enabled: String(toBoolean(
        body.trailing_enabled,
        toBoolean(existing.trailing_enabled, true),
      )),
      block_enabled: String(toBoolean(
        body.block_enabled,
        toBoolean(existing.block_enabled, true),
      )),
      dca_enabled: String(toBoolean(
        body.dca_enabled,
        toBoolean(existing.dca_enabled, false),
      )),
      auto_evaluate: String(toBoolean(
        body.auto_evaluate,
        toBoolean(existing.auto_evaluate, true),
      )),
      evaluation_interval_hours: String(body.evaluation_interval_hours ?? existing.evaluation_interval_hours ?? 3),
      is_active: String(toBoolean(
        body.is_active,
        toBoolean(existing.is_active, true),
      )),
      updated_at: new Date().toISOString(),
    }
    await client.hset(key, updates)
    await client.hdel(key, "trailing_only", "block_only", "dca_only")
    await client.sadd("preset_types:all", id)
    await client.persist(key)
    const saved = await client.hgetall(key)
    return NextResponse.json(serializePresetType(id, saved || updates))
  } catch (error) {
    console.error("[v0] Failed to update preset type:", error)
    return NextResponse.json({ error: "Failed to update preset type" }, { status: 500 })
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    await initRedis()
    const client = getRedisClient()
    await Promise.all([
      client.del(`preset_type:${id}`),
      client.srem("preset_types:all", id),
    ])
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Failed to delete preset type:", error)
    return NextResponse.json({ error: "Failed to delete preset type" }, { status: 500 })
  }
}
