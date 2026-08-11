"use client"

import type { LucideIcon } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Activity,
  AlarmClock,
  BarChart3,
  Bot,
  Boxes,
  Calculator,
  ChartNoAxesCombined,
  Cog,
  DatabaseZap,
  FlaskConical,
  Gauge,
  History,
  Home,
  Layers3,
  LineChart,
  LogOut,
  MapPin,
  MessageSquare,
  Network,
  RadioTower,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  TestTubeDiagonal,
  TrendingUp,
  Workflow,
  Zap,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { StyleSwitcher } from "@/components/style-switcher"
import { TopInfoLayerSwitcher } from "@/components/top-info-layer-switcher"
import { ExchangeSelectorTop } from "@/components/exchange-selector-top"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface NavigationItem {
  title: string
  href: string
  icon: LucideIcon
  description: string
}

interface NavigationGroup {
  label: string
  icon: LucideIcon
  items: NavigationItem[]
}

const navigationGroups: NavigationGroup[] = [
  {
    label: "Command",
    icon: Gauge,
    items: [
      { title: "Overview", href: "/", icon: Home, description: "Quickstart, engines, and account overview" },
      { title: "Active Exchange", href: "/active-exchange", icon: RadioTower, description: "Selected connection and market state" },
      { title: "Live Trading", href: "/live-trading", icon: Activity, description: "Orders, positions, and live execution" },
      { title: "Tracking", href: "/tracking", icon: MapPin, description: "Progression and execution lineage" },
    ],
  },
  {
    label: "Strategy Lab",
    icon: Sparkles,
    items: [
      { title: "Presets", href: "/presets", icon: Bot, description: "Ranked preset progression" },
      { title: "Indications", href: "/indications", icon: Zap, description: "Signal types and calculation windows" },
      { title: "Strategies", href: "/strategies", icon: TrendingUp, description: "Independent strategy configurations" },
      { title: "Configuration Sets", href: "/sets", icon: SlidersHorizontal, description: "Runtime set definitions and controls" },
    ],
  },
  {
    label: "Intelligence",
    icon: ChartNoAxesCombined,
    items: [
      { title: "Statistics", href: "/statistics", icon: BarChart3, description: "Trading, progression, and PF analytics" },
      { title: "Position Analysis", href: "/analysis", icon: Calculator, description: "Position ratios and result analysis" },
      { title: "Portfolios", href: "/portfolios", icon: LineChart, description: "Portfolio-level execution views" },
    ],
  },
  {
    label: "Operations",
    icon: Network,
    items: [
      { title: "Logistics", href: "/logistics", icon: Workflow, description: "Queues, batches, and processing flow" },
      { title: "Structure", href: "/structure", icon: Layers3, description: "System topology and stage relations" },
      { title: "Monitoring", href: "/monitoring", icon: Gauge, description: "Runtime health, logs, and resources" },
      { title: "Advanced Monitor", href: "/monitoring-advanced", icon: RadioTower, description: "SSE and broadcaster telemetry" },
      { title: "Alerts", href: "/alerts", icon: AlarmClock, description: "Operational and market alerts" },
      { title: "Settings", href: "/settings", icon: Cog, description: "Connections, engine, and strategy defaults" },
    ],
  },
]

const testingItems: NavigationItem[] = [
  { title: "Autotest & Debug", href: "/autotest", icon: FlaskConical, description: "Automated diagnostics and drift checks" },
  { title: "Connections", href: "/testing/connection", icon: Network, description: "Exchange connectivity validation" },
  { title: "Order Safety", href: "/testing/orders", icon: ShieldCheck, description: "Gated order lifecycle checks" },
  { title: "Engine", href: "/testing/engine", icon: TestTubeDiagonal, description: "Engine control and processing checks" },
]

const resourceItems: NavigationItem[] = [
  { title: "Chat History", href: "/additional/chat-history", icon: MessageSquare, description: "Local assistant session history" },
  { title: "Volume Corrections", href: "/additional/volume-corrections", icon: DatabaseZap, description: "Volume ratio calculation reference" },
]

