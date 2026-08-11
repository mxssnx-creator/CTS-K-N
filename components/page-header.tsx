"use client"

import { useEffect, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import { ExchangeSelectorTop } from "@/components/exchange-selector-top"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Activity, Target } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"
import { cn } from "@/lib/utils"
import { getRoutePresentation } from "@/lib/route-presentation"

interface PageHeaderProps {
  title?: string
  description?: string
  eyebrow?: string
  children?: ReactNode
  showExchangeSelector?: boolean
  showScope?: boolean
  compact?: boolean
}

export function PageHeader({
  title,
  description,
  eyebrow,
  children,
  showExchangeSelector = false,
  showScope = true,
  compact = false,
}: PageHeaderProps) {
  const { selectedConnection } = useExchange()
  const pathname = usePathname() ?? "/"
  const routePresentation = getRoutePresentation(pathname)
  const resolvedTitle = title || routePresentation.title
  const resolvedDescription = description || routePresentation.description
  const resolvedEyebrow = eyebrow || routePresentation.eyebrow

  useEffect(() => {
    document.title = `${resolvedTitle} · CTS-K-N`
  }, [resolvedTitle])

  return (
    <header
      className={cn(
        "page-header-shell isolate shrink-0 overflow-hidden border-b shadow-sm backdrop-blur-xl",
        compact && "page-header-compact",
      )}
      aria-label={`${resolvedTitle} page controls`}
    >
      <div className="page-header-inner relative z-[1] flex h-auto min-h-[4rem] flex-wrap items-start gap-x-3 gap-y-2 px-3 py-3 sm:px-4 lg:px-5">
        <SidebarTrigger className="mt-1 h-8 w-8 shrink-0 border border-border/60 bg-background/60 shadow-sm hover:bg-accent" />
        <Separator orientation="vertical" className="mt-1 h-8 shrink-0" />
        <div className="page-header-copy min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.2em] text-primary/90">
            <Activity className="h-2.5 w-2.5" aria-hidden="true" />
            <span>{resolvedEyebrow}</span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="page-header-title text-balance font-semibold leading-tight">{resolvedTitle}</h1>
            {showScope && selectedConnection && (
              <Badge
                variant="secondary"
                className="scope-badge h-5 max-w-full gap-1 px-1.5 font-mono text-[10px] uppercase tracking-wide"
              >
                <Target className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{selectedConnection.exchange}</span>
                {selectedConnection.name && selectedConnection.name !== selectedConnection.exchange && (
                  <span className="truncate opacity-70">· {selectedConnection.name}</span>
                )}
              </Badge>
            )}
          </div>

          {resolvedDescription && (
            <p className="page-header-description max-w-4xl text-pretty text-muted-foreground">{resolvedDescription}</p>
          )}

          {showExchangeSelector && (
            <div className="mt-2 max-w-full overflow-x-auto pb-0.5">
              <ExchangeSelectorTop variant="header" />
            </div>
          )}
        </div>
        {children && (
          <div className="page-header-actions shrink-0 self-start">
            <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
          </div>
        )}
      </div>
    </header>
  )
}
