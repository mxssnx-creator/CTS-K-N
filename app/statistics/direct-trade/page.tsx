"use client"

import { PageHeader } from "@/components/page-header"
import { DirectTradeStatistics } from "@/components/statistics/direct-trade-statistics"
import { StatisticsSectionNav } from "@/components/statistics/statistics-section-nav"

export default function DirectTradeStatisticsPage() {
  return (
    <main className="container mx-auto space-y-5 px-4 py-6">
      <PageHeader title="Statistics" description="Detailed evaluation and execution analytics" />
      <StatisticsSectionNav />
      <DirectTradeStatistics />
    </main>
  )
}
