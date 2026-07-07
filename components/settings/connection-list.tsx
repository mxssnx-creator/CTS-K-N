"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
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
import { Download, Upload } from "lucide-react"
import { ConnectionCard, type ExchangeConnection } from "./connection-card"

interface ConnectionListProps {
  connections: ExchangeConnection[]
  onConnectionToggle: (id: string) => void
  onConnectionDelete: (id: string) => void
  onConnectionSelect: (id: string | null) => void
  onImportUserConnections: () => void
  onInitPredefinedConnections: () => void
}

export function ConnectionList({
  connections,
  onConnectionToggle,
  onConnectionDelete,
  onConnectionSelect,
  onImportUserConnections,
  onInitPredefinedConnections,
}: ConnectionListProps) {
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
              Import User
            </Button>
            <Button size="sm" variant="outline" onClick={onInitPredefinedConnections}>
              <Download className="h-3 w-3 mr-2" />
              Init Predefined
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Manage your base exchange API connections. Enable/disable connections or delete them. Enabled base connections are available for Main Connections workflows.
        </p>
      </div>

      {/* Enabled Connections Section */}
      {connections.filter((c) => c.is_enabled).length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-green-700">Enabled Base Connections ({connections.filter((c) => c.is_enabled).length})</h4>
          <div className="grid gap-3">
            {connections
              .filter((c) => c.is_enabled)
              .map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  onToggle={() => onConnectionToggle(connection.id)}
                  onActivate={() => {}}
                  onDelete={() => handleDeleteClick(connection.id)}
                  onEdit={() => onConnectionSelect(connection.id)}
                  onShowDetails={() => onConnectionSelect(connection.id)}
                  onShowLogs={() => onConnectionSelect(connection.id)}
                />
              ))}
          </div>
        </div>
      )}

      {/* Disabled Connections Section */}
      {connections.filter((c) => !c.is_enabled).length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-semibold text-muted-foreground">Disabled Connections ({connections.filter((c) => !c.is_enabled).length})</h4>
          <div className="grid gap-3">
            {connections
              .filter((c) => !c.is_enabled)
              .map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  onToggle={() => onConnectionToggle(connection.id)}
                  onActivate={() => {}}
                  onDelete={() => handleDeleteClick(connection.id)}
                  onEdit={() => onConnectionSelect(connection.id)}
                  onShowDetails={() => onConnectionSelect(connection.id)}
                  onShowLogs={() => onConnectionSelect(connection.id)}
                />
              ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {connections.length === 0 && (
        <Card>
          <p className="text-sm text-center text-muted-foreground">No connections available.</p>
        </Card>
      )}

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
