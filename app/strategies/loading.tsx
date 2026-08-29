import { PageHeader } from "@/components/page-header"
import { PageLoading } from "@/components/page-scaffold"

export default function Loading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Strategies"
        description="Advanced filtering, coordination analysis, and performance metrics"
      />
      <PageLoading label="Loading strategies and independent Set results…" />
    </div>
  )
}
