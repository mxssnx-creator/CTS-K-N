"use client"

import { Button } from "@/components/ui/button"
import { Download, Upload } from "lucide-react"
import { toast } from "sonner"

interface SettingsFileManagerProps {
  onSettingsLoaded: () => void
  onDatabaseTypeLoaded: () => void
}

export function SettingsFileManager({
  onSettingsLoaded,
  onDatabaseTypeLoaded,
}: SettingsFileManagerProps) {
  const handleImport = () => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = ".txt"
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) {
        const formData = new FormData()
        formData.append("file", file)
        try {
          const response = await fetch("/api/settings/import", {
            method: "POST",
            body: formData,
          })
          const data = await response.json()
          if (data.success) {
            toast.success(`Imported ${data.imported} settings`)
            onSettingsLoaded()
            onDatabaseTypeLoaded()
          } else {
            toast.error("Import failed: " + data.error)
          }
        } catch (error) {
          toast.error("Failed to import settings")
        }
      }
    }
    input.click()
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Settings File Management</h3>
      <p className="text-xs text-muted-foreground">
        Export settings to a text file or import from a previously saved file
      </p>
      <div className="grid md:grid-cols-2 gap-4">
        <Button
          variant="outline"
          onClick={() => {
            window.location.href = "/api/settings/export"
          }}
        >
          <Download className="h-4 w-4 mr-2" />
          Export Settings (TXT)
        </Button>
        <Button variant="outline" onClick={handleImport}>
          <Upload className="h-4 w-4 mr-2" />
          Import Settings (TXT)
        </Button>
      </div>
    </div>
  )
}
