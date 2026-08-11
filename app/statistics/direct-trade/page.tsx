"use client"

import { PageHeader } from "@/components/page-header"
import { DirectTradeStatistics } from "@/components/statistics/direct-trade-statistics"
import { StatisticsSectionNav } from "@/components/statistics/statistics-section-nav"

export default function DirectTradeStatisticsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Direct-Trade Analytics"
        description="Block comparisons, DDT, position cost, ratios, volumes, and execution outcomes"
      />
      <div className="page-section space-y-5">
        <StatisticsSectionNav />
        <DirectTradeStatistics />
      </div>
    </div>
  )
}
