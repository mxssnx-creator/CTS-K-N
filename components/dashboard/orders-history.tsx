"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

interface Order {
  id: number
  symbol: string
  order_type: string
  side: "buy" | "sell"
  price?: number
  quantity: number
  filled_quantity: number
  status: string
  created_at: string
  executed_at?: string
}

interface OrdersHistoryProps {
  orders: Order[]
}

export function OrdersHistory({ orders }: OrdersHistoryProps) {
  const getStatusBadge = (status: string) => {
    switch (status) {
      case "filled":
        return <Badge className="bg-green-600">Filled</Badge>
      case "partially_filled":
        return <Badge className="bg-blue-600">Partial</Badge>
      case "pending":
        return <Badge className="bg-yellow-600">Pending</Badge>
      case "cancelled":
        return <Badge variant="secondary">Cancelled</Badge>
      case "rejected":
        return <Badge variant="destructive">Rejected</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Orders</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order ID</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Filled</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    No orders yet
                  </TableCell>
                </TableRow>
              ) : (
                orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono text-sm">#{order.id}</TableCell>
                    <TableCell className="font-medium">{order.symbol}</TableCell>
                    <TableCell className="capitalize">{order.order_type}</TableCell>
                    <TableCell>
                      <Badge variant={order.side === "buy" ? "default" : "secondary"}>{order.side.toUpperCase()}</Badge>
                    </TableCell>
                    <TableCell>{order.price ? `$${order.price.toFixed(2)}` : "Market"}</TableCell>
                    <TableCell>{order.quantity.toFixed(4)}</TableCell>
                    <TableCell>{order.filled_quantity.toFixed(4)}</TableCell>
                    <TableCell>{getStatusBadge(order.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(order.created_at)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
