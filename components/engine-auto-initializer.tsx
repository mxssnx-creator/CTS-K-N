"use client"

import { useEffect, useRef } from "react"

/**
 * EngineAutoInitializer — bootstraps the Global Trade Engine Coordinator
 * (starts workers / progression loops) on dashboard mount.
 * Also seeds essential production data: settings, connections, market data.
 *
 * IMPORTANT STABILITY RULE:
 *   This component MUST NOT mutate connection assignment flags.
 *   Previously it also POSTed to /api/trade-engine/quick-start with
 *   action: "enable", which unconditionally wrote is_active_inserted="1"
 *   and is_enabled_dashboard="1" onto whichever BingX/Bybit connection it
 *   found. That bypassed the user's explicit choice and was the primary
 *   reason a deleted/disabled connection kept reappearing after every page
 *   load. Quick-start enable is now strictly an explicit user action via
 *   the QuickStart button.
 */
export function EngineAutoInitializer() {
  const initRef = useRef(false)
  const seedingRef = useRef(false)

  useEffect(() => {
    // Only initialize once per mount
    if (initRef.current) return
    initRef.current = true

    const initializeProduction = async () => {
      // Prevent multiple seeding attempts
      if (seedingRef.current) return
      seedingRef.current = true

      try {
        console.log("[v0] [EngineAutoInitializer] Starting production initialization...")

        // Trigger server-side initialization endpoint which performs the
        // unique site instance guarantee, seeds production data, and starts
        // the background coordinator. This avoids importing server-only
        // modules into a client component, which breaks the client bundle.
        try {
          await fetch("/api/system/initialize", { method: "POST", cache: "no-store" })
        } catch {
          /* non-critical */
        }

        // Also call auto-start to ensure coordinator loops are running
        await fetch("/api/trade-engine/auto-start", { method: "POST", cache: "no-store" }).catch(() => {})
        console.log("[v0] [EngineAutoInitializer] ✅ Production initialization (server-side) requested")
      } catch (error) {
        console.error("[v0] [EngineAutoInitializer] ❌ Production initialization failed:", error)
        // Don't throw - allow app to continue even if seeding fails
      } finally {
        seedingRef.current = false
      }
    }

    // Delay slightly to let Next.js finish hydration / layouts mount.
    const timer = setTimeout(initializeProduction, 1000)

    return () => clearTimeout(timer)
  }, [])

  // This component renders nothing, it only performs initialization
  return null
}
