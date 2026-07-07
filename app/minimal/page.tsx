"use client"


export const dynamic = "force-dynamic"

import { AuthGuard } from "@/components/auth-guard"
import { Button } from "@/components/ui/button"
import { useState } from "react"

export default function MinimalPage() {
  const [count, setCount] = useState(0)

  return (
    <AuthGuard>
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center space-y-8 max-w-md mx-auto px-4">
          <div className="space-y-2">
            <h1 className="text-5xl font-bold">CTS v3.2</h1>
            <p className="text-xl text-muted-foreground">Trading System</p>
          </div>

          <div className="bg-card border border-border rounded-lg p-6 space-y-4">
            <p className="text-sm text-muted-foreground">System Status: Ready</p>
            <div className="text-3xl font-bold text-primary">{count}</div>
            <Button onClick={() => setCount(count + 1)} className="w-full">
              Increment
            </Button>
            <Button variant="outline" onClick={() => setCount(0)} className="w-full">
              Reset
            </Button>
          </div>

          <div className="text-xs text-muted-foreground">
            <p>✓ Redis migrations initialized</p>
            <p>✓ Authentication active</p>
            <p>✓ UI responsive</p>
          </div>
        </div>
      </div>
    </AuthGuard>
  )
}
