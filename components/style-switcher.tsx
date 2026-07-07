"use client"

import { useState, useEffect } from "react"
import { Shapes, Square, Circle, Hexagon, Minimize2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

type StyleVariant = "default" | "new-york" | "minimal" | "rounded" | "compact"

export function StyleSwitcher() {
  const [style, setStyle] = useState<StyleVariant>("default")

  useEffect(() => {
    const savedStyle = localStorage.getItem("style-variant") as StyleVariant
    if (savedStyle) {
      setStyle(savedStyle)
      applyStyle(savedStyle)
    }
  }, [])

  const applyStyle = (variant: StyleVariant) => {
    const root = document.documentElement

    root.classList.remove("style-default", "style-new-york", "style-minimal", "style-rounded", "style-compact")

    // Add the selected style class
    root.classList.add(`style-${variant}`)

    // Save to localStorage
    localStorage.setItem("style-variant", variant)
    setStyle(variant)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9">
          {style === "default" && <Square className="h-4 w-4" />}
          {style === "new-york" && <Shapes className="h-4 w-4" />}
          {style === "minimal" && <Circle className="h-4 w-4" />}
          {style === "rounded" && <Hexagon className="h-4 w-4" />}
          {style === "compact" && <Minimize2 className="h-4 w-4" />}
          <span className="sr-only">Toggle style</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => applyStyle("default")}>
          <Square className="mr-2 h-4 w-4" />
          <span>Default</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => applyStyle("new-york")}>
          <Shapes className="mr-2 h-4 w-4" />
          <span>New York</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => applyStyle("minimal")}>
          <Circle className="mr-2 h-4 w-4" />
          <span>Minimal</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => applyStyle("rounded")}>
          <Hexagon className="mr-2 h-4 w-4" />
          <span>Rounded</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => applyStyle("compact")}>
          <Minimize2 className="mr-2 h-4 w-4" />
          <span>Compact (Classic)</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
