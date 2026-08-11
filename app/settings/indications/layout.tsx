import type React from "react"
import { PageHeader } from "@/components/page-header"

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}
