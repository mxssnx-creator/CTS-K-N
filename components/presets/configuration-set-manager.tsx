"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Plus, Edit, Trash2, Play, Pause, Settings2 } from "lucide-react"
import type { PresetConfigurationSet, PresetType } from "@/lib/types-preset-coordination"
import { toast } from "@/lib/simple-toast"
import { CreateConfigurationSetDialog } from "./create-configuration-set-dialog"

interface ConfigurationSetManagerProps {
  configSets: PresetConfigurationSet[]
  presetTypes: PresetType[]
  onRefresh: () => void
  indicationCategoryFilter: "main" | "common" | "all"
}

export function ConfigurationSetManager({
  configSets,
  presetTypes,
  onRefresh,
  indicationCategoryFilter,
}: ConfigurationSetManagerProps) {
  const [selectedSet, setSelectedSet] = useState<PresetConfigurationSet | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)

  const handleCreate = () => {
    setShowCreateDialog(true)
  }

  // const handleEdit = (set: PresetConfigurationSet) => {
  //   toast.info("Configuration set editing coming soon")
  // }

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this configuration set?")) return

    try {
      const response = await fetch(`/api/preset-config-sets/${id}`, { method: "DELETE" })
      if (!response.ok) throw new Error("Failed to delete")
      toast.success("Configuration set deleted")
      onRefresh()
    } catch (error) {
      toast.error("Failed to delete configuration set")
    }
  }

  const handleToggleActive = async (set: PresetConfigurationSet) => {
    try {
      const response = await fetch(`/api/preset-config-sets/${set.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...set, is_active: !set.is_active }),
      })
      if (!response.ok) throw new Error("Failed to update")
      toast.success(`Configuration set ${!set.is_active ? "activated" : "deactivated"}`)
      onRefresh()
    } catch (error) {
      toast.error("Failed to update configuration set")
    }
  }

  const filteredConfigSets = configSets.filter((set) => {
    if (indicationCategoryFilter === "main") {
      return set.indication_type === "main"
    } else if (indicationCategoryFilter === "common") {
      return set.indication_type === "common"
    } else {
      return true
    }
  })

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold">Configuration Sets</h2>
          <p className="text-sm text-muted-foreground">
            Define indicator configurations with parameter ranges for backtesting
          </p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="h-4 w-4 mr-2" />
          Create Configuration Set
        </Button>
      </div>

      {filteredConfigSets.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Settings2 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No configuration sets yet</h3>
            <p className="text-muted-foreground mb-4">
              Create configuration sets to define indicator parameters and ranges
            </p>
            <Button onClick={handleCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Create Configuration Set
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredConfigSets.map((set) => (
            <Card key={set.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2">
                      {set.name}
                      {set.is_active && <Badge variant="default">Active</Badge>}
                      <Badge variant="outline">{set.indication_type}</Badge>
                    </CardTitle>
                    {set.description && <CardDescription>{set.description}</CardDescription>}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" size="icon" onClick={() => handleToggleActive(set)}>
                      {set.is_active ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                    {/* Edit functionality not yet implemented */}
                    {/* <Button variant="ghost" size="icon" onClick={() => handleEdit(set)}>
                      <Edit className="h-4 w-4" />
                    </Button> */}
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(set.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <div className="text-muted-foreground">Symbol Mode</div>
                    <div className="font-medium">{set.symbol_mode}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">TP Range</div>
                    <div className="font-medium">
                      {set.takeprofit_min}-{set.takeprofit_max}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">SL Range</div>
                    <div className="font-medium">
                      {set.stoploss_min}-{set.stoploss_max}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-purple-500"></span>
                      Additional: Trailing
                    </div>
                    <div className="font-medium">{set.trailing_enabled ? "Enabled" : "Disabled"}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateConfigurationSetDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onSuccess={onRefresh}
        presetTypes={presetTypes}
      />
    </div>
  )
}
