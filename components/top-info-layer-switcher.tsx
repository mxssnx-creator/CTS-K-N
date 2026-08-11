"use client"

import { useEffect, useState } from "react"
import { Check, CircuitBoard } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  applyTopInfoLayer,
  DEFAULT_TOP_INFO_LAYER,
  normalizeTopInfoLayer,
  TOP_INFO_LAYER_OPTIONS,
  TOP_INFO_LAYER_STORAGE_KEY,
  type TopInfoLayerId,
} from "@/lib/top-info-layer"

export function TopInfoLayerSwitcher() {
  const [layer, setLayer] = useState<TopInfoLayerId>(DEFAULT_TOP_INFO_LAYER)

  useEffect(() => {
    const saved = normalizeTopInfoLayer(window.localStorage.getItem(TOP_INFO_LAYER_STORAGE_KEY))
    setLayer(saved)
    applyTopInfoLayer(document.documentElement, saved)
  }, [])

  const selectLayer = (next: TopInfoLayerId) => {
    setLayer(next)
    applyTopInfoLayer(document.documentElement, next)
    window.localStorage.setItem(TOP_INFO_LAYER_STORAGE_KEY, next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          aria-label="Choose top information layer"
          title="Choose top information layer"
        >
          <CircuitBoard className="h-3.5 w-3.5" />
          <span className="sr-only">Top info layer</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Top info layer</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {TOP_INFO_LAYER_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.id}
            onClick={() => selectLayer(option.id)}
            className="items-start gap-2 py-2"
          >
            <Check className={`mt-0.5 h-4 w-4 shrink-0 ${layer === option.id ? "opacity-100" : "opacity-0"}`} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-xs text-muted-foreground">{option.description}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
