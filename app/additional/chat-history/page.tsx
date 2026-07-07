"use client"
export const dynamic = "force-dynamic"


import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Download } from "lucide-react"
import type { ChatHistoryStats } from "@/lib/additional/chat-history"

export default function ChatHistoryPage() {
  const [stats, setStats] = useState<ChatHistoryStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStats()
  }, [])

  const fetchStats = async () => {
    try {
      const response = await fetch("/api/additional/chat-history/stats")
      if (response.ok) {
        const data = await response.json()
        setStats(data)
      }
    } catch (error) {
      console.error("[v0] Failed to fetch stats:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleDownload = async (format: "combined" | "input" | "output") => {
    try {
      const response = await fetch(`/api/additional/chat-history?format=${format}`)
      if (response.ok) {
        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `chat-${format}-${new Date().toISOString().split("T")[0]}.txt`
        document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        document.body.removeChild(a)
      }
    } catch (error) {
      console.error("[v0] Download failed:", error)
    }
  }

  return (
    <div className="flex-1 space-y-3 p-4 pt-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold tracking-tight">Chat History</h2>
        <div className="flex gap-1 text-xs text-muted-foreground">
          <Download className="h-3 w-3" />
          <span>{loading ? "..." : stats?.totalMessages || 0} msgs</span>
        </div>
      </div>

      <div className="grid gap-2 grid-cols-3">
        <div className="rounded-md border px-3 py-2">
          <div className="text-xs text-muted-foreground">Total</div>
          <div className="text-lg font-bold">{loading ? "..." : stats?.totalMessages || 0}</div>
        </div>
        <div className="rounded-md border px-3 py-2">
          <div className="text-xs text-muted-foreground">Inputs</div>
          <div className="text-lg font-bold">{loading ? "..." : stats?.userMessages || 0}</div>
        </div>
        <div className="rounded-md border px-3 py-2">
          <div className="text-xs text-muted-foreground">Outputs</div>
          <div className="text-lg font-bold">{loading ? "..." : stats?.assistantMessages || 0}</div>
        </div>
      </div>

      <div className="rounded-md border p-3">
        <div className="text-sm font-medium mb-2">Export</div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => handleDownload("combined")} className="flex-1 text-xs h-8">
            <Download className="h-3 w-3 mr-1" /> Combined
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleDownload("input")} className="flex-1 text-xs h-8">
            <Download className="h-3 w-3 mr-1" /> Inputs
          </Button>
          <Button size="sm" variant="outline" onClick={() => handleDownload("output")} className="flex-1 text-xs h-8">
            <Download className="h-3 w-3 mr-1" /> Outputs
          </Button>
        </div>
      </div>

      {stats && (
        <div className="rounded-md border px-3 py-2 flex justify-between text-xs">
          <span className="text-muted-foreground">Range:</span>
          <span className="font-mono">{new Date(stats.dateRange.start).toLocaleDateString()} - {new Date(stats.dateRange.end).toLocaleDateString()}</span>
        </div>
      )}
    </div>
  )
}
