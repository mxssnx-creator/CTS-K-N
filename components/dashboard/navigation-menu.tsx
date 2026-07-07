"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { Activity, Target, Zap, TrendingUp, PieChart, Cog, Calculator, Layers, Home, Monitor, Bot, Truck, MapPin } from "lucide-react"

const menuItems = [
  {
    title: "Active Exchange",
    href: "/active-exchange",
    icon: "Activity",
    description: "Statistics and prehistoric data for selected active connection",
  },
  {
    title: "Overview",
    href: "/",
    icon: "Home",
    description: "Main dashboard and trading overview",
  },
  {
    title: "Live Trading",
    href: "/live-trading",
    icon: "Activity",
    description: "Monitor active positions and trading activity",
  },
  {
    title: "Presets & Bots",
    href: "/presets",
    icon: "Bot",
    description: "Automated trading with preset-based strategies",
  },
  {
    title: "Tracking",
    href: "/tracking",
    icon: "MapPin",
    description: "Track positions, progression, and trading activity",
  },
  {
    title: "Presets",
    href: "/presets",
    icon: "Target",
    description: "Manage trading presets and configurations",
  },
  {
    title: "Indications",
    href: "/indications",
    icon: "Zap",
    description: "Configure and monitor trading indications",
  },
  {
    title: "Strategies",
    href: "/strategies",
    icon: "TrendingUp",
    description: "Manage and optimize trading strategies",
  },
  {
    title: "Statistics",
    href: "/statistics",
    icon: "PieChart",
    description: "View detailed trading statistics and analytics",
  },
  {
    title: "Position Analysis",
    href: "/analysis",
    icon: "Calculator",
    description: "Analyze pseudo positions and database load per symbol",
  },
  {
    title: "Logistics",
    href: "/logistics",
    icon: "Truck",
    description: "System logistics, order queue, and processing metrics",
  },
  {
    title: "Structure",
    href: "/structure",
    icon: "Layers",
    description: "System workability, logistics, and functionality overview",
  },
  {
    title: "Monitoring",
    href: "/monitoring",
    icon: "Monitor",
    description: "System states, logs, errors, and diagnostics",
  },
  {
    title: "Settings",
    href: "/settings",
    icon: "Cog",
    description: "Configure system settings and connections",
  },
]

const iconMap = {
  Home,
  Activity,
  Bot,
  Target,
  Zap,
  TrendingUp,
  PieChart,
  Calculator,
  Layers,
  Truck,
  Monitor,
  MapPin,
  Cog,
}

export function NavigationMenu() {
  const pathname = usePathname()

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {menuItems.map((item) => {
        const isActive = pathname === item.href
        const Icon = iconMap[item.icon as keyof typeof iconMap]
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "group relative overflow-hidden rounded-lg border p-6 transition-all hover:shadow-md",
              isActive ? "border-primary bg-primary/5 shadow-sm" : "border-border hover:border-primary/50",
            )}
          >
            <div className="flex items-start space-x-4">
              <div
                className={cn(
                  "rounded-lg p-2 transition-colors text-2xl",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted group-hover:bg-primary group-hover:text-primary-foreground",
                )}
              >
                <Icon className="w-6 h-6" />
              </div>
              <div className="flex-1 space-y-1">
                <h3 className="font-semibold text-lg">{item.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.description}</p>
              </div>
            </div>

            {/* Hover effect */}
            <div className="absolute inset-0 bg-gradient-to-r from-primary/0 via-primary/5 to-primary/0 opacity-0 transition-opacity group-hover:opacity-100" />
          </Link>
        )
      })}
    </div>
  )
}
