"use client"

import { useEffect, useState } from "react"
import { Check, Circle, Hexagon, Minimize2, Shapes, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type StyleVariant = "default" | "new-york" | "minimal" | "rounded" | "compact"

const styleOptions: Array<{
  id: StyleVariant
  label: string
  description: string
  icon: typeof Square
}> = [
  { id: "default", label: "Control", description: "Balanced spacing and depth", icon: Square },
  { id: "new-york", label: "Dense Grid", description: "Sharp, information-first panels", icon: Shapes },
  { id: "minimal", label: "Minimal", description: "Flat surfaces and quiet borders", icon: Circle },
  { id: "rounded", label: "Fluid", description: "Open spacing and soft geometry", icon: Hexagon },
  { id: "compact", label: "Compact", description: "Maximum operational density", icon: Minimize2 },
]

function isStyleVariant(value: string | null): value is StyleVariant {
  return styleOptions.some((option) => option.id === value)
}

function applyStyle(variant: StyleVariant) {
  const root = document.documentElement
  root.classList.remove("style-default", "style-new-york", "style-minimal", "style-rounded", "style-compact")
  root.classList.add(`style-${variant}`)
  localStorage.setItem("style-variant", variant)
}

export function StyleSwitcher() {
  const [style, setStyle] = useState<StyleVariant>("default")

  useEffect(() => {
    const savedStyle = localStorage.getItem("style-variant")
    const nextStyle = isStyleVariant(savedStyle) ? savedStyle : "default"
    applyStyle(nextStyle)
    setStyle(nextStyle)
  }, [])

  const selectStyle = (variant: StyleVariant) => {
    applyStyle(variant)
    setStyle(variant)
  }

  const activeStyle = styleOptions.find((option) => option.id === style) ?? styleOptions[0]
  const ActiveIcon = activeStyle.icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          aria-label={`Interface density: ${activeStyle.label}`}
          title={`Interface density: ${activeStyle.label}`}
        >
          <ActiveIcon className="h-3.5 w-3.5" />
          <span className="sr-only">Choose interface density</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Interface density</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {styleOptions.map((option) => {
          const Icon = option.icon
          return (
            <DropdownMenuItem
              key={option.id}
              onSelect={() => selectStyle(option.id)}
              className="items-start gap-2 py-2"
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.description}</span>
              </span>
              <Check className={`mt-0.5 h-4 w-4 shrink-0 ${style === option.id ? "opacity-100" : "opacity-0"}`} />
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
