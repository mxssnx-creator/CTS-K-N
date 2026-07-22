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
        const allowAggressiveBrowserBootstrap =
          process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ALLOW_BROWSER_BOOTSTRAP === "1"

        console.log(
          `[v0] [EngineAutoInitializer] Checking server initialization status (aggressive=${allowAggressiveBrowserBootstrap})...`,
        )

        if (allowAggressiveBrowserBootstrap) {
          // Development (and explicitly opted-in deployments) keep the old
          // aggressive browser bootstrap behavior so local reloads recover all
          // loops immediately while debugging.
          await fetch("/api/system/initialize", { method: "POST", cache: "no-store" }).catch(() => {})
          await fetch("/api/trade-engine/auto-start", { method: "POST", cache: "no-store" }).catch(() => {})
          console.log("[v0] [EngineAutoInitializer] ✅ Aggressive browser bootstrap requested")
          return
        }

        // Production should normally be booted by Next.js instrumentation and
        // continuity. Use a lightweight read-only status route first and only
        // fall back to full initialization when the server explicitly reports
        // incomplete startup or unhealthy state.
        const statusResponse = await fetch("/api/system/init-status", { method: "GET", cache: "no-store" })
        const status = await statusResponse.json().catch(() => null)
        const startup = status?.system?.startup || status?.startup
        const instrumentationBootCompleted = Boolean(startup?.instrumentationBootCompletedAt || startup?.completed_at)
        const startupIncomplete =
          !statusResponse.ok ||
          status?.status === "error" ||
          status?.status === "unhealthy" ||
          status?.initialized === false ||
          status?.ready === false ||
          startup?.completed === false ||
          (startup && instrumentationBootCompleted === false)

        if (startupIncomplete) {
          console.warn(
            "[v0] [EngineAutoInitializer] Server startup status is incomplete/unhealthy; requesting system initialization",
            status,
          )
          await fetch("/api/system/initialize", { method: "POST", cache: "no-store" }).catch(() => {})
        } else {
          console.log("[v0] [EngineAutoInitializer] ✅ Server startup already complete; browser bootstrap skipped")
        }
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

  useEffect(() => {
    const kiloHost = window.location.hostname.toLowerCase().endsWith(".kiloapps.io")
    if (process.env.NEXT_PUBLIC_KILO_DASHBOARD_PULSE !== "1" && !kiloHost) return
    let cancelled = false
    let inFlight = false
    const pulse = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return
      inFlight = true
      try {
        await fetch("/api/runtime/dashboard-pulse", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: { "x-cts-dashboard-pulse": "1" },
        })
      } catch {
        // The normal status widgets surface continuity failures. Avoid a noisy
        // console loop when the operator session expires or connectivity drops.
      } finally {
        inFlight = false
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") void pulse()
    }
    const initial = window.setTimeout(() => void pulse(), 1_500)
    const interval = window.setInterval(() => void pulse(), 60_000)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      cancelled = true
      window.clearTimeout(initial)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  // This component renders nothing, it only performs initialization
  return null
}
