"use client"

import type React from "react"
import { useEffect } from "react"
import { SiteLogger } from "@/lib/site-logger"

export function SiteLoggerProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Only run on client side
    if (typeof window === "undefined") {
      return
    }

    const timer = setTimeout(() => {
      try {
        console.log("[v0] Initializing site logger...")
        SiteLogger.initialize()

        SiteLogger.info("Application", "CTS v3 initialized", {
          userAgent: navigator.userAgent,
          language: navigator.language,
          platform: navigator.platform,
          screenResolution: `${window.screen.width}x${window.screen.height}`,
        })
        console.log("[v0] Site logger initialized successfully")
      } catch (error) {
        console.error("[v0] Failed to initialize site logger:", error)
      }
    }, 100)

    const handleOnline = () => {
      try {
        SiteLogger.info("Network", "Connection restored", {
          online: navigator.onLine,
        })
      } catch (error) {
        console.error("[v0] Failed to log online event:", error)
      }
    }

    const handleOffline = () => {
      try {
        SiteLogger.warning("Network", "Connection lost", {
          online: navigator.onLine,
        })
      } catch (error) {
        console.error("[v0] Failed to log offline event:", error)
      }
    }

    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)

    return () => {
      clearTimeout(timer)
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  return <>{children}</>
}
