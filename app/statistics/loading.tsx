import { PageLoading } from "@/components/page-scaffold"
import { PageHeader } from "@/components/page-header"

export default function Loading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Advanced Statistics & Analytics"
        description="Measured exchange performance, classic realised PF, PositionCost coordinates and runtime diagnostics"
      />
      <PageLoading label="Loading statistics and execution analytics…" />
    </div>
  )
}
