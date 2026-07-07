"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import type { Preset } from "@/lib/types"
import { Edit, Trash2, TrendingUp, Target, Zap, Settings, Plus } from "lucide-react"

interface PresetCardProps {
  preset: Preset
  onEdit: (preset: Preset) => void
  onDelete: (id: string) => void
  onToggleActive: (id: string, isActive: boolean) => void
  onAddToConnections?: (preset: Preset) => void
}

export function PresetCard({ preset, onEdit, onDelete, onToggleActive, onAddToConnections }: PresetCardProps) {
  const takeprofitSteps = preset.takeprofit_steps || []
  const stoplossRatios = preset.stoploss_ratios || []
  const strategyTypes = preset.strategy_types || []
  const minProfitFactor = preset.min_profit_factor || 0
  const isActive = preset.is_active ?? false
  const name = preset.name || "Unnamed Preset"
  const description = preset.description || ""

  return (
    <Card className={isActive ? "border-primary" : ""}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="flex items-center gap-2">
              {name}
              {isActive && <Badge variant="default">Active</Badge>}
            </CardTitle>
            {description && <CardDescription className="mt-1">{description}</CardDescription>}
          </div>
          <Switch checked={isActive} onCheckedChange={(checked) => onToggleActive(preset.id, checked)} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-blue-500" />
            <div>
              <div className="font-medium">TP Steps</div>
              <div className="text-muted-foreground">{takeprofitSteps.length} configs</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-orange-500" />
            <div>
              <div className="font-medium">SL Ratios</div>
              <div className="text-muted-foreground">{stoplossRatios.length} configs</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-green-500" />
            <div>
              <div className="font-medium">Min PF</div>
              <div className="text-muted-foreground">{minProfitFactor.toFixed(2)}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-purple-500" />
            <div>
              <div className="font-medium">Strategies</div>
              <div className="text-muted-foreground">{strategyTypes.length} types</div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          {preset.trailing_enabled && <Badge variant="outline">Trailing</Badge>}
          {preset.block_adjustment_enabled && <Badge variant="outline">Block Adj</Badge>}
          {preset.dca_adjustment_enabled && <Badge variant="outline">DCA</Badge>}
          {preset.backtest_enabled && <Badge variant="outline">Backtest</Badge>}
        </div>

        <div className="flex gap-2">
          {onAddToConnections && (
            <Button variant="default" size="sm" className="flex-1" onClick={() => onAddToConnections(preset)}>
              <Plus className="h-3 w-3 mr-1" />
              Add to Connections
            </Button>
          )}
          <Button variant="outline" size="sm" className="flex-1 bg-transparent" onClick={() => onEdit(preset)}>
            <Edit className="h-3 w-3 mr-1" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:bg-destructive hover:text-destructive-foreground bg-transparent"
            onClick={() => onDelete(preset.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
