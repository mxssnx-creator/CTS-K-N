"use client"

import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from "react"
import type { ExchangeConnection } from "@/lib/types"

interface TradeEngineStatus {
  connectionId: string
  status: "idle" | "starting" | "running" | "stopped" | "failed"
  lastUpdated: number
  progressionData?: {
    cycles_completed: number
    successful_cycles: number
    cycle_success_rate: string
    trades: number
    positions: number
  }
}

interface ConnectionState {
  // Base connections (all connections from database) - used in Settings
  baseConnections: ExchangeConnection[]
  setBaseConnections: (connections: ExchangeConnection[]) => void
  loadBaseConnections: () => Promise<void>
  isBaseLoading: boolean
  baseConnectionStatuses: Map<string, { enabled: boolean; inserted: boolean }> // independent status tracking
  setBaseConnectionStatus: (id: string, enabled: boolean) => void
  markBaseAsInserted: (id: string) => void
  
  // ExchangeConnectionsActive (enabled only) - used in Dashboard with independent status
  exchangeConnectionsActive: ExchangeConnection[]
  setExchangeConnectionsActive: (connections: ExchangeConnection[]) => void
  loadExchangeConnectionsActive: () => Promise<void>
  isExchangeConnectionsActiveLoading: boolean
  
  // ExchangeConnectionsActive status management - independent from settings
  exchangeConnectionsActiveStatus: Map<string, boolean> // id -> is_active
  toggleExchangeConnectionsActiveStatus: (id: string) => void
  markExchangeAsInserted: (id: string) => void
  exchangeConnectionsInsertedStatus: Set<string>
  
  // Trade Engine Status - independent from connection status
  tradeEngineStatuses: Map<string, TradeEngineStatus>
  updateTradeEngineStatus: (connectionId: string, status: TradeEngineStatus) => void
  getTradeEngineStatus: (connectionId: string) => TradeEngineStatus | undefined
}

const ConnectionStateContext = createContext<ConnectionState | undefined>(undefined)
const toBoolean = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "true"

