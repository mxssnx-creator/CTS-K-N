import { NextRequest, NextResponse } from "next/server"
import { authorizeAdminRequest } from "@/lib/admin-auth"
import { getConnection, initRedis } from "@/lib/redis-db"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getMarginCallSnapshot, saveMarginCallEnabled, saveMarginCallSettings, startNewMarginCallSession } from "@/lib/margin-call"
import { marginCallPercent } from "@/lib/margin-call-policy"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
type Context = { params: Promise<{ id: string }> }

async function connectionId(context: Context): Promise<string> {
  const { id } = await context.params
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw Object.assign(new Error("Invalid connection ID"), { statusCode: 400 })
  await initRedis()
  if (!await getConnection(id)) throw Object.assign(new Error("Connection not found"), { statusCode: 404 })
  return id
}

function failure(error: unknown) {
  const status = Number((error as any)?.statusCode) || 500
  return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Margin-call request failed" }, { status })
}

export async function GET(_request: NextRequest, context: Context) {
  try {
    return NextResponse.json({ success: true, ...await getMarginCallSnapshot(await connectionId(context)) })
  } catch (error) { return failure(error) }
}

export async function PATCH(request: NextRequest, context: Context) {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return NextResponse.json({ success: false, error: authorization.error }, { status: authorization.status })
  try {
    const id = await connectionId(context)
    const body = await request.json()
    const hasPercent = Object.prototype.hasOwnProperty.call(body, "equityPercent")
    const hasEnabled = Object.prototype.hasOwnProperty.call(body, "enabled")
    if (!hasPercent && !hasEnabled) {
      return NextResponse.json({ success: false, error: "Expected equityPercent or enabled" }, { status: 400 })
    }
    if (hasPercent) {
      let percent: number
      try {
        if (typeof body.equityPercent !== "number") throw new Error("Equity threshold must be a number")
        percent = marginCallPercent(body.equityPercent)
      } catch (error) { return NextResponse.json({ success: false, error: (error as Error).message }, { status: 400 }) }
      if (hasEnabled) await saveMarginCallSettings(id, percent, body.enabled)
      else await saveMarginCallSettings(id, percent)
    } else {
      await saveMarginCallEnabled(id, body.enabled)
    }
    return NextResponse.json({ success: true, ...await getMarginCallSnapshot(id) })
  } catch (error) { return failure(error) }
}

export async function POST(request: NextRequest, context: Context) {
  const authorization = await authorizeAdminRequest(request)
  if (!authorization.ok) return NextResponse.json({ success: false, error: authorization.error }, { status: authorization.status })
  try {
    const id = await connectionId(context)
    const body = await request.json()
    if (body.action !== "new-session") return NextResponse.json({ success: false, error: "Expected new-session action" }, { status: 400 })
    const connector = await exchangeConnectorFactory.getOrCreateConnector(id)
    if (!connector) throw Object.assign(new Error("Connection is unavailable"), { statusCode: 409 })
    await startNewMarginCallSession(id, connector)
    return NextResponse.json({ success: true, ...await getMarginCallSnapshot(id) })
  } catch (error) { return failure(error) }
}
