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
  showScope?: boolean
}

export function PageHeader({
  title,
  description,
  children,
  showExchangeSelector = false,
  showScope = true,
}: PageHeaderProps) {
  const { selectedConnection } = useExchange()

  return (
    <header className="page-header-shell isolate shrink-0 overflow-hidden border-b shadow-sm backdrop-blur-xl">
      <div className="page-header-inner relative z-[1] flex h-auto min-h-[4rem] flex-wrap items-start gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
        <SidebarTrigger className="h-8 w-8 shrink-0 mt-1" />
        <Separator orientation="vertical" className="h-8 shrink-0 mt-1" />
        <div className="page-header-copy min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="page-header-title font-semibold leading-tight text-balance">{title}</h1>
            {showScope && selectedConnection && (
              <Badge
                variant="secondary"
                className="h-5 max-w-full gap-1 px-1.5 font-mono text-[10px] uppercase tracking-wide"
              >
                <Target className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{selectedConnection.exchange}</span>
                {selectedConnection.name && selectedConnection.name !== selectedConnection.exchange && (
                  <span className="truncate opacity-70">· {selectedConnection.name}</span>
                )}
              </Badge>
            )}
          </div>

          {description && (
            <p className="page-header-description text-muted-foreground text-pretty">{description}</p>
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
