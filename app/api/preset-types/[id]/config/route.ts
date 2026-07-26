import { type NextRequest, NextResponse } from "next/server"
import {
  normalizeIdentityVolumeFactor,
} from "@/lib/constants"
import { getRedisClient, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const PRESET_TYPE_TTL_SECONDS = 30 * 24 * 60 * 60

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback
  return value === true || value === 1 || value === "1" || value === "true"
}

function bounded(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback
}

function serializeConfig(stored: Record<string, unknown>) {
  return {
    volume_factor: normalizeIdentityVolumeFactor(stored.volume_factor),
    profit_factor_min: bounded(stored.profit_factor_min, 0.6, 0.1, 5),
    max_drawdown_time: bounded(stored.max_drawdown_time, 12, 1, 168),
    trailing_enabled: bool(stored.trailing_enabled, true),
    block_enabled: bool(stored.block_enabled, true),
    dca_enabled: bool(stored.dca_enabled, false),
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  await initRedis()
  const client = getRedisClient()
  const stored = await client.hgetall(`preset_type:${id}`)
  if (!stored || Object.keys(stored).length === 0) {
    return NextResponse.json({ error: "Preset type not found" }, { status: 404 })
  }
  return NextResponse.json(serializeConfig(stored))
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  await initRedis()
  const client = getRedisClient()
  const key = `preset_type:${id}`
  const stored = await client.hgetall(key)
  if (!stored || Object.keys(stored).length === 0) {
    return NextResponse.json({ error: "Preset type not found" }, { status: 404 })
  }

  const current = serializeConfig(stored)
  const next = {
    volume_factor: normalizeIdentityVolumeFactor(
      body.volumeFactor ?? body.volume_factor ?? current.volume_factor,
    ),
    profit_factor_min: bounded(
      body.profitFactorMin ?? body.profit_factor_min,
      current.profit_factor_min,
      0.1,
      5,
    ),
    max_drawdown_time: bounded(
      body.maxDrawdownTime ?? body.max_drawdown_time,
      current.max_drawdown_time,
      1,
      168,
    ),
    trailing_enabled: bool(
      body.trailingEnabled ?? body.trailing_enabled,
      current.trailing_enabled,
    ),
    block_enabled: bool(
      body.blockEnabled ?? body.block_enabled,
      current.block_enabled,
    ),
    dca_enabled: bool(
      body.dcaEnabled ?? body.dca_enabled,
      current.dca_enabled,
    ),
  }

  await client.hset(key, {
    ...Object.fromEntries(
      Object.entries(next).map(([field, value]) => [field, String(value)]),
    ),
    updated_at: new Date().toISOString(),
  })
  await client.expire(key, PRESET_TYPE_TTL_SECONDS)

  return NextResponse.json({ success: true, ...next })
}
