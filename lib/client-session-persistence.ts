/**
 * Client-side Session Persistence
 * Maintains UI state, navigation, and user progress across page refreshes
 * Durable UI preferences are stored in localStorage so reloads, closed tabs,
 * and long gaps do not create a new apparent site/session. Canonical engine
 * state still comes from Redis; this cache only avoids UI resets while the
 * first fresh API response is loading.
 */

const SESSION_STORAGE_KEY = "cts-v-session-state"
const SESSION_VERSION = "2.0"

export interface SessionState {
  version: string
  timestamp: number
  clientSessionId: string
  // Navigation state
  currentPage: string
  navigationHistory: string[]
  // UI state
  sidebarCollapsed?: boolean
  expandedSections?: Record<string, boolean>
  selectedFilters?: Record<string, any>
  // Trading state
  selectedSymbols?: string[]
  selectedConnection?: string
  activeStrategies?: string[]
  // Scroll positions
  scrollPositions?: Record<string, number>
  // Settings
  userPreferences?: Record<string, any>
}

function createClientSessionId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return `client_${uuid}`
  } catch {}
  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
}

function normalizeSessionState(value: unknown): SessionState | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Partial<SessionState>
  const defaults = getDefaultSessionState()
  return {
    ...defaults,
    ...raw,
    version: SESSION_VERSION,
    timestamp: Number.isFinite(Number(raw.timestamp)) ? Number(raw.timestamp) : Date.now(),
    clientSessionId: String(raw.clientSessionId || defaults.clientSessionId),
    currentPage: typeof raw.currentPage === "string" ? raw.currentPage : defaults.currentPage,
    navigationHistory: Array.isArray(raw.navigationHistory)
      ? raw.navigationHistory.filter((item): item is string => typeof item === "string").slice(-20)
      : defaults.navigationHistory,
  }
}

/**
 * Save durable client UI state.
 */
export function saveSessionState(state: Partial<SessionState>): void {
  try {
    if (typeof window === "undefined") return // Server-side

    const currentState = getSessionState() || getDefaultSessionState()
    const mergedState: SessionState = {
      ...currentState,
      ...state,
      timestamp: Date.now(),
    }

    const serialized = JSON.stringify(mergedState)
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, serialized)
    } catch {
      sessionStorage.setItem(SESSION_STORAGE_KEY, serialized)
    }
  } catch (error) {
    console.error("[v0] Error saving session state:", error)
  }
}

/**
 * Load durable state, migrating the legacy tab-scoped v1 payload once.
 */
export function getSessionState(): SessionState | null {
  if (typeof window === "undefined") return null

  try {
    const durable = localStorage.getItem(SESSION_STORAGE_KEY)
    if (durable) return normalizeSessionState(JSON.parse(durable))
  } catch {
    // Fall through to the tab-scoped compatibility store.
  }

  try {
    const legacy = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!legacy) return null
    const migrated = normalizeSessionState(JSON.parse(legacy))
    if (migrated) {
      try {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(migrated))
        sessionStorage.removeItem(SESSION_STORAGE_KEY)
      } catch {
        // localStorage may be unavailable in a restricted browser context.
      }
    }
    return migrated
  } catch {
    return null
  }
}

/**
 * Get default session state
 */
export function getDefaultSessionState(): SessionState {
  return {
    version: SESSION_VERSION,
    timestamp: Date.now(),
    clientSessionId: createClientSessionId(),
    currentPage: "/",
    navigationHistory: ["/"],
    sidebarCollapsed: false,
    expandedSections: {},
    selectedFilters: {},
    scrollPositions: {},
    userPreferences: {},
  }
}

/**
 * Update current page in session
 */
export function setCurrentPage(page: string): void {
  const state = getSessionState() || getDefaultSessionState()
  const history = state.navigationHistory || []

  // Add to history if different from current
  if (history[history.length - 1] !== page) {
    history.push(page)
    // Keep only last 20 pages
    if (history.length > 20) {
      history.shift()
    }
  }

  saveSessionState({
    currentPage: page,
    navigationHistory: history,
  })
}

/**
 * Save scroll position for a page
 */
export function saveScrollPosition(pageId: string, position: number): void {
  const state = getSessionState() || getDefaultSessionState()
  const positions = state.scrollPositions || {}
  positions[pageId] = position
  saveSessionState({ scrollPositions: positions })
}

/**
 * Get scroll position for a page
 */
export function getScrollPosition(pageId: string): number {
  const state = getSessionState()
  return state?.scrollPositions?.[pageId] ?? 0
}

/**
 * Save UI section expansion state
 */
export function setSectionExpanded(sectionId: string, expanded: boolean): void {
  const state = getSessionState() || getDefaultSessionState()
  const sections = state.expandedSections || {}
  sections[sectionId] = expanded
  saveSessionState({ expandedSections: sections })
}

/**
 * Get UI section expansion state
 */
export function isSectionExpanded(sectionId: string, defaultValue: boolean = true): boolean {
  const state = getSessionState() || getDefaultSessionState()
  const sections = state.expandedSections || {}
  return sections[sectionId] ?? defaultValue
}

/**
 * Save selected trading parameters
 */
export function setTradingSelection(selection: {
  symbols?: string[]
  connection?: string
  strategies?: string[]
}): void {
  saveSessionState({
    selectedSymbols: selection.symbols,
    selectedConnection: selection.connection,
    activeStrategies: selection.strategies,
  })
}

/**
 * Get selected trading parameters
 */
export function getTradingSelection(): {
  symbols: string[]
  connection: string | null
  strategies: string[]
} {
  const state = getSessionState()
  return {
    symbols: state?.selectedSymbols ?? [],
    connection: state?.selectedConnection ?? null,
    strategies: state?.activeStrategies ?? [],
  }
}

/**
 * Clear session state (for logout or fresh start)
 */
export function clearSessionState(): void {
  try {
    if (typeof window !== "undefined") {
      sessionStorage.removeItem(SESSION_STORAGE_KEY)
      localStorage.removeItem(SESSION_STORAGE_KEY)
    }
  } catch (error) {
    console.error("[v0] Error clearing session state:", error)
  }
}

/**
 * Initialize session restoration on page load
 */
export function initializeSessionRestoration(): void {
  try {
    if (typeof window === "undefined") return

    const state = getSessionState()
    if (!state) {
      saveSessionState(getDefaultSessionState())
      return
    }

    console.log("[v0] Session restored:", {
      page: state.currentPage,
      age: Math.round((Date.now() - state.timestamp) / 1000) + "s",
      historyLength: state.navigationHistory?.length,
    })

    // Restore scroll positions
    if (state.scrollPositions && Object.keys(state.scrollPositions).length > 0) {
      // Wait for DOM to settle, then restore scroll
      setTimeout(() => {
        Object.entries(state.scrollPositions || {}).forEach(([pageId, position]) => {
          const element = document.getElementById(pageId)
          if (element && typeof position === "number") {
            element.scrollTop = position
          }
        })
      }, 100)
    }
  } catch (error) {
    console.error("[v0] Error initializing session restoration:", error)
  }
}

/**
 * Create session state synchronizer hook for React components
 */
export function useSessionState<T extends keyof SessionState>(
  key: T,
  defaultValue: SessionState[T]
): [SessionState[T], (value: SessionState[T]) => void] {
  const getValue = (): SessionState[T] => {
    const state = getSessionState()
    return (state?.[key] ?? defaultValue) as SessionState[T]
  }

  const setValue = (value: SessionState[T]) => {
    saveSessionState({ [key]: value } as any)
  }

  return [getValue(), setValue]
}
