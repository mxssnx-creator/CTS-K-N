/**
 * /api/settings/connections/[id]/settings-presets
 *
 * Named settings presets — save, list, load, and delete operator-defined
 * snapshots of the full connection settings configuration.
 *
 * GET    → list all saved presets for this connection
 * POST   → save current settings as a named preset
 * DELETE → remove a named preset by name (body: { name })
 *
 * Storage schema:
 *   settings:preset:{connectionId}:{sanitized-name}  →  HASH containing:
 *     - name          (string)           display name
 *     - created_at    (ISO timestamp)    when first saved
 *     - updated_at    (ISO timestamp)    when last updated
 *     - payload       (JSON string)      full settings payload blob
 *
 * Names are sanitised: lowercased, spaces→underscore, max 48 chars.
 * A connection can have up to 20 presets.
 */

import { NextRequest, NextResponse } from "next/server"
import { getClient, initRedis } from "@/lib/redis-db"

const MAX_PRESETS_PER_CONNECTION = 20
const MAX_NAME_LENGTH = 48

function sanitizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, MAX_NAME_LENGTH)
}

function presetKey(connectionId: string, name: string): string {
  return `settings:preset:${connectionId}:${name}`
}

// ─── GET — list all presets ───────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    await initRedis()
    const client = getClient()

    const pattern = `settings:preset:${id}:*`
    const keys: string[] = await client.keys(pattern).catch(() => [])

    if (keys.length === 0) {
      return NextResponse.json({ presets: [] })
    }

    const presets = await Promise.all(
      keys.map(async (key) => {
        try {
          const hash = await client.hgetall(key).catch(() => null)
          if (!hash) return null
          return {
            name:       hash.name       ?? key.split(":").pop() ?? "",
            created_at: hash.created_at ?? "",
            updated_at: hash.updated_at ?? hash.created_at ?? "",
            // Decode the JSON payload for the caller — they can inspect it
            // or pass it directly back as a PATCH body.
            payload:    hash.payload ? (() => { try { return JSON.parse(hash.payload) } catch { return {} } })() : {},
          }
        } catch {
          return null
        }
      }),
    )

    const valid = presets
      .filter(Boolean)
      .sort((a, b) => (b!.updated_at ?? "").localeCompare(a!.updated_at ?? ""))

    return NextResponse.json({ presets: valid })
  } catch (err) {
    console.error("[v0] [settings-presets GET]", err)
    return NextResponse.json({ error: "Failed to list presets" }, { status: 500 })
  }
}

// ─── POST — save / overwrite a named preset ───────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({})) as Record<string, unknown>

    const rawName = typeof body.name === "string" ? body.name : ""
    const sanitized = sanitizeName(rawName)

    if (!sanitized) {
      return NextResponse.json(
        { error: "A non-empty preset name is required (letters, numbers, spaces, - _ allowed)" },
        { status: 400 },
      )
    }

    const payload = body.payload ?? body.settings ?? null
    if (!payload || typeof payload !== "object") {
      return NextResponse.json(
        { error: "A settings payload object is required (pass current dialog state as `payload`)" },
        { status: 400 },
      )
    }

    await initRedis()
    const client = getClient()

    // Enforce per-connection preset cap.
    const existing: string[] = await client.keys(`settings:preset:${id}:*`).catch(() => [])
    const targetKey = presetKey(id, sanitized)
    const isNew = !existing.includes(targetKey)
    if (isNew && existing.length >= MAX_PRESETS_PER_CONNECTION) {
      return NextResponse.json(
        { error: `Maximum ${MAX_PRESETS_PER_CONNECTION} presets per connection reached. Delete one to save a new one.` },
        { status: 422 },
      )
    }

    const now = new Date().toISOString()
    const existingHash = await client.hgetall(targetKey).catch(() => null)

    await client.hset(targetKey, {
      name:       rawName.trim().slice(0, MAX_NAME_LENGTH), // preserve original casing for display
      created_at: existingHash?.created_at ?? now,
      updated_at: now,
      payload:    JSON.stringify(payload),
    })

    return NextResponse.json({
      ok:         true,
      name:       rawName.trim().slice(0, MAX_NAME_LENGTH),
      sanitized,
      created_at: existingHash?.created_at ?? now,
      updated_at: now,
      isNew,
    })
  } catch (err) {
    console.error("[v0] [settings-presets POST]", err)
    return NextResponse.json({ error: "Failed to save preset" }, { status: 500 })
  }
}

// ─── DELETE — remove a preset by name ────────────────────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const rawName = typeof body.name === "string" ? body.name : ""
    const sanitized = sanitizeName(rawName)

    if (!sanitized) {
      return NextResponse.json({ error: "A preset name is required" }, { status: 400 })
    }

    await initRedis()
    const client = getClient()

    const key = presetKey(id, sanitized)
    const deleted = await client.del(key).catch(() => 0)

    return NextResponse.json({ ok: true, deleted: deleted > 0 })
  } catch (err) {
    console.error("[v0] [settings-presets DELETE]", err)
    return NextResponse.json({ error: "Failed to delete preset" }, { status: 500 })
  }
}
