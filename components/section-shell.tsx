import type { ReactNode } from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { PageHeader } from "@/components/page-header"

interface SectionShellProps {
  children: ReactNode
  title?: string
  description?: string
  eyebrow?: string
  showScope?: boolean
  showExchangeSelector?: boolean
}

export function SectionShell({
  children,
  title,
  description,
  eyebrow,
  showScope = true,
  showExchangeSelector = false,
}: SectionShellProps) {
  return (
    <DashboardShell>
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader
          title={title}
          description={description}
          eyebrow={eyebrow}
          showScope={showScope}
          showExchangeSelector={showExchangeSelector}
        />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </DashboardShell>
  )
}
