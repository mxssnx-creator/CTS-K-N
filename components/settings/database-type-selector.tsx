"use client"

import { Card } from "@/components/ui/card"

interface DatabaseTypeSelectorProps {
  databaseType: string
}

export function DatabaseTypeSelector({ databaseType }: DatabaseTypeSelectorProps) {
  return (
    <Card className="p-4">
      <h3 className="text-lg font-semibold mb-4">Database Type</h3>
      <p className="text-sm text-muted-foreground mb-4">
        The system uses Redis as the primary database.
      </p>
      <div className="flex items-center gap-2 bg-primary/10 p-3 rounded-md">
        <div className="w-3 h-3 bg-green-500 rounded-full"></div>
        <span className="font-medium">Redis (Primary)</span>
      </div>
      <p className="text-xs text-muted-foreground mt-4">
        For production, configure your Redis URL in environment variables.
      </p>
    </Card>
  )
}
