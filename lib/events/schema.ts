export type CanonicalEventType =
  | "settings.saved"
  | "settings.hotReloaded"
  | "connection.recoordinated"
  | "progression.epochStarted"
  | "progression.stageChanged"
  | "strategy.stageChanged"
  | "live.stageChanged"
  | "dashboard.sectionUpdated"
  | "position.updated"
  | "indication.updated"
  | "engine.status"
  | "processing.progress"
  | "error"

export type CanonicalStage =
  | "settings"
  | "connection"
  | "prehistoric"
  | "base"
  | "main"
  | "real"
  | "live"
  | "dashboard"
  | "engine"
  | "unknown"

export interface CanonicalEvent<TData = Record<string, unknown>> {
  id: string
  type: CanonicalEventType
  connectionId: string
  symbol?: string
  stage: CanonicalStage
  epoch?: number
  session?: string | number
  settingsVersion?: string | number
  timestamp: string
  parentEventId?: string
  data: TData
}

export interface EventFreshnessCursor {
  connectionId?: string
  symbol?: string
  epoch?: number
  session?: string | number
  settingsVersion?: string | number
  timestamp?: string
}

const sequenceByConnection = new Map<string, number>()

function nextId(connectionId: string, timestamp: string): string {
  const next = (sequenceByConnection.get(connectionId) || 0) + 1
  sequenceByConnection.set(connectionId, next)
  return `${connectionId}:${Date.parse(timestamp) || Date.now()}:${next}`
}

export function createCanonicalEvent<TData = Record<string, unknown>>(
  input: Omit<CanonicalEvent<TData>, "id" | "timestamp" | "stage" | "data"> & {
    id?: string
    timestamp?: string
    stage?: CanonicalStage
    data?: TData
  },
): CanonicalEvent<TData> {
  const timestamp = input.timestamp || new Date().toISOString()
  return {
    id: input.id || nextId(input.connectionId, timestamp),
    type: input.type,
    connectionId: input.connectionId,
    symbol: input.symbol,
    stage: input.stage || "unknown",
    epoch: normalizeNumber(input.epoch),
    session: input.session,
    settingsVersion: input.settingsVersion,
    timestamp,
    parentEventId: input.parentEventId,
    data: (input.data || {}) as TData,
  }
}

function normalizeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function compareVersion(a: unknown, b: unknown): number {
  if (a === undefined || a === null || a === "") return 0
  if (b === undefined || b === null || b === "") return 0
  const an = Number(a)
  const bn = Number(b)
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  return String(a).localeCompare(String(b))
}

export function isCanonicalEventFresh(event: Pick<CanonicalEvent, "epoch" | "session" | "settingsVersion" | "timestamp">, cursor: EventFreshnessCursor): boolean {
  if (event.epoch !== undefined && cursor.epoch !== undefined && event.epoch < cursor.epoch) return false
  if (event.session !== undefined && cursor.session !== undefined && compareVersion(event.session, cursor.session) < 0) return false
  if (event.settingsVersion !== undefined && cursor.settingsVersion !== undefined && compareVersion(event.settingsVersion, cursor.settingsVersion) < 0) return false
  if (event.timestamp && cursor.timestamp && Date.parse(event.timestamp) < Date.parse(cursor.timestamp)) return false
  return true
}

export function mergeFreshEventCursor(cursor: EventFreshnessCursor, event: CanonicalEvent): EventFreshnessCursor {
  if (!isCanonicalEventFresh(event, cursor)) return cursor
  return {
    connectionId: event.connectionId || cursor.connectionId,
    symbol: event.symbol || cursor.symbol,
    epoch: event.epoch !== undefined ? Math.max(cursor.epoch ?? event.epoch, event.epoch) : cursor.epoch,
    session: event.session ?? cursor.session,
    settingsVersion: event.settingsVersion ?? cursor.settingsVersion,
    timestamp: event.timestamp || cursor.timestamp,
  }
}
