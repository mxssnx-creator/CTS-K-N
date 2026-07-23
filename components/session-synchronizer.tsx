"use client"

import { useEffect } from "react"
import {
  initializeSessionRestoration,
  saveSessionState,
  synchronizeSessionSiteInstance,
  getRunningState,
  setRunningState,
} from "@/lib/client-session-persistence"

/**
 * SessionSynchronizer - Client component that ensures continuous session state
 * across page refreshes, navigations, and rebuilds.
 *
 * This component:
 * 1. Restores session state on initial load
 * 2. Periodically syncs session state to ensure data continuity
 * 3. Saves scroll positions and UI state
 * 4. Maintains navigation history
 * 5. Syncs running state with server for continuous operation
 */
export function SessionSynchronizer() {
  useEffect(() => {
    // Initialize session on mount
    initializeSessionRestoration()

    // Sync running state with server on mount
    const syncRunningStateWithServer = async () => {
      try {
        const response = await fetch("/api/system/init-status", { cache: "no-store" })
        const payload = await response.json().catch(() => null)
        const serverRunning = payload?.system?.engine_running === true
        
        // Update local state to match server
        const localRunning = getRunningState()
        if (localRunning !== serverRunning) {
          console.log(`[v0] Syncing running state: local=${localRunning}, server=${serverRunning}`)
          setRunningState(serverRunning)
          window.dispatchEvent(new CustomEvent("cts:running-state-changed", {
            detail: { running: serverRunning, source: "server-sync" }
          }))
        }
      } catch (err) {
        console.warn("[v0] Failed to sync running state with server:", err)
      }
    }
    void syncRunningStateWithServer()

    // Periodically save session state (every 30 seconds)
    const syncInterval = setInterval(() => {
      saveSessionState({
        timestamp: Date.now(),
      })
    }, 30 * 1000)

    // Save session on page visibility change (tab becomes visible)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.log("[v0] Page became visible, syncing session state")
        saveSessionState({
          timestamp: Date.now(),
        })
        void synchronizeSiteIdentity()
      }
    }

    // Save session before unload (page refresh/close)
    const handleBeforeUnload = () => {
      try {
        saveSessionState({
          timestamp: Date.now(),
        })
      } catch {
        // Ignore errors during unload
      }
    }

    let identityRequestInFlight = false
    const synchronizeSiteIdentity = async () => {
      if (identityRequestInFlight) return
      identityRequestInFlight = true
      try {
        const response = await fetch("/api/system/init-status", { cache: "no-store" })
        const payload = await response.json().catch(() => null)
        const siteInstanceId = String(payload?.system?.site_instance_id || "").trim()
        if (!siteInstanceId) return
        const result = synchronizeSessionSiteInstance(siteInstanceId)
        document.documentElement.dataset.ctsSiteInstance = siteInstanceId
        window.dispatchEvent(new CustomEvent("cts:site-instance", {
          detail: { siteInstanceId, changed: result.changed, previousSiteInstanceId: result.previousSiteInstanceId },
        }))
      } catch {
        // A transient status failure must never create an apparent new site.
      } finally {
        identityRequestInFlight = false
      }
    }
    const identityInterval = window.setInterval(() => {
      void synchronizeSiteIdentity()
    }, 60_000)

    let scrollSaveTimer: ReturnType<typeof setTimeout> | undefined
    // localStorage writes are synchronous. Debounce scroll persistence so a
    // fast scroll does one compact write instead of hundreds on the UI thread.
    const handleScroll = () => {
      if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
      scrollSaveTimer = setTimeout(() => {
        try {
          const scrollTop = window.scrollY || document.documentElement.scrollTop
          const mainContent = document.querySelector("main")
          if (mainContent) {
            saveSessionState({
              scrollPositions: {
                main: mainContent.scrollTop,
                window: scrollTop,
              },
            })
          }
        } catch {
          // Ignore scroll tracking errors
        }
      }, 200)
    }

    // Listen for engine state changes from server
    const handleEngineStateChanged = (e: Event) => {
      const ev = e as CustomEvent
      const running = ev.detail?.running
      if (typeof running === "boolean") {
        setRunningState(running)
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("beforeunload", handleBeforeUnload)
    window.addEventListener("pagehide", handleBeforeUnload)
    window.addEventListener("scroll", handleScroll, { passive: true })
    window.addEventListener("cts:running-state-changed", handleEngineStateChanged)
    void synchronizeSiteIdentity()

    // Cleanup
    return () => {
      clearInterval(syncInterval)
      window.clearInterval(identityInterval)
      if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("beforeunload", handleBeforeUnload)
      window.removeEventListener("pagehide", handleBeforeUnload)
      window.removeEventListener("scroll", handleScroll)
      window.removeEventListener("cts:running-state-changed", handleEngineStateChanged)
    }
  }, [])

  return null // This component doesn't render anything
}

/**
 * ProgressTracker - Ensures trading engine progress persists across sessions
 */
export function ProgressTracker() {
  useEffect(() => {
    // Monitor trading engine progress
    const checkProgress = async () => {
      try {
        const response = await fetch("/api/persistence/status")
        if (response.ok) {
          const data = await response.json()
          console.log("[v0] Persistence status:", {
            keys: data.database?.keys,
            memory_mb: data.database?.memory_mb,
            last_snapshot: data.recovery?.last_snapshot,
          })
        }
      } catch (error) {
        // Silently ignore - this is just status monitoring
      }
    }

    // Check on mount and periodically
    checkProgress()
    const interval = setInterval(checkProgress, 5 * 60 * 1000) // Every 5 minutes

    return () => clearInterval(interval)
  }, [])

  return null // This component doesn't render anything
}
