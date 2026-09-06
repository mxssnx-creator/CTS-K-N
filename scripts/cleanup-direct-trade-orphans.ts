import { cleanupDirectTradeOrphanChunks } from "@/lib/direct-trade-config-store"
import { normalizeDirectTradeConnectionId } from "@/lib/direct-trade-keyspace"
import { getRedisClient, initRedis } from "@/lib/redis-db"

async function main() {
  const args = process.argv.slice(2)
  const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
  const connectionId = normalizeDirectTradeConnectionId(value("--connection-id"))
  if (!connectionId) throw new Error("An explicit --connection-id is required")
  await initRedis()
  const result = await cleanupDirectTradeOrphanChunks(getRedisClient(), {
    connectionId, apply: args.includes("--apply"), cursor: value("--cursor"), maxPages: Number(value("--max-pages") || 100),
  })
  console.log(JSON.stringify({ connectionId, mode: args.includes("--apply") ? "apply" : "read-only", ...result }))
}
main().then(() => process.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1) })
