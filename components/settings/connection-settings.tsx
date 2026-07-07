"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Activity, Database, Power, Trash2, Download, Upload } from "lucide-react"
import { toast } from "sonner"

export interface ExchangeConnection {
  id: string
  name: string
  exchange: string
  api_type: string
  connection_method: string
  authentication_type: string
  api_key: string
  api_secret: string
  margin_type: string
  position_mode: string
  is_testnet: boolean
  is_enabled: boolean
  is_active: boolean
  is_predefined: boolean
}

interface ConnectionSettingsProps {
  connections: ExchangeConnection[]
  selectedExchangeConnection: string | null
  onConnectionToggle: (id: string) => void
  onConnectionDelete: (id: string) => void
  onConnectionSelect: (id: string | null) => void
  onLoadConnections: () => void
  onImportUserConnections: () => void
  onInitPredefinedConnections: () => void
}

export function ConnectionSettings({
  connections,
  selectedExchangeConnection,
  onConnectionToggle,
  onConnectionDelete,
  onConnectionSelect,
  onLoadConnections,
  onImportUserConnections,
  onInitPredefinedConnections,
}: ConnectionSettingsProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [connectionToDelete, setConnectionToDelete] = useState<string | null>(null)

  const handleDeleteClick = (id: string) => {
    setConnectionToDelete(id)
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (connectionToDelete) {
      await onConnectionDelete(connectionToDelete)
      setDeleteDialogOpen(false)
      setConnectionToDelete(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border bg-gradient-to-br from-primary/10 via-background to-background p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground">
              <Database className="h-3.5 w-3.5 text-primary" />
              Connection Settings
            </div>
            <h3 className="text-xl font-semibold tracking-tight">Base Connections</h3>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Manage exchange API connections, activation state, and quick recovery actions from one control panel.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onImportUserConnections}>
              <Upload className="h-3 w-3 mr-2" />
              Import User Connections
            </Button>
            <Button size="sm" variant="outline" onClick={onInitPredefinedConnections}>
              <Download className="h-3 w-3 mr-2" />
              Init Predefined
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-4">
        {connections.length === 0 ? (
          <Card className="border-dashed p-10 text-center shadow-sm">
            <p className="text-muted-foreground">No connections configured</p>
            <Button className="mt-4 bg-transparent" variant="outline" onClick={onImportUserConnections}>
              Import User Connections
            </Button>
          </Card>
        ) : (
          connections.map((conn) => (
            <Card key={conn.id} className="overflow-hidden border-muted-foreground/15 p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
                      <Activity className="h-4 w-4 text-primary" />
                    </div>
                    <h4 className="font-semibold">{conn.name}</h4>
                    {conn.is_active && (
                      <Badge variant="default" className="text-xs">
                        Active
                      </Badge>
                    )}
                    {conn.is_predefined && (
                      <Badge variant="secondary" className="text-xs">
                        Predefined
                      </Badge>
                    )}
                    {conn.is_testnet && (
                      <Badge variant="outline" className="text-xs">
                        Testnet
                      </Badge>
                    )}
                  </div>
                  <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                    <div>Exchange: {conn.exchange}</div>
                    <div>Type: {conn.api_type}</div>
                    <div>
                      Margin: {conn.margin_type} | Position: {conn.position_mode}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <div className="flex items-center gap-2 rounded-full border bg-muted/40 px-3 py-1.5">
                    <Label htmlFor={`enabled-${conn.id}`} className="text-xs">
                      Enabled
                    </Label>
                    <Switch
                      id={`enabled-${conn.id}`}
                      checked={conn.is_enabled}
                      onCheckedChange={() => {
                        onConnectionToggle(conn.id)
                      }}
                    />
                  </div>
                  
                  <Button
                    size="sm"
                    variant={conn.is_active ? "default" : "outline"}
                    onClick={() =>
                      onConnectionSelect(conn.is_active ? null : conn.id)
                    }
                    disabled={!conn.is_enabled}
                  >
                    <Power className="h-3 w-3 mr-1" />
                    {conn.is_active ? "Active" : "Activate"}
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    className="border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                    onClick={() => handleDeleteClick(conn.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </Card>
          ))
        )}
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent className="border-destructive/20 sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive"><Trash2 className="h-4 w-4" /> Delete Connection</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this connection? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={handleDeleteConfirm}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
