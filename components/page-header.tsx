"use client"

import { ExchangeSelectorTop } from "@/components/exchange-selector-top"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Target } from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

export type PageHeaderVisual = "mesh" | "circuit" | "signal" | "none"

interface PageHeaderProps {
  title?: string
  description?: string
  children?: React.ReactNode
  showExchangeSelector?: boolean
  showScope?: boolean
  visual?: PageHeaderVisual
}

const visualClasses: Record<Exclude<PageHeaderVisual, "none">, string> = {
  mesh:
    "bg-[radial-gradient(circle_at_14%_18%,hsl(var(--primary)/0.18),transparent_28%),radial-gradient(circle_at_82%_8%,hsl(var(--chart-2)/0.14),transparent_32%),linear-gradient(115deg,transparent_0%,hsl(var(--primary)/0.04)_48%,transparent_100%)]",
  circuit:
    "bg-[linear-gradient(90deg,hsl(var(--border)/0.22)_1px,transparent_1px),linear-gradient(0deg,hsl(var(--border)/0.18)_1px,transparent_1px),radial-gradient(circle_at_75%_45%,hsl(var(--primary)/0.14),transparent_28%)] bg-[size:28px_28px,28px_28px,100%_100%]",
  signal:
    "bg-[repeating-linear-gradient(120deg,transparent_0px,transparent_22px,hsl(var(--primary)/0.06)_23px,transparent_24px),radial-gradient(ellipse_at_78%_50%,hsl(var(--chart-3)/0.16),transparent_38%)]",
}

export function PageHeader({
  title,
  description,
  children,
  showExchangeSelector = false,
  showScope = true,
  visual = "none",
}: PageHeaderProps) {
  const { selectedConnection } = useExchange()

  return (
    <div className="sticky top-0 z-10 overflow-hidden border-b bg-background/92 backdrop-blur-xl supports-[backdrop-filter]:bg-background/72">
      {visual !== "none" && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 opacity-90 dark:opacity-70 ${visualClasses[visual]}`}
        />
      )}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />

      <div className="relative flex h-auto min-h-[4rem] items-start gap-3 px-3 py-3 sm:px-4 lg:px-5">
        <SidebarTrigger className="mt-1 h-8 w-8 shrink-0" />
        <Separator orientation="vertical" className="mt-1 h-8 shrink-0" />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-base font-semibold leading-tight sm:text-lg">{title}</h1>
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
            <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground sm:text-sm">{description}</p>
          )}

          {showExchangeSelector && (
            <div className="mt-2 max-w-full overflow-x-auto pb-0.5">
              <ExchangeSelectorTop variant="header" />
            </div>
          )}
        </div>

        {children && (
          <div className="shrink-0 self-start">
            <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
          </div>
        )}
      </div>
    </div>
  )
}
