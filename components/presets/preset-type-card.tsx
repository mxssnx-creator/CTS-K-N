"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Edit, Trash2, Clock, Target, TrendingUp } from "lucide-react"
import type { PresetType } from "@/lib/types-preset-coordination"

interface PresetTypeCardProps {
  presetType: PresetType
  onEdit: (presetType: PresetType) => void
  onDelete: (id: string) => void
}

export function PresetTypeCard({ presetType, onEdit, onDelete }: PresetTypeCardProps) {
  return (
    <Card className={presetType.is_active ? "border-green-500" : ""}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="text-lg">{presetType.name}</CardTitle>
            {presetType.description && <p className="text-sm text-muted-foreground mt-1">{presetType.description}</p>}
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" onClick={() => onEdit(presetType)}>
              <Edit className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => onDelete(presetType.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {presetType.is_active && <Badge variant="default">Active</Badge>}
          {presetType.auto_evaluate && <Badge variant="secondary">Auto-Evaluate</Badge>}
          {presetType.block_enabled && <Badge variant="outline">Block</Badge>}
          {presetType.dca_enabled && <Badge variant="outline">DCA</Badge>}
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Max Positions:</span>
            <span className="font-medium">{presetType.max_positions_per_indication}</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Timeout:</span>
            <span className="font-medium">{presetType.timeout_per_indication}s</span>
          </div>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Eval Interval:</span>
            <span className="font-medium">{presetType.evaluation_interval_hours}h</span>
          </div>
        </div>

        <div className="text-xs text-muted-foreground">Type: {presetType.preset_trade_type}</div>
      </CardContent>
    </Card>
  )
}
