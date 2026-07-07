"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Plus, Edit, Trash2, Play, Pause, Target } from "lucide-react"
import { PresetTypeDialog } from "./preset-type-dialog"
import type { PresetType } from "@/lib/types-preset-coordination"
import { toast } from "@/lib/simple-toast"

interface PresetTypeManagerProps {
  presetTypes: PresetType[]
  onRefresh: () => void
}

export function PresetTypeManager({ presetTypes, onRefresh }: PresetTypeManagerProps) {
  const [selectedType, setSelectedType] = useState<PresetType | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)

  const handleCreate = () => {
    setSelectedType(null)
    setIsDialogOpen(true)
  }

  const handleEdit = (type: PresetType) => {
    setSelectedType(type)
    setIsDialogOpen(true)
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this preset type?")) return

    try {
      const response = await fetch(`/api/preset-types/${id}`, { method: "DELETE" })
      if (!response.ok) throw new Error("Failed to delete")
      toast.success("Preset type deleted")
      onRefresh()
    } catch (error) {
      toast.error("Failed to delete preset type")
    }
  }

  const handleToggleActive = async (type: PresetType) => {
    try {
      const response = await fetch(`/api/preset-types/${type.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...type, is_active: !type.is_active }),
      })
      if (!response.ok) throw new Error("Failed to update")
      toast.success(`Preset type ${!type.is_active ? "activated" : "deactivated"}`)
      onRefresh()
    } catch (error) {
      toast.error("Failed to update preset type")
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold">Preset Types</h2>
          <p className="text-sm text-muted-foreground">
            Define preset types with coordination settings and strategy configurations
          </p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="h-4 w-4 mr-2" />
          Create Preset Type
        </Button>
      </div>

      {presetTypes.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Target className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No preset types yet</h3>
            <p className="text-muted-foreground mb-4">Create your first preset type to start coordinated trading</p>
            <Button onClick={handleCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Create Preset Type
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {presetTypes.map((type) => (
            <Card key={type.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2">
                      {type.name}
                      {type.is_active && <Badge variant="default">Active</Badge>}
                      {type.auto_evaluate && <Badge variant="secondary">Auto-Eval</Badge>}
                    </CardTitle>
                    {type.description && <CardDescription>{type.description}</CardDescription>}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="icon" onClick={() => handleToggleActive(type)}>
                      {type.is_active ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(type)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(type.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div className="text-muted-foreground">Trade Type</div>
                    <div className="font-medium">{type.preset_trade_type}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Max Positions</div>
                    <div className="font-medium">{type.max_positions_per_indication}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Evaluation Interval</div>
                    <div className="font-medium">{type.evaluation_interval_hours}h</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Strategy</div>
                    <div className="font-medium">
                      {type.block_enabled && "Block "}
                      {type.dca_enabled && "DCA"}
                      {!type.block_enabled && !type.dca_enabled && "Standard"}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <PresetTypeDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        presetType={selectedType}
        onSave={onRefresh}
      />
    </div>
  )
}
