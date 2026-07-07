"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import {
  Search,
  Plus,
  Trash2,
  Star,
  TrendingUp,
  Volume2,
  Clock,
  Eye,
  EyeOff,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"

interface Symbol {
  id: string
  symbol: string
  price: number
  change24h: number
  volume24h: number
  isFavorite: boolean
  isActive: boolean
  lastTradeTime: string
  positionCount?: number
}

interface SymbolSettingsCardProps {
  symbols: Symbol[]
  onAddSymbol?: (symbol: string) => void
  onRemoveSymbol?: (symbolId: string) => void
  onToggleFavorite?: (symbolId: string) => void
  onToggleActive?: (symbolId: string) => void
}

export function SymbolSettingsCard({
  symbols = [],
  onAddSymbol,
  onRemoveSymbol,
  onToggleFavorite,
  onToggleActive,
}: SymbolSettingsCardProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [filterType, setFilterType] = useState<"all" | "active" | "favorites">("all")
  const [addSymbolOpen, setAddSymbolOpen] = useState(false)
  const [newSymbolQuery, setNewSymbolQuery] = useState("")

  const filteredSymbols = symbols.filter((s) => {
    const matchesSearch = s.symbol.toLowerCase().includes(searchQuery.toLowerCase())
    if (filterType === "active") return matchesSearch && s.isActive
    if (filterType === "favorites") return matchesSearch && s.isFavorite
    return matchesSearch
  })

  const activeSymbols = symbols.filter((s) => s.isActive)
  const favoriteSymbols = symbols.filter((s) => s.isFavorite)

  return (
    <Card className="border-0 shadow-md">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5 text-blue-500" />
              Symbol Management
            </CardTitle>
            <CardDescription>
              {activeSymbols.length} active symbol{activeSymbols.length !== 1 ? "s" : ""}
            </CardDescription>
          </div>
          <Dialog open={addSymbolOpen} onOpenChange={setAddSymbolOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-2">
                <Plus className="h-4 w-4" />
                Add Symbol
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Symbol</DialogTitle>
                <DialogDescription>
                  Search and add a symbol to your trading list
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Symbol Search</Label>
                  <Input
                    placeholder="Search symbols (BTC, ETH, DOGE)..."
                    value={newSymbolQuery}
                    onChange={(e) => setNewSymbolQuery(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Suggested Symbols</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {["BTC", "ETH", "XRP", "SOL", "ADA", "DOGE"].map((sym) => (
                      <Button
                        key={sym}
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onAddSymbol?.(sym)
                          setNewSymbolQuery("")
                          setAddSymbolOpen(false)
                        }}
                      >
                        {sym}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Search and Filter */}
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search symbols..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          <Tabs value={filterType} onValueChange={(v: any) => setFilterType(v)}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="all" className="text-xs">
                All ({symbols.length})
              </TabsTrigger>
              <TabsTrigger value="active" className="text-xs">
                Active ({activeSymbols.length})
              </TabsTrigger>
              <TabsTrigger value="favorites" className="text-xs">
                Favorites ({favoriteSymbols.length})
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <Separator />

        {/* Symbols List */}
        <ScrollArea className="h-80">
          <div className="space-y-2 pr-4">
            {filteredSymbols.length === 0 ? (
              <div className="flex items-center justify-center h-40 text-muted-foreground">
                <p className="text-sm">No symbols found</p>
              </div>
            ) : (
              filteredSymbols.map((symbol) => (
                <div
                  key={symbol.id}
                  className="flex items-center gap-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-3 group hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors"
                >
                  {/* Symbol Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm">{symbol.symbol}</span>
                      {symbol.isActive && (
                        <Badge variant="default" className="text-xs">
                          Active
                        </Badge>
                      )}
                      {symbol.isFavorite && (
                        <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500" />
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{symbol.price.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</span>
                      <span className={symbol.change24h >= 0 ? "text-green-600" : "text-red-600"}>
                        {symbol.change24h >= 0 ? "+" : ""}{symbol.change24h.toFixed(2)}%
                      </span>
                      <span className="flex items-center gap-1">
                        <Volume2 className="h-3 w-3" />
                        {(symbol.volume24h / 1000000).toFixed(1)}M
                      </span>
                      {symbol.positionCount && (
                        <span className="px-1.5 py-0.5 bg-blue-500/10 text-blue-600 rounded text-xs">
                          {symbol.positionCount} pos
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8"
                      onClick={() => onToggleFavorite?.(symbol.id)}
                    >
                      <Star
                        className={`h-4 w-4 ${
                          symbol.isFavorite ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground"
                        }`}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8"
                      onClick={() => onToggleActive?.(symbol.id)}
                    >
                      {symbol.isActive ? (
                        <Eye className="h-4 w-4 text-green-600" />
                      ) : (
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => onRemoveSymbol?.(symbol.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
