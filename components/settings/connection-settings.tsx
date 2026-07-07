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
import { Power, Trash2, Download, Upload } from "lucide-react"
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
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold">Base Connections</h3>
          <div className="flex gap-2">
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
        <p className="text-xs text-muted-foreground">
          Manage your base exchange API connections. Enable/disable connections or delete them.
        </p>
      </div>

      <div className="grid gap-4">
        {connections.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground">No connections configured</p>
            <Button className="mt-4 bg-transparent" variant="outline" onClick={onImportUserConnections}>
              Import User Connections
            </Button>
          </Card>
        ) : (
          connections.map((conn) => (
            <Card key={conn.id} className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
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
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <div>Exchange: {conn.exchange}</div>
                    <div>Type: {conn.api_type}</div>
                    <div>
                      Margin: {conn.margin_type} | Position: {conn.position_mode}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`enabled-${conn.id}`} className="text-xs">
                      Enabled
                    </Label>
                    <Switch
                      id={`enabled-${conn.id}`}
                      checked={conn.is_enabled}
                      onCheckedChange={(checked) => {
                        console.log("[v0] Toggle connection:", conn.id, "to:", checked)
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
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Connection</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this connection? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
