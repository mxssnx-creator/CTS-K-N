"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle, Bell } from "lucide-react"
import type { AlertHistory } from "@/lib/types"

interface AlertHistoryTableProps {
  history: AlertHistory[]
}

export function AlertHistoryTable({ history }: AlertHistoryTableProps) {
  const getAlertTypeColor = (type: string) => {
    switch (type) {
      case "price":
        return "bg-blue-500"
      case "position":
        return "bg-green-500"
      case "system":
        return "bg-red-500"
      default:
        return "bg-gray-500"
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alert History</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {history.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Bell className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No alert history</p>
            </div>
          ) : (
            history.map((item) => (
              <Card key={item.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4 flex-1">
                      <div className={`h-3 w-3 rounded-full ${getAlertTypeColor(item.alert_type)}`} />
                      <div>
                        <div className="font-medium">{item.message}</div>
                        {item.symbol && <div className="text-sm text-muted-foreground">{item.symbol}</div>}
                        <div className="text-xs text-muted-foreground mt-1">
                          {new Date(item.triggered_at).toLocaleString()}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="capitalize">
                        {item.alert_type}
                      </Badge>
                      {item.acknowledged ? (
                        <Badge variant="outline" className="bg-green-500/10 text-green-600">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          Acknowledged
                        </Badge>
                      ) : (
                        <Button variant="outline" size="sm">
                          Acknowledge
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
