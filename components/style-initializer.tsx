"use client"

import { useEffect } from "react"

export function StyleInitializer() {
  useEffect(() => {
    try {
      // Apply saved style variant on mount
      if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
        const savedStyle = localStorage.getItem("style-variant") || "default"
        const root = document.documentElement

        root.classList.remove("style-default", "style-new-york", "style-minimal", "style-rounded", "style-compact")
        root.classList.add(`style-${savedStyle}`)
      }
    } catch (error) {
      console.error("[v0] StyleInitializer error:", error)
    }
  }, [])

  return null
}
