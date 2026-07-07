"use client"

import { useTheme } from "next-themes"
import { Moon, Sun, Palette, Circle, Waves } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useEffect, useState } from "react"

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  // Prevent hydration mismatch by only rendering after mount
  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" className="h-9 w-9">
        <Sun className="h-4 w-4" />
        <span className="sr-only">Toggle theme</span>
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9">
          {theme === "dark" && <Moon className="h-4 w-4" />}
          {theme === "light" && <Sun className="h-4 w-4" />}
          {theme === "white" && <Sun className="h-4 w-4" />}
          {theme === "grey" && <Palette className="h-4 w-4" />}
          {theme === "blackwhite" && <Circle className="h-4 w-4" />}
          {theme === "whiteactive" && <Waves className="h-4 w-4" />}
          {!["dark", "light", "white", "grey", "blackwhite", "whiteactive"].includes(theme || "") && <Sun className="h-4 w-4" />}
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="mr-2 h-4 w-4" />
          <span>Light</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="mr-2 h-4 w-4" />
          <span>Dark</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("white")}>
          <Sun className="mr-2 h-4 w-4" />
          <span>White</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("grey")}>
          <Palette className="mr-2 h-4 w-4" />
          <span>Grey</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("blackwhite")}>
          <Circle className="mr-2 h-4 w-4" />
          <span>BlackWhite</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("whiteactive")}>
          <Waves className="mr-2 h-4 w-4" />
          <span>WhiteActive</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
