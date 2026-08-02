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
    <div className="sticky top-0 z-20 -mx-1 flex gap-1 overflow-x-auto rounded-xl border bg-background/90 p-1 shadow-sm backdrop-blur">
      {SECTIONS.map((section) => {
        const active = pathname === section.href
        const Icon = section.icon
        return (
          <Button
            key={section.href}
            asChild
            size="sm"
            variant={active ? "default" : "ghost"}
            className="h-8 shrink-0 rounded-lg px-3 text-xs"
          >
            <Link href={section.href}>
              <Icon className="mr-1.5 h-3.5 w-3.5" />
              {section.label}
            </Link>
          </Button>
        )
      })}
    </div>
  )
}
