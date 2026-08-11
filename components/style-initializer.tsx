"use client"

import { useEffect } from "react"
import {
  applyTopInfoLayer,
  normalizeTopInfoLayer,
  TOP_INFO_LAYER_STORAGE_KEY,
} from "@/lib/top-info-layer"

const VALID_STYLES = new Set(["default", "new-york", "minimal", "rounded", "compact"])

export function StyleInitializer() {
  useEffect(() => {
    try {
      // Apply saved style variant on mount
      if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
        const storedStyle = localStorage.getItem("style-variant")
        const savedStyle = storedStyle && VALID_STYLES.has(storedStyle) ? storedStyle : "default"
        const root = document.documentElement

        root.classList.remove("style-default", "style-new-york", "style-minimal", "style-rounded", "style-compact")
        root.classList.add(`style-${savedStyle}`)

        const savedTopInfoLayer = normalizeTopInfoLayer(localStorage.getItem(TOP_INFO_LAYER_STORAGE_KEY))
        applyTopInfoLayer(root, savedTopInfoLayer)
      }
    } catch (error) {
      console.error("[v0] StyleInitializer error:", error)
    }
  }, [])

  return null
}
