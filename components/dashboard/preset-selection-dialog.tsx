"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, Target, Zap, CheckCircle } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface PresetOption {
  id: string
  name: string
  description: string
  type: "main" | "common" | "enhancement"
  is_active: boolean
}

interface PresetSelectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectPreset: (presetId: string) => Promise<void>
}

export function PresetSelectionDialog({ open, onOpenChange, onSelectPreset }: PresetSelectionDialogProps) {
  const [presets, setPresets] = useState<PresetOption[]>([])
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (open) {
      loadPresets()
    }
  }, [open])

  const loadPresets = async () => {
    try {
      setIsLoading(true)
      const response = await fetch("/api/presets", {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      })
      if (response.ok) {
        const data = await response.json()

        // Map database presets to the PresetOption format
        const presetOptions: PresetOption[] = (Array.isArray(data) ? data : []).map((p: any) => ({
          id: p.id,
          name: p.name,
          description: p.description || "No description",
          type: (p.preset_trade_type || "main") as "main" | "common" | "enhancement",
          is_active: p.is_active === true,
        }))
        
        setPresets(presetOptions)
        
        // Select first active preset by default
        const activePreset = presetOptions.find((p) => p.is_active)
        if (activePreset) {
          setSelectedPreset(activePreset.id)
        } else if (presetOptions.length > 0) {
          setSelectedPreset(presetOptions[0].id)
        }
      }
      } catch (error) {
        toast.error("Failed to load presets")
      } finally {
      setIsLoading(false)
    }
  }

  const handleSelectAndActivate = async () => {
    if (!selectedPreset) {
      toast.error("Please select a preset")
      return
    }

    try {
      setIsSaving(true)
      await onSelectPreset(selectedPreset)
      toast.success("Preset activated successfully")
      onOpenChange(false)
    } catch (error) {
      toast.error("Failed to activate preset")
    } finally {
      setIsSaving(false)
    }
  }

  const mainPresets = presets.filter((p) => p.type === "main")
  const commonPresets = presets.filter((p) => p.type === "common")
  const enhancementPresets = presets.filter((p) => p.type === "enhancement")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Preset Selection Mode
          </DialogTitle>
          <DialogDescription>Select and activate a preset configuration for your trading strategy</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : presets.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-muted-foreground">No presets available. Create presets from the Presets page.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Main Presets */}
            {mainPresets.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-orange-500" />
                  <h3 className="font-semibold text-lg">Main Presets</h3>
                  <Badge variant="secondary">{mainPresets.length}</Badge>
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {mainPresets.map((preset) => (
                    <Card
                      key={preset.id}
                      className={`cursor-pointer transition-all ${
                        selectedPreset === preset.id ? "border-primary bg-primary/5 ring-2 ring-primary" : "hover:border-primary/50"
                      }`}
                      onClick={() => setSelectedPreset(preset.id)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="font-semibold">{preset.name}</h4>
                              {preset.is_active && <Badge variant="default" className="text-xs">Active</Badge>}
                              {selectedPreset === preset.id && (
                                <CheckCircle className="h-4 w-4 text-primary" />
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">{preset.description}</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Common Presets */}
            {commonPresets.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-blue-500" />
                  <h3 className="font-semibold text-lg">Common Presets</h3>
                  <Badge variant="secondary">{commonPresets.length}</Badge>
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {commonPresets.map((preset) => (
                    <Card
                      key={preset.id}
                      className={`cursor-pointer transition-all ${
                        selectedPreset === preset.id ? "border-primary bg-primary/5 ring-2 ring-primary" : "hover:border-primary/50"
                      }`}
                      onClick={() => setSelectedPreset(preset.id)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="font-semibold">{preset.name}</h4>
                              {preset.is_active && <Badge variant="default" className="text-xs">Active</Badge>}
                              {selectedPreset === preset.id && (
                                <CheckCircle className="h-4 w-4 text-primary" />
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">{preset.description}</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Enhancement Presets */}
            {enhancementPresets.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-green-500" />
                  <h3 className="font-semibold text-lg">Enhancement Presets</h3>
                  <Badge variant="secondary">{enhancementPresets.length}</Badge>
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {enhancementPresets.map((preset) => (
                    <Card
                      key={preset.id}
                      className={`cursor-pointer transition-all ${
                        selectedPreset === preset.id ? "border-primary bg-primary/5 ring-2 ring-primary" : "hover:border-primary/50"
                      }`}
                      onClick={() => setSelectedPreset(preset.id)}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h4 className="font-semibold">{preset.name}</h4>
                              {preset.is_active && <Badge variant="default" className="text-xs">Active</Badge>}
                              {selectedPreset === preset.id && (
                                <CheckCircle className="h-4 w-4 text-primary" />
                              )}
                            </div>
                            <p className="text-sm text-muted-foreground">{preset.description}</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSelectAndActivate} disabled={!selectedPreset || isSaving}>
            {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Target className="h-4 w-4 mr-2" />}
            Activate Preset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
