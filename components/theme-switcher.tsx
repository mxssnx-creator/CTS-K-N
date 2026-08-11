"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Check, Circle, Moon, Palette, Sun, Waves } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const themeOptions = [
  { id: "light", label: "Control Light", description: "Balanced operational contrast", icon: Sun },
  { id: "dark", label: "Night Operations", description: "Low-glare dark control room", icon: Moon },
  { id: "white", label: "Clear White", description: "High-clarity neutral workspace", icon: Sun },
  { id: "grey", label: "Tactical Grey", description: "Muted analytical surfaces", icon: Palette },
  { id: "blackwhite", label: "Monochrome", description: "Pure black-and-white hierarchy", icon: Circle },
  { id: "whiteactive", label: "Signal Blue", description: "Bright active-monitoring palette", icon: Waves },
] as const

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Choose color theme" disabled>
        <Sun className="h-3.5 w-3.5" />
        <span className="sr-only">Choose color theme</span>
      </Button>
    )
  }

  const activeTheme = themeOptions.find((option) => option.id === theme) ?? themeOptions[0]
  const ActiveIcon = activeTheme.icon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-sidebar-foreground/65 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          aria-label={`Color theme: ${activeTheme.label}`}
          title={`Color theme: ${activeTheme.label}`}
        >
          <ActiveIcon className="h-3.5 w-3.5" />
          <span className="sr-only">Choose color theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Color environment</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {themeOptions.map((option) => {
          const Icon = option.icon
          const isActive = option.id === activeTheme.id
          return (
            <DropdownMenuItem
              key={option.id}
              onSelect={() => setTheme(option.id)}
              className="items-start gap-2 py-2"
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.description}</span>
              </span>
              <Check className={`mt-0.5 h-4 w-4 shrink-0 ${isActive ? "opacity-100" : "opacity-0"}`} />
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
