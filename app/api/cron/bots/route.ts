import { NextResponse } from "next/server"
import { authorizeCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"
import { getAllConnections, initRedis } from "@/lib/redis-db"
import { BOT_TYPE_IDS, readBotSettings } from "@/lib/bots/store"
import { readLivePositions, runBotTick, type BotTickReport } from "@/lib/bots/runner"

export const dynamic = "force-dynamic"
export const maxDuration = 30

/** Last completed tick per connection:type, for observability. */
const lastReports = new Map<string, BotTickReport & { at: number }>()

/**
 * Minute tick for the live bots.
 *
 * It returns at once and runs the ticks in the background. It used to await
 * them: after a fresh install every bot fetched candles for ~30 symbols with
 * cold caches, the request ran 58 s, the scheduler's 58 s timeout fired, and
 * the installer's final verification failed on it — taking production down
 * with it. A tick's work is independent of the scheduler's request; the per
 * connection:type lock in runBotTick keeps ticks from overlapping.
 */
export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.ok) return cronAuthorizationResponse(auth)
  await initRedis()
  const connections: any[] = await getAllConnections().catch(() => [])
  const started: string[] = []
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
    if (!connector) continue
    for (const type of due) {
      started.push(`${connectionId}:${type}`)
      void runBotTick(connectionId, type as any, connector, connection)
        .then((r) => { lastReports.set(`${connectionId}:${type}`, { ...r, at: Date.now() }) })
        .catch((e: any) => { lastReports.set(`${connectionId}:${type}`, { connectionId, type: type as any, managed: 0, entries: 0, closed: 0, errors: [String(e?.message || e)], at: Date.now() }) })
    }
  }
  return NextResponse.json({ ok: true, at: Date.now(), started, lastReports: Object.fromEntries(lastReports) })
}
export const POST = GET
