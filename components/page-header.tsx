"use client"

import { ExchangeSelectorTop } from "@/components/exchange-selector-top"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Target } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

interface PageHeaderProps {
  title?: string
  description?: string
  children?: React.ReactNode
  showExchangeSelector?: boolean
  /**
   * When true (default), render a small "scope chip" next to the title that
   * surfaces the exchange connection currently driving this page's data.
   * Set false only for pages that are explicitly NOT connection-scoped.
   */
  showScope?: boolean
}

export function PageHeader({
  title,
  description,
  children,
  showExchangeSelector = false,
  showScope = true,
}: PageHeaderProps) {
  // Read the active exchange connection so every PageHeader across the sidebar
  // automatically reflects which exchange the page's data is scoped to. This
  // is the single source of truth — no individual page needs to duplicate the
  // chip markup.
  const { selectedConnection } = useExchange()

  return (
    <div className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
      <div className="flex h-auto min-h-[4rem] items-start gap-3 px-3 md:px-4 py-3">
        <SidebarTrigger className="h-8 w-8 shrink-0 mt-1" />
        <Separator orientation="vertical" className="h-8 shrink-0 mt-1" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-semibold leading-tight">{title}</h1>
            {showScope && selectedConnection && (
              <Badge
                variant="secondary"
                className="h-5 gap-1 font-mono text-[10px] uppercase tracking-wide px-1.5"
              >
                <Target className="h-2.5 w-2.5" />
                {selectedConnection.exchange}
                {selectedConnection.name && selectedConnection.name !== selectedConnection.exchange && (
                  <span className="opacity-70">· {selectedConnection.name}</span>
                )}
              </Badge>
            )}
          </div>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
          {showExchangeSelector && (
            <div className="mt-2">
              <ExchangeSelectorTop variant="header" />
            </div>
          )}
        </div>
        <div className="shrink-0">
          {children && <div className="flex items-center gap-2">{children}</div>}
        </div>
      </div>
    </div>
  )
}