function isRouteActive(currentPath: string, item: NavigationItem): boolean {
  return currentPath === item.href ||
    (item.href !== "/" && currentPath.startsWith(`${item.href}/`))
}

function NavigationList({ items }: { items: NavigationItem[] }) {
  const pathname = usePathname()
  const currentPath = pathname ?? ""
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <SidebarMenu className="gap-1">
      {items.map((item) => {
        const isActive = isRouteActive(currentPath, item)
        return (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton
              asChild
              isActive={isActive}
              tooltip={item.description}
              className="group/nav h-9 rounded-lg px-2.5"
            >
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                onClick={() => {
                  if (isMobile) setOpenMobile(false)
                }}
                className="flex items-center gap-2.5"
              >
                <span className={cn("nav-icon-frame", isActive && "nav-icon-frame-active")}>
                  <item.icon className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="truncate text-[13px] font-medium">{item.title}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}

export function AppSidebar() {
  const router = useRouter()
  const { user, logout } = useAuth()

  const handleLogout = () => {
    logout()
    router.push("/login")
  }

  return (
    <Sidebar collapsible="offcanvas" className="border-sidebar-border/80">
      <SidebarHeader className="sidebar-brand border-b border-sidebar-border/80 px-3 py-3">
        <Link href="/" className="group flex min-w-0 items-center gap-3" aria-label="CTS-K-N command center">
          <span className="brand-mark" aria-hidden="true">
            <Boxes className="h-4 w-4" />
          </span>
          <span className="min-w-0 group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-sm font-semibold tracking-tight text-sidebar-foreground">CTS-K-N</span>
            <span className="block truncate text-[9px] font-medium uppercase tracking-[0.2em] text-sidebar-foreground/55">
              Execution control plane
            </span>
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent className="sidebar-scroll overflow-x-hidden px-1.5 py-2">
        {navigationGroups.map((group) => (
          <SidebarGroup key={group.label} className="px-1 py-1.5">
            <SidebarGroupLabel className="h-7 gap-2 px-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/45">
              <group.icon className="h-3 w-3" aria-hidden="true" />
              {group.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <NavigationList items={group.items} />
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        <SidebarGroup className="px-1 py-1.5">
          <SidebarGroupLabel className="h-7 gap-2 px-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/45">
            <Settings2 className="h-3 w-3" aria-hidden="true" />
            Validation
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <NavigationList items={testingItems} />
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="px-1 py-1.5">
          <SidebarGroupLabel className="h-7 gap-2 px-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/45">
            <History className="h-3 w-3" aria-hidden="true" />
            Reference
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <NavigationList items={resourceItems} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="sidebar-footer space-y-2 border-t border-sidebar-border/80 p-2">
        <div className="rounded-lg border border-sidebar-border/80 bg-sidebar-accent/40 p-1.5 group-data-[collapsible=icon]:hidden">
          <ExchangeSelectorTop variant="sidebar" />
        </div>

        {user && (
          <div className="flex items-center gap-2 rounded-lg px-1.5 py-1 group-data-[collapsible=icon]:hidden">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary/15 text-[10px] font-bold text-sidebar-primary">
              {user.username.slice(0, 2).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-medium">{user.username}</span>
              <span className="block truncate text-[9px] text-sidebar-foreground/50">{user.email}</span>
            </span>
            <Button
              onClick={handleLogout}
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              aria-label="Log out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        <div className="flex items-center justify-between gap-1 rounded-lg px-1 group-data-[collapsible=icon]:justify-center">
          <span className="text-[9px] font-medium uppercase tracking-[0.14em] text-sidebar-foreground/40 group-data-[collapsible=icon]:hidden">
            Appearance
          </span>
          <div className="flex items-center gap-0.5 group-data-[collapsible=icon]:flex-col">
            <TopInfoLayerSwitcher />
            <StyleSwitcher />
            <ThemeSwitcher />
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
