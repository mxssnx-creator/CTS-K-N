import { getRedisClient, initRedis } from "@/lib/redis-db"
import { BOT_TYPES, normalizeBotGroup, normalizeBotSettings, type BotGroupSettings, type BotSettings, type BotType } from "@/lib/bots/settings"
import { BOT_TUNING } from "@/lib/bots/backtest"

/** Bot state is scoped to one connection and one bot type — each fully independent. */
const settingsKey = (connectionId: string, type: BotType) => `bots:settings:${connectionId}:${type}`
const resultKey = (connectionId: string, type: BotType) => `bots:backtest:${connectionId}:${type}`

export const BOT_TYPE_IDS = Object.keys(BOT_TYPES) as BotType[]
export function isBotType(v: unknown): v is BotType { return typeof v === "string" && (BOT_TYPE_IDS as string[]).includes(v) }

export async function readBotSettings(connectionId: string, type: BotType): Promise<BotSettings> {
  await initRedis()
  const raw = await (getRedisClient() as any).get(settingsKey(connectionId, type)).catch(() => null)
  let parsed: any = null
  try { parsed = raw ? JSON.parse(String(raw)) : null } catch { parsed = null }
  return normalizeBotSettings(type, parsed)
}

export async function writeBotSettings(connectionId: string, type: BotType, patch: Partial<BotSettings>): Promise<BotSettings> {
  const current = await readBotSettings(connectionId, type)
  const next = normalizeBotSettings(type, {
    ...current, ...patch,
    strategies: { ...current.strategies, ...(patch.strategies || {}) },
    activeSkip: { ...current.activeSkip, ...(patch.activeSkip || {}) },
  })
  // A bot that failed validation cannot be started for live execution.
  if (next.running && !BOT_TUNING[type].validated) next.running = false
  await (getRedisClient() as any).set(settingsKey(connectionId, type), JSON.stringify(next))
  return next
}

export async function readBotResult(connectionId: string, type: BotType): Promise<any | null> {
  await initRedis()
  const raw = await (getRedisClient() as any).get(resultKey(connectionId, type)).catch(() => null)
  try { return raw ? JSON.parse(String(raw)) : null } catch { return null }
}

export async function writeBotResult(connectionId: string, type: BotType, result: unknown): Promise<void> {
  await (getRedisClient() as any).set(resultKey(connectionId, type), JSON.stringify(result))
}

const groupKey = (connectionId: string) => `bots:group:${connectionId}`
export async function readBotGroup(connectionId: string): Promise<BotGroupSettings> {
  await initRedis()
  const raw = await (getRedisClient() as any).get(groupKey(connectionId)).catch(() => null)
  try { return normalizeBotGroup(raw ? JSON.parse(String(raw)) : null) } catch { return normalizeBotGroup(null) }
}
/** Save the group; "run all" starts every validated bot and stops them all when turned off. */
export async function writeBotGroup(connectionId: string, patch: Partial<BotGroupSettings>): Promise<BotGroupSettings> {
  const next = normalizeBotGroup({ ...(await readBotGroup(connectionId)), ...patch })
  await (getRedisClient() as any).set(groupKey(connectionId), JSON.stringify(next))
  if (patch.runAll !== undefined) {
    for (const type of BOT_TYPE_IDS) {
      if (!BOT_TUNING[type].validated) continue
      await writeBotSettings(connectionId, type, { running: next.runAll })
    }
  }
  return next
}