export function ConnectionStateProvider({ children }: { children: ReactNode }) {
  // Base connections state (Settings)
  const [baseConnections, setBaseConnections] = useState<ExchangeConnection[]>([])
  const [isBaseLoading, setIsBaseLoading] = useState(false)
  const [baseConnectionStatuses, setBaseConnectionStatuses] = useState<Map<string, { enabled: boolean; inserted: boolean }>>(new Map())
  
  // ExchangeConnectionsActive state (Dashboard - independent status)
  const [exchangeConnectionsActive, setExchangeConnectionsActive] = useState<ExchangeConnection[]>([])
  const [isExchangeConnectionsActiveLoading, setIsExchangeConnectionsActiveLoading] = useState(false)
  const [exchangeConnectionsActiveStatus, setExchangeConnectionsActiveStatus] = useState<Map<string, boolean>>(new Map())
  const [exchangeConnectionsInsertedStatus, setExchangeConnectionsInsertedStatus] = useState<Set<string>>(new Set())
  
  // Trade Engine Status - independent from connections
  const [tradeEngineStatuses, setTradeEngineStatuses] = useState<Map<string, TradeEngineStatus>>(new Map())
  
  // Prevent concurrent loads and excessive queries
  const loadingRef = useRef<{ base: boolean; active: boolean }>({ base: false, active: false })
  const lastLoadRef = useRef<{ base: number; active: number }>({ base: 0, active: 0 })
  // Ref to hold current exchangeConnectionsActiveStatus so async callbacks are never stale
  const activeStatusRef = useRef<Map<string, boolean>>(new Map())
  const LOAD_COOLDOWN = 5000 // 5 seconds between same-type loads (reduced from 30s for better UX)

  // Load all connections for Settings (single unified function)
  const loadBaseConnections = async () => {
    // Prevent concurrent requests
    if (loadingRef.current.base) return
    
    // Prevent excessive refreshes
    if (Date.now() - lastLoadRef.current.base < LOAD_COOLDOWN) return

    loadingRef.current.base = true
    setIsBaseLoading(true)
    try {
      const response = await fetch("/api/settings/connections")
      if (response.ok) {
        const data = await response.json()
        setBaseConnections(data.connections || [])
        
        // Initialize status map from persisted values to avoid visual switching/reset.
        const statusMap = new Map<string, { enabled: boolean; inserted: boolean }>()
        data.connections?.forEach((conn: ExchangeConnection) => {
          const isInserted = toBoolean((conn as any).is_inserted)
          const isEnabled = toBoolean((conn as any).is_enabled)
          
          statusMap.set(conn.id, { 
            enabled: isEnabled,
            inserted: isInserted,
          })
        })
        setBaseConnectionStatuses(statusMap)
        
        // Also update Active connections if any are marked as visible on dashboard
        const activeConns = data.connections?.filter((c: ExchangeConnection) => toBoolean((c as any).is_enabled_dashboard)) || []
        
        if (activeConns.length > 0) {
          setExchangeConnectionsActive(activeConns)
          // Reflect persisted dashboard toggle state directly.
          const activeStatusMap = new Map<string, boolean>()
          activeConns.forEach((conn: ExchangeConnection) => {
            activeStatusMap.set(conn.id, toBoolean((conn as any).is_enabled_dashboard))
          })
          setExchangeConnectionsActiveStatus(activeStatusMap)
        }
      }
    } catch (error) {
      console.error("[ConnectionState] Failed to load base connections:", error)
    } finally {
      loadingRef.current.base = false
      setIsBaseLoading(false)
      lastLoadRef.current.base = Date.now()
    }
  }

  // Load ALL BASE connections for Active Connections list
  // Shows primary dashboard exchanges (bybit, bingx) plus any explicitly assigned connections
  // The toggle controls is_enabled_dashboard (independent from Settings is_enabled)
  const loadExchangeConnectionsActive = async () => {
    // Prevent concurrent requests
    if (loadingRef.current.active) return
    
    // Prevent excessive refreshes
    if (Date.now() - lastLoadRef.current.active < LOAD_COOLDOWN) return

    loadingRef.current.active = true
    setIsExchangeConnectionsActiveLoading(true)
    try {
      const response = await fetch("/api/settings/connections")
      if (response.ok) {
        const data = await response.json()
        const allConnections = data.connections || []
        
        // Filter matches DashboardActiveConnectionsManager exactly:
        //   - BASE_EXCHANGES (bybit, bingx) always show
        //   - Non-base connections show only when explicitly assigned to Active panel
        //   - is_inserted alone does NOT qualify (that's Settings-level visibility)
        const BASE_EXCHANGES = ["bybit", "bingx"]
        const activeConns = allConnections.filter((c: any) => {
          const exchange = (c.exchange || "").toLowerCase().trim()
          const isBase = BASE_EXCHANGES.includes(exchange)
          const isActiveInserted = toBoolean(c.is_active_inserted) || toBoolean(c.is_dashboard_inserted)
          const isDashboardActive = toBoolean(c.is_enabled_dashboard)
          return isBase || isActiveInserted || isDashboardActive
        })
        
        setExchangeConnectionsActive(activeConns)
        
        // PRESERVE EXISTING DASHBOARD TOGGLE STATE — use ref to avoid stale closure
        // Only initialise status for new connections, preserve existing user toggle state
        const newStatusMap = new Map<string, boolean>(activeStatusRef.current)
        activeConns.forEach((conn: ExchangeConnection) => {
          if (!newStatusMap.has(conn.id)) {
            const isDashboardEnabled = toBoolean((conn as any).is_enabled_dashboard)
            newStatusMap.set(conn.id, isDashboardEnabled)
          }
        })
        activeStatusRef.current = newStatusMap
        setExchangeConnectionsActiveStatus(newStatusMap)
      }
    } catch (error) {
      console.error("[ConnectionState] Failed to load active connections:", error)
    } finally {
      loadingRef.current.active = false
      setIsExchangeConnectionsActiveLoading(false)
      lastLoadRef.current.active = Date.now()
    }
  }

  // Set base connection status (enabled/disabled)
  const setBaseConnectionStatus = (id: string, enabled: boolean) => {
    setBaseConnectionStatuses(prev => {
      const next = new Map(prev)
      const current = next.get(id) || { enabled: false, inserted: false }
      next.set(id, { ...current, enabled })
      return next
    })
  }

  // Mark base connection as inserted
  const markBaseAsInserted = (id: string) => {
    setBaseConnectionStatuses(prev => {
      const next = new Map(prev)
      const current = next.get(id) || { enabled: false, inserted: false }
      next.set(id, { ...current, inserted: true })
      return next
    })
    
    // Auto-clear after 5 seconds
    setTimeout(() => {
      setBaseConnectionStatuses(prev => {
        const next = new Map(prev)
        const current = next.get(id) || { enabled: false, inserted: false }
        next.set(id, { ...current, inserted: false })
        return next
      })
    }, 5000)
  }

  // Toggle Active Connection status independently (NEVER affects Settings)
  const toggleExchangeConnectionsActiveStatus = (id: string) => {
    setExchangeConnectionsActiveStatus(prev => {
      const next = new Map(prev)
      const currentStatus = next.get(id) ?? false
      const newStatus = !currentStatus
      next.set(id, newStatus)
      activeStatusRef.current = next
      
      return next
    })
  }

  // Mark exchange connection as inserted to active list
  const markExchangeAsInserted = (id: string) => {
    setExchangeConnectionsInsertedStatus(prev => new Set(prev).add(id))
    
    // Auto-clear after 5 seconds
    setTimeout(() => {
      setExchangeConnectionsInsertedStatus(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, 5000)
  }

  // Update trade engine status (independent from connection status)
  const updateTradeEngineStatus = (connectionId: string, status: TradeEngineStatus) => {
    setTradeEngineStatuses(prev => {
      const next = new Map(prev)
      next.set(connectionId, { ...status, lastUpdated: Date.now() })
      return next
    })
  }

  // Get trade engine status
  const getTradeEngineStatus = (connectionId: string): TradeEngineStatus | undefined => {
    return tradeEngineStatuses.get(connectionId)
  }

  // Auto-test base connections at startup and every 5 minutes
  const triggerAutoTest = async () => {
    try {
      await fetch("/api/settings/connections/auto-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    } catch {
      // Non-blocking: auto-test is best-effort
    }
  }

  // Initial load on mount
  useEffect(() => {
    loadBaseConnections()
    loadExchangeConnectionsActive()
    
    // Auto-test base connections at startup
    triggerAutoTest()
    
    // Refresh connection state every 30 seconds
    const refreshInterval = setInterval(() => {
      loadBaseConnections()
      loadExchangeConnectionsActive()
    }, 30000)
    
    // Auto-test base connections every 5 minutes
    const autoTestInterval = setInterval(triggerAutoTest, 5 * 60 * 1000)
    
    return () => {
      clearInterval(refreshInterval)
      clearInterval(autoTestInterval)
    }
  }, [])

  return (
    <ConnectionStateContext.Provider
      value={{
        baseConnections,
        setBaseConnections,
        loadBaseConnections,
        isBaseLoading,
        baseConnectionStatuses,
        setBaseConnectionStatus,
        markBaseAsInserted,
        exchangeConnectionsActive,
        setExchangeConnectionsActive,
        loadExchangeConnectionsActive,
        isExchangeConnectionsActiveLoading,
        exchangeConnectionsActiveStatus,
        toggleExchangeConnectionsActiveStatus,
        markExchangeAsInserted,
        exchangeConnectionsInsertedStatus,
        tradeEngineStatuses,
        updateTradeEngineStatus,
        getTradeEngineStatus,
      }}
    >
      {children}
    </ConnectionStateContext.Provider>
  )
}

export function useConnectionState() {
  const context = useContext(ConnectionStateContext)
  if (!context) {
    throw new Error("useConnectionState must be used within ConnectionStateProvider")
  }
  return context
}
