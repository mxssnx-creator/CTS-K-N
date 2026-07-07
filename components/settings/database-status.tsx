"use client"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"

interface DatabaseStatusProps {
  databaseType: string
  tableCount: number
  migrationsApplied: number
  isInstalled: boolean
}

export function DatabaseStatus({
  databaseType,
  tableCount,
  migrationsApplied,
  isInstalled,
}: DatabaseStatusProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">System Status</h3>
      <Card className="p-4">
        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Database Type</div>
            <div className="font-semibold">{databaseType.toUpperCase()}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Tables Created</div>
            <div className="font-semibold">{tableCount} tables</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Migrations Applied</div>
            <div className="font-semibold">{migrationsApplied} migrations</div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <div className="text-xs text-muted-foreground">Status:</div>
          <Badge variant={isInstalled ? "default" : "destructive"}>
            {isInstalled ? "Installed" : "Not Installed"}
          </Badge>
        </div>
      </Card>
    </div>
  )
}
