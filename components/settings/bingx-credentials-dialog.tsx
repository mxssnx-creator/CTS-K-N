"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { AlertCircle, CheckCircle2, Loader2, Lock } from "lucide-react"
import { submitBingXCredentials } from "@/lib/bingx-credentials-helper"

interface BingXCredentialsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess?: () => void
}

export function BingXCredentialsDialog({ open, onOpenChange, onSuccess }: BingXCredentialsDialogProps) {
  const [apiKey, setApiKey] = useState("")
  const [apiSecret, setApiSecret] = useState("")
  const [apiPassphrase, setApiPassphrase] = useState("")
  const [loading, setLoading] = useState(false)
  const [showSecrets, setShowSecrets] = useState(false)
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!apiKey.trim() || !apiSecret.trim()) {
      setMessage({ type: "error", text: "API key and secret are required" })
      return
    }

    if (apiKey.length < 20 || apiSecret.length < 20) {
      setMessage({ type: "error", text: "API key and secret must be at least 20 characters" })
      return
    }

    setLoading(true)
    setMessage(null)

    try {
      const result = await submitBingXCredentials(apiKey, apiSecret, apiPassphrase)

      if (result.success) {
        setMessage({ type: "success", text: "BingX credentials configured successfully!" })
        setTimeout(() => {
          setApiKey("")
          setApiSecret("")
          setApiPassphrase("")
          onOpenChange(false)
          onSuccess?.()
        }, 1500)
      } else {
        setMessage({ type: "error", text: result.error || "Failed to save credentials" })
      }
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unknown error" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-blue-600" />
            Configure BingX API Credentials
          </DialogTitle>
          <DialogDescription>
            Enter your real BingX API credentials. These will be used for live trading on mainnet.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="api-key" className="text-sm font-medium">
              API Key
            </Label>
            <Input
              id="api-key"
              type={showSecrets ? "text" : "password"}
              placeholder="Enter your BingX API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={loading}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Get from: https://www.bingx.com/en/account/my-api
            </p>
          </div>

          <div>
            <Label htmlFor="api-secret" className="text-sm font-medium">
              API Secret
            </Label>
            <Input
              id="api-secret"
              type={showSecrets ? "text" : "password"}
              placeholder="Enter your BingX API secret"
              value={apiSecret}
              onChange={(e) => setApiSecret(e.target.value)}
              disabled={loading}
              className="mt-1"
            />
          </div>

          <div>
            <Label htmlFor="api-passphrase" className="text-sm font-medium">
              API Passphrase (Optional)
            </Label>
            <Input
              id="api-passphrase"
              type={showSecrets ? "text" : "password"}
              placeholder="Enter your BingX API passphrase if configured"
              value={apiPassphrase}
              onChange={(e) => setApiPassphrase(e.target.value)}
              disabled={loading}
              className="mt-1"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="show-secrets"
              checked={showSecrets}
              onChange={(e) => setShowSecrets(e.target.checked)}
              className="h-4 w-4"
            />
            <label htmlFor="show-secrets" className="text-sm cursor-pointer">
              Show passwords
            </label>
          </div>

          {message && (
            <div className={`flex items-center gap-2 p-3 rounded-md text-sm ${
              message.type === "success" 
                ? "bg-green-50 text-green-700 border border-green-200" 
                : "bg-red-50 text-red-700 border border-red-200"
            }`}>
              {message.type === "success" ? (
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              ) : (
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
              )}
              <span>{message.text}</span>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading || !apiKey.trim() || !apiSecret.trim()}
              className="gap-2"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              {loading ? "Saving..." : "Configure"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
