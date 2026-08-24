"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BarChart3, Layers3, RadioTower, Target } from "lucide-react"
import { Button } from "@/components/ui/button"

const SECTIONS = [
  { href: "/statistics", label: "Overall", icon: BarChart3 },
  { href: "/statistics/direct-trade", label: "Direct Trade", icon: Target },
  { href: "/statistics/indications/common", label: "Common Indications", icon: Layers3 },
  { href: "/statistics/indications/signal", label: "Signal Engine", icon: RadioTower },
] as const

export function StatisticsSectionNav() {
  const pathname = usePathname() || "/statistics"
  return (
    <nav
      aria-label="Statistics sections"
      className="relative z-10 -mx-1 grid grid-cols-1 gap-1 rounded-xl border bg-background/90 p-1 shadow-sm backdrop-blur min-[360px]:grid-cols-2 sm:flex sm:overflow-x-auto"
    >
      {SECTIONS.map((section) => {
        const active = pathname === section.href
        const Icon = section.icon
        return (
          <Button
            key={section.href}
            asChild
            size="sm"
            variant={active ? "default" : "ghost"}
            className="h-8 w-full min-w-0 rounded-lg px-2 text-[11px] sm:w-auto sm:shrink-0 sm:px-3 sm:text-xs"
          >
            <Link href={section.href}>
              <Icon className="mr-1.5 h-3.5 w-3.5" />
              {section.label}
            </Link>
          </Button>
        )
      })}
    </nav>
  )
}
