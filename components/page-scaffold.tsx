import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { AlertTriangle, LoaderCircle } from "lucide-react"
import { PageHeader } from "@/components/page-header"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface PageContainerProps {
  title: string
  description?: string
  eyebrow?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
  showExchangeSelector?: boolean
  showScope?: boolean
}

export function PageContainer({
  title,
  description,
  eyebrow,
  actions,
  children,
  className,
  contentClassName,
  showExchangeSelector = false,
  showScope = true,
}: PageContainerProps) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PageHeader
        title={title}
        description={description}
        eyebrow={eyebrow}
        showExchangeSelector={showExchangeSelector}
        showScope={showScope}
      >
        {actions}
      </PageHeader>
      <div className={cn("page-section space-y-5", contentClassName)}>{children}</div>
    </div>
  )
}

interface PageStateProps {
  title: string
  description: string
  icon?: LucideIcon
  action?: ReactNode
  tone?: "neutral" | "warning" | "danger"
  compact?: boolean
}

export function PageState({
  title,
  description,
  icon: Icon = AlertTriangle,
  action,
  tone = "neutral",
  compact = false,
}: PageStateProps) {
  const toneClass = {
    neutral: "border-border bg-card text-primary",
    warning: "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400",
    danger: "border-destructive/30 bg-destructive/5 text-destructive",
  }[tone]

  return (
    <Card className={cn("border-dashed", toneClass)} role={tone === "danger" ? "alert" : "status"}>
      <CardContent className={cn("flex flex-col items-center justify-center text-center", compact ? "min-h-32" : "min-h-52")}>
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-current/20 bg-current/5">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">{description}</p>
        {action && <div className="mt-4">{action}</div>}
      </CardContent>
    </Card>
  )
}

export function PageLoading({ label = "Loading control-plane data…" }: { label?: string }) {
  return (
    <div className="flex min-h-52 items-center justify-center" role="status" aria-live="polite">
      <div className="flex items-center gap-3 rounded-xl border bg-card/80 px-4 py-3 text-sm text-muted-foreground shadow-sm backdrop-blur">
        <LoaderCircle className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </div>
  )
}
