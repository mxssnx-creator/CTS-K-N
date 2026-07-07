"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface CreateAlertDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateAlertDialog({ open, onOpenChange }: CreateAlertDialogProps) {
  const [alertType, setAlertType] = useState("price")
  const [symbol, setSymbol] = useState("")
  const [condition, setCondition] = useState("above")
  const [price, setPrice] = useState("")

  const handleCreate = () => {
    // Handle alert creation
    console.log("[v0] Creating alert:", { alertType, symbol, condition, price })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create New Alert</DialogTitle>
        </DialogHeader>

        <Tabs value={alertType} onValueChange={setAlertType}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="price">Price Alert</TabsTrigger>
            <TabsTrigger value="position">Position Alert</TabsTrigger>
            <TabsTrigger value="system">System Alert</TabsTrigger>
          </TabsList>

          <TabsContent value="price" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>Symbol</Label>
              <Select value={symbol} onValueChange={setSymbol}>
                <SelectTrigger>
                  <SelectValue placeholder="Select symbol" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BTCUSDT">BTCUSDT</SelectItem>
                  <SelectItem value="ETHUSDT">ETHUSDT</SelectItem>
                  <SelectItem value="BNBUSDT">BNBUSDT</SelectItem>
                  <SelectItem value="SOLUSDT">SOLUSDT</SelectItem>
                  <SelectItem value="ADAUSDT">ADAUSDT</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Condition</Label>
              <Select value={condition} onValueChange={setCondition}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="above">Price goes above</SelectItem>
                  <SelectItem value="below">Price goes below</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Target Price</Label>
              <Input
                type="number"
                placeholder="Enter target price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>

            <Button onClick={handleCreate} className="w-full">
              Create Price Alert
            </Button>
          </TabsContent>

          <TabsContent value="position" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>Alert Type</Label>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select alert type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="profit_target">Profit Target</SelectItem>
                  <SelectItem value="stop_loss">Stop Loss</SelectItem>
                  <SelectItem value="time_limit">Time Limit</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Position</Label>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select position" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pos-1">BTCUSDT - Long</SelectItem>
                  <SelectItem value="pos-2">ETHUSDT - Short</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Threshold</Label>
              <Input type="number" placeholder="Enter threshold value" />
            </div>

            <Button onClick={handleCreate} className="w-full">
              Create Position Alert
            </Button>
          </TabsContent>

          <TabsContent value="system" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>Alert Type</Label>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select system alert type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="connection_lost">Connection Lost</SelectItem>
                  <SelectItem value="high_drawdown">High Drawdown</SelectItem>
                  <SelectItem value="api_error">API Error</SelectItem>
                  <SelectItem value="low_balance">Low Balance</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Exchange Connection</Label>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select connection" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bybit-x03">Bybit X03</SelectItem>
                  <SelectItem value="bingx-x01">BingX X01</SelectItem>
                  <SelectItem value="pionex-x01">Pionex X01</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button onClick={handleCreate} className="w-full">
              Create System Alert
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
