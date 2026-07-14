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
  settingsVersionByDomain?: Partial<Record<VersionDomain, string | number>>
  timestamp?: string
}

type VersionDomain = "counter" | "timestamp" | "string"
type ComparableVersion = { kind: VersionDomain; value: number | string }

const canonicalEventGlobal = globalThis as typeof globalThis & {
  __canonical_event_sequences?: Map<string, number>
  __canonical_event_process_salt?: string
}
const sequenceByConnection = canonicalEventGlobal.__canonical_event_sequences ?? new Map<string, number>()
canonicalEventGlobal.__canonical_event_sequences = sequenceByConnection
const processSalt = canonicalEventGlobal.__canonical_event_process_salt ?? Math.random().toString(36).slice(2, 10)
canonicalEventGlobal.__canonical_event_process_salt = processSalt
const MAX_EVENT_SEQUENCE_SCOPES = 1_000

function nextId(connectionId: string, timestamp: string): string {
  if (!sequenceByConnection.has(connectionId) && sequenceByConnection.size >= MAX_EVENT_SEQUENCE_SCOPES) {
    const oldestScope = sequenceByConnection.keys().next().value
    if (oldestScope) sequenceByConnection.delete(oldestScope)
  }
  const next = (sequenceByConnection.get(connectionId) || 0) + 1
  sequenceByConnection.set(connectionId, next)
  return `${connectionId}:${Date.parse(timestamp) || Date.now()}:${next}:${processSalt}:${Math.random().toString(36).slice(2, 7)}`
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

function comparableVersion(value: unknown): ComparableVersion | null {
  if (value === undefined || value === null || value === "") return null
  const text = String(value)
  const numeric = Number(text)
  if (Number.isFinite(numeric)) {
    // Runtime switch generations are small monotonic counters, whereas
    // settings generations are commonly epoch milliseconds / ISO-derived.
    // They are independent domains and must never be ordered against each
    // other (e.g. timestamp 1.7e12 would otherwise make switch 42 stale).
    const timestampLike = /^\d{10,16}$/.test(text)
    return { kind: timestampLike ? "timestamp" : "counter", value: numeric }
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const parsedDate = Date.parse(text)
    if (Number.isFinite(parsedDate)) return { kind: "timestamp", value: parsedDate }
  }
  const embeddedTimestamp = text.match(/(?:^|:)(\d{10,16})(?::|$)/)?.[1]
  if (embeddedTimestamp) return { kind: "timestamp", value: Number(embeddedTimestamp) }
  return { kind: "string", value: text }
}

function compareVersion(a: unknown, b: unknown): number {
  const left = comparableVersion(a)
  const right = comparableVersion(b)
  if (!left || !right) return 0
  if (left.kind !== right.kind) return 0
  return left.kind !== "string"
    ? Number(left.value) - Number(right.value)
    : String(left.value).localeCompare(String(right.value))
}

export function isCanonicalEventFresh(event: Pick<CanonicalEvent, "epoch" | "session" | "settingsVersion" | "timestamp">, cursor: EventFreshnessCursor): boolean {
  // Generations are hierarchical: settings → progression epoch → session.
  // A newer epoch legitimately resets its session counter, so comparing every
  // coordinate independently would reject the first event of each new epoch.
  const eventSettingsVersion = comparableVersion(event.settingsVersion)
  const legacyCursorSettingsVersion = comparableVersion(cursor.settingsVersion)
  const domainCursorSettingsVersion = eventSettingsVersion
    ? cursor.settingsVersionByDomain?.[eventSettingsVersion.kind]
    : undefined
  const comparableCursorSettingsVersion =
    domainCursorSettingsVersion ??
    (eventSettingsVersion && legacyCursorSettingsVersion?.kind === eventSettingsVersion.kind
      ? cursor.settingsVersion
      : undefined)
  if (event.settingsVersion !== undefined && comparableCursorSettingsVersion !== undefined) {
    const comparison = compareVersion(event.settingsVersion, comparableCursorSettingsVersion)
    if (comparison !== 0) return comparison > 0
  } else if (event.settingsVersion !== undefined) {
    return true
  }
  if (event.epoch !== undefined && cursor.epoch !== undefined) {
    if (event.epoch !== cursor.epoch) return event.epoch > cursor.epoch
  } else if (event.epoch !== undefined) {
    return true
  }
  if (event.session !== undefined && cursor.session !== undefined) {
    const comparison = compareVersion(event.session, cursor.session)
    if (comparison !== 0) return comparison > 0
  } else if (event.session !== undefined) {
    return true
  }
  if (event.timestamp && cursor.timestamp && Date.parse(event.timestamp) < Date.parse(cursor.timestamp)) return false
  return true
}

export function mergeFreshEventCursor(cursor: EventFreshnessCursor, event: CanonicalEvent): EventFreshnessCursor {
  if (!isCanonicalEventFresh(event, cursor)) return cursor
  const cursorSettingsVersionDomain = comparableVersion(cursor.settingsVersion)?.kind
  const settingsVersionDomain = comparableVersion(event.settingsVersion)?.kind
  const settingsVersionByDomain: Partial<Record<VersionDomain, string | number>> = {
    ...cursor.settingsVersionByDomain,
  }
  if (
    cursorSettingsVersionDomain &&
    cursor.settingsVersion !== undefined &&
    settingsVersionByDomain[cursorSettingsVersionDomain] === undefined
  ) {
    settingsVersionByDomain[cursorSettingsVersionDomain] = cursor.settingsVersion
  }
  if (settingsVersionDomain && event.settingsVersion !== undefined) {
    settingsVersionByDomain[settingsVersionDomain] = event.settingsVersion
  }
  return {
    connectionId: event.connectionId || cursor.connectionId,
    symbol: event.symbol || cursor.symbol,
    // Direct assignment is intentional: a higher settings generation may
    // start a fresh, numerically lower epoch/session namespace.
    epoch: event.epoch ?? cursor.epoch,
    session: event.session ?? cursor.session,
    settingsVersion: event.settingsVersion ?? cursor.settingsVersion,
    settingsVersionByDomain: Object.keys(settingsVersionByDomain).length > 0
      ? settingsVersionByDomain
      : undefined,
    timestamp: event.timestamp || cursor.timestamp,
  }
}
