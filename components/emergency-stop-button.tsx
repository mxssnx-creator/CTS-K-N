"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { AlertTriangle, Loader2, Power } from "lucide-react"
import { toast } from "sonner"

export function EmergencyStopButton() {
  const [isExecuting, setIsExecuting] = useState(false)
  const [isOpen, setIsOpen] = useState(false)

  const handleEmergencyStop = async () => {
    setIsExecuting(true)

    try {
      console.log("[v0] Executing emergency stop...")

      const response = await fetch("/api/trade-engine/emergency-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })

      const data = await response.json()

      if (data.success) {
        toast.error("Emergency Stop Activated", {
          description: "All trading operations have been halted.",
          duration: 10000,
        })

        console.log("[v0] Emergency stop completed:", data)
        setIsOpen(false)

        // Reload page after 2 seconds to reflect changes
        setTimeout(() => {
          window.location.reload()
        }, 2000)
      } else {
        throw new Error(data.error || "Emergency stop failed")
      }
    } catch (error) {
      console.error("[v0] Emergency stop failed:", error)
      toast.error("Emergency Stop Failed", {
        description: error instanceof Error ? error.message : "Manual intervention required",
        duration: 10000,
      })
    } finally {
      setIsExecuting(false)
    }
  }

  return (
    <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="destructive"
          size="lg"
          className="gap-2 font-semibold shadow-lg hover:shadow-xl transition-shadow"
        >
          <Power className="h-5 w-5" />
          Emergency Stop
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <div className="flex items-center gap-3 text-destructive mb-2">
            <AlertTriangle className="h-6 w-6" />
            <AlertDialogTitle className="text-xl">Emergency Stop</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="space-y-3 text-base">
            <p className="font-semibold">This will immediately:</p>
            <ul className="list-disc list-inside space-y-1 text-sm">
              <li>Stop all trade engine instances</li>
              <li>Disable all live trading connections</li>
              <li>Disable all preset trading connections</li>
              <li>Halt all active trading operations</li>
            </ul>
            <p className="text-destructive font-semibold mt-4">
              Are you absolutely sure you want to proceed?
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isExecuting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleEmergencyStop}
            disabled={isExecuting}
            className="bg-destructive hover:bg-destructive/90"
          >
            {isExecuting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Stopping...
              </>
            ) : (
              <>
                <Power className="h-4 w-4 mr-2" />
                Execute Emergency Stop
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
