"use client"

import { useEffect, useState, useCallback } from "react"
import { useExchange } from "./exchange-context"
import type { ConnectionSettings } from "./connection-settings"

/**
 * Hook to get and manage settings for the current connection
 * Automatically updates when connection changes
 */
export function useConnectionSettings() {
  const { selectedConnectionId } = useExchange()
  const [settings, setSettings] = useState<ConnectionSettings | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load settings for current connection
  const loadSettings = useCallback(async () => {
    if (!selectedConnectionId) return

    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/settings/connection-settings?connectionId=${selectedConnectionId}`)

      if (!response.ok) {
        throw new Error("Failed to load settings")
      }

      const data = await response.json()
      setSettings(data)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error"
      setError(errorMessage)
      console.error("Failed to load connection settings:", err)
    } finally {
      setIsLoading(false)
    }
  }, [selectedConnectionId])

  // Reload when connection changes
  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  // Update settings
  const updateSettings = useCallback(
    async (updates: Partial<ConnectionSettings>) => {
      if (!selectedConnectionId) return

      try {
        const response = await fetch("/api/settings/connection-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId: selectedConnectionId,
            settings: updates,
          }),
        })

        if (!response.ok) {
          throw new Error("Failed to update settings")
        }

        const data = await response.json()
        setSettings(data.settings)
        return data.settings
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error"
        setError(errorMessage)
        console.error("Failed to update connection settings:", err)
        throw err
      }
    },
    [selectedConnectionId]
  )

  // Reset to defaults
  const resetSettings = useCallback(async () => {
    if (!selectedConnectionId) return

    try {
      const response = await fetch("/api/settings/connection-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: selectedConnectionId,
          action: "reset",
        }),
      })

      if (!response.ok) {
        throw new Error("Failed to reset settings")
      }

      const data = await response.json()
      setSettings(data.settings)
      return data.settings
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error"
      setError(errorMessage)
      console.error("Failed to reset connection settings:", err)
      throw err
    }
  }, [selectedConnectionId])

  return {
    settings,
    isLoading,
    error,
    updateSettings,
    resetSettings,
    refresh: loadSettings,
  }
}

/**
 * Hook to get strategy settings for current connection
 */
export function useConnectionStrategySettings() {
  const { settings, isLoading, error, updateSettings } = useConnectionSettings()

  const updateStrategy = useCallback(
    async (strategyUpdates: Partial<ConnectionSettings["strategy"]>) => {
      if (!settings) return
      return updateSettings({
        ...settings,
        strategy: { ...settings.strategy, ...strategyUpdates },
      })
    },
    [settings, updateSettings]
  )

  return {
    strategy: settings?.strategy || null,
    isLoading,
    error,
    updateStrategy,
  }
}

/**
 * Hook to get indication settings for current connection
 */
export function useConnectionIndicationSettings() {
  const { settings, isLoading, error, updateSettings } = useConnectionSettings()

  const updateIndication = useCallback(
    async (indicationUpdates: Partial<ConnectionSettings["indication"]>) => {
      if (!settings) return
      return updateSettings({
        ...settings,
        indication: { ...settings.indication, ...indicationUpdates },
      })
    },
    [settings, updateSettings]
  )

  return {
    indication: settings?.indication || null,
    isLoading,
    error,
    updateIndication,
  }
}

/**
 * Hook to get trading settings for current connection
 */
export function useConnectionTradingSettings() {
  const { settings, isLoading, error, updateSettings } = useConnectionSettings()

  const updateTrading = useCallback(
    async (tradingUpdates: Partial<ConnectionSettings["trading"]>) => {
      if (!settings) return
      return updateSettings({
        ...settings,
        trading: { ...settings.trading, ...tradingUpdates },
      })
    },
    [settings, updateSettings]
  )

  return {
    trading: settings?.trading || null,
    isLoading,
    error,
    updateTrading,
  }
}
