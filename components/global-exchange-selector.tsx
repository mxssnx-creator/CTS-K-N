"use client"

import { useExchange } from "@/lib/exchange-context"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"

export function GlobalExchangeSelector() {
  const { selectedConnectionId, setSelectedConnectionId, activeConnections } = useExchange()

  if (activeConnections.length === 0) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-xs">
          No Exchanges
        </Badge>
      </div>
    )
  }

  // Deduplicate by id and filter out entries with missing/empty ids
  const uniqueConnections = activeConnections.reduce<any[]>((acc, conn) => {
    const connId = conn.id || conn.name || ""
    if (connId && !acc.some((c) => (c.id || c.name) === connId)) {
      acc.push(conn)
    }
    return acc
  }, [])

  // Build a stable unique value for each connection
  const getStableValue = (conn: any, index: number) => conn.id || `conn-${index}`

  const selectedConn = uniqueConnections.find((c) => c.id === selectedConnectionId)
  const selectedValue = selectedConn ? getStableValue(selectedConn, uniqueConnections.indexOf(selectedConn)) : ""

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Exchange:</span>
      <Select
        value={selectedValue}
        onValueChange={(val) => {
          const conn = uniqueConnections.find((c, i) => getStableValue(c, i) === val)
          setSelectedConnectionId(conn?.id || null)
        }}
      >
        <SelectTrigger className="w-[180px] h-9">
          <SelectValue placeholder="Select exchange" />
        </SelectTrigger>
        <SelectContent>
          {uniqueConnections.map((conn, index) => {
            const itemValue = getStableValue(conn, index)
            return (
              <SelectItem key={itemValue} value={itemValue}>
                <div className="flex items-center gap-2">
                  <span>{conn.name}</span>
                  {conn.is_testnet && (
                    <Badge variant="outline" className="text-xs">
                      Testnet
                    </Badge>
                  )}
                </div>
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
    </div>
  )
}
