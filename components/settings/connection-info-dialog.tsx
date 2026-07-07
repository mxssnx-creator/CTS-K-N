"use client"

import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Loader2 } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface ConnectionInfoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  connectionName: string
}

export function ConnectionInfoDialog({ open, onOpenChange, connectionId, connectionName }: ConnectionInfoDialogProps) {
  const [loading, setLoading] = useState(true)
  const [info, setInfo] = useState<any>(null)

  useEffect(() => {
    if (open) {
      loadInfo()
    }
  }, [open, connectionId])

  const loadInfo = async () => {
    try {
      setLoading(true)

      const [indicationsRes, settingsRes, presetTypeRes] = await Promise.all([
        fetch(`/api/settings/connections/${connectionId}/active-indications`),
        fetch(`/api/settings/connections/${connectionId}/settings`),
        fetch(`/api/settings/connections/${connectionId}/preset-type`),
      ])

      const indications = indicationsRes.ok ? await indicationsRes.json() : { indications: [] }
      const settings = settingsRes.ok ? await settingsRes.json() : {}
      const presetType = presetTypeRes.ok ? await presetTypeRes.json() : { presetType: null }

      setInfo({
        indications: indications.indications || [],
        settings: settings,
        presetType: presetType.presetType,
      })
    } catch (error) {
      console.error("[v0] Failed to load connection info:", error)
      toast.error("Error loading information", {
        description: error instanceof Error ? error.message : "Failed to load information",
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connection Information - {connectionName}</DialogTitle>
          <DialogDescription>View configured indications, preset type, and settings</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Preset Type Section */}
            {info?.presetType && (
              <div className="space-y-3">
                <h3 className="text-lg font-semibold">Preset Type</h3>
                <div className="p-4 border rounded-lg space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="default">{info.presetType.name}</Badge>
                    {info.presetType.is_predefined && <Badge variant="outline">Predefined</Badge>}
                  </div>
                  {info.presetType.description && (
                    <p className="text-sm text-muted-foreground">{info.presetType.description}</p>
                  )}
                  <div className="grid grid-cols-2 gap-2 text-sm mt-2">
                    <div>
                      <span className="font-medium">Base Strategy:</span> {info.presetType.base_strategy || "N/A"}
                    </div>
                    <div>
                      <span className="font-medium">Direction:</span> {info.presetType.direction || "N/A"}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <Separator />

            {/* Active Indications */}
            <div className="space-y-3">
              <h3 className="text-lg font-semibold">Active Indications ({info?.indications?.length || 0})</h3>
              {!info?.indications || info.indications.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active indications</p>
              ) : (
                <div className="space-y-2">
                  {info.indications.map((ind: any, index: number) => (
                    <div key={index} className="p-3 border rounded-lg">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant={ind.is_enabled ? "default" : "secondary"}>{ind.indication_type}</Badge>
                        <span className="font-medium">{ind.indication_name}</span>
                      </div>
                      <div className="text-xs text-muted-foreground grid grid-cols-3 gap-2">
                        <div>Range: {ind.range || "N/A"}</div>
                        <div>Timeout: {ind.timeout || "N/A"}ms</div>
                        <div>Interval: {ind.interval || "N/A"}ms</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            {/* Adjust Settings */}
            <div className="space-y-3">
              <h3 className="text-lg font-semibold">Configuration Settings</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="p-3 border rounded">
                  <div className="font-medium mb-1">Range Percentage</div>
                  <div className="text-2xl font-bold">{info?.settings?.volumeRangePercentage || 20}%</div>
                </div>
                <div className="p-3 border rounded">
                  <div className="font-medium mb-1">Target Positions</div>
                  <div className="text-2xl font-bold">{info?.settings?.targetPositions || 50}</div>
                </div>
                <div className="p-3 border rounded">
                  <div className="font-medium mb-1">Live Trade Factor</div>
                  <div className="text-2xl font-bold">{info?.settings?.baseVolumeFactorLive || 1.0}</div>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-4">
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
