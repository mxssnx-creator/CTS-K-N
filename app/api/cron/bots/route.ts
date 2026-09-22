import { NextResponse } from "next/server"
import { authorizeCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"
import { getAllConnections, initRedis } from "@/lib/redis-db"
import { BOT_TYPE_IDS, readBotSettings } from "@/lib/bots/store"
import { readLivePositions, runBotTick } from "@/lib/bots/runner"

export const dynamic = "force-dynamic"
export const maxDuration = 55

/**
 * Minute tick for the live bots. For every connection, every bot type that is
 * running — or still holds open bot positions after being stopped — gets one
 * tick. Bot types run independently and in parallel.
 */
export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.ok) return cronAuthorizationResponse(auth)
  await initRedis()
  const connections: any[] = await getAllConnections().catch(() => [])
  const reports: any[] = []
  const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
  for (const connection of connections) {
    const connectionId = String(connection?.id || "")
    if (!connectionId) continue
    const due: string[] = []
    for (const type of BOT_TYPE_IDS) {
      const [s, open] = await Promise.all([readBotSettings(connectionId, type), readLivePositions(connectionId, type)])
      if (s.running || open.length > 0) due.push(type)
    }
    if (!due.length) continue
    const connector: any = await exchangeConnectorFactory.getOrCreateConnector(connectionId).catch(() => null)
    if (!connector) { reports.push({ connectionId, skipped: "no connector" }); continue }
    reports.push(...await Promise.all(due.map((type) =>
      runBotTick(connectionId, type as any, connector, connection).catch((e: any) => ({ connectionId, type, errors: [String(e?.message || e)] })))))
  }
  return NextResponse.json({ ok: true, at: Date.now(), reports })
}
export const POST = GET
