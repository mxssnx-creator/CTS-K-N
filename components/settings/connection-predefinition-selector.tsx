"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ExternalLink } from 'lucide-react'
import { CONNECTION_PREDEFINITIONS, type ConnectionPredefinition } from "@/lib/connection-predefinitions"

interface ConnectionPredefinitionSelectorProps {
  onSelect: (predefinition: ConnectionPredefinition) => void
  existingConnectionIds?: string[]
}

export function ConnectionPredefinitionSelector({
  onSelect,
  existingConnectionIds = [],
}: ConnectionPredefinitionSelectorProps) {
  const [selectedId, setSelectedId] = useState<string>("")
  const [selectedPredefinition, setSelectedPredefinition] = useState<ConnectionPredefinition | null>(null)

  const availablePredefinitions = CONNECTION_PREDEFINITIONS.filter((pred) => !existingConnectionIds.includes(pred.id))

  useEffect(() => {
    if (selectedId) {
      const predefinition = availablePredefinitions.find((p) => p.id === selectedId)
      setSelectedPredefinition(predefinition || null)
    } else {
      setSelectedPredefinition(null)
    }
  }, [selectedId, availablePredefinitions])

  if (availablePredefinitions.length === 0) {
    return null
  }

  const handleUseTemplate = () => {
    if (selectedPredefinition) {
      onSelect(selectedPredefinition)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium">Select Predefined Connection</label>
        <Select value={selectedId} onValueChange={setSelectedId}>
          <SelectTrigger>
            <SelectValue placeholder="Choose a predefined connection template..." />
          </SelectTrigger>
          <SelectContent>
            {availablePredefinitions.map((predefinition) => (
              <SelectItem key={predefinition.id} value={predefinition.id}>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{predefinition.displayName}</span>
                  <Badge variant="secondary" className="text-xs">
                    {predefinition.maxLeverage}x
                  </Badge>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedPredefinition && (
        <Card className="border-primary">
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="text-lg">{selectedPredefinition.displayName}</CardTitle>
                <CardDescription>{selectedPredefinition.description}</CardDescription>
              </div>
              <Badge variant="default">{selectedPredefinition.maxLeverage}x Leverage</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">Contract Type</p>
                <p className="font-medium">{selectedPredefinition.contractType}</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">Position Mode</p>
                <p className="font-medium capitalize">{selectedPredefinition.positionMode}</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">Margin Type</p>
                <p className="font-medium capitalize">{selectedPredefinition.marginType}</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">Connection Method</p>
                <p className="font-medium uppercase">{selectedPredefinition.connectionMethod}</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">API Type</p>
                <p className="font-medium">{selectedPredefinition.apiType}</p>
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-xs">Library</p>
                <p className="font-medium">{selectedPredefinition.id.split("-")[0]}</p>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t">
              <a
                href={selectedPredefinition.documentationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1"
              >
                View Documentation
                <ExternalLink className="h-3 w-3" />
              </a>
              <Button onClick={handleUseTemplate}>Use This Template</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
