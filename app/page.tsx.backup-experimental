"use client"

import dynamic from "next/dynamic"

const DashboardActiveConnectionsManager = dynamic(
  () => import("@/components/dashboard/dashboard-active-connections-manager").then((mod) => mod.DashboardActiveConnectionsManager),
  { loading: () => <div className="p-8 text-center">Loading dashboard...</div> }
)

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background p-4 md:p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Trading Dashboard</h1>
          <p className="text-muted-foreground">Manage your trading connections and positions</p>
        </div>
        <DashboardActiveConnectionsManager />
      </div>
    </div>
  )
}
