"use client"

import { useEffect } from "react"
import Link from "next/link"
import { AlertCircle, Home, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[CTS-K-N] Page boundary error:", error)
  }, [error])

  return (
    <div className="flex min-h-[70dvh] items-center justify-center p-4">
      <Card className="w-full max-w-2xl border-destructive/30 bg-card/95">
        <CardHeader>
          <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive">
            <AlertCircle className="h-5 w-5" />
          </div>
          <CardTitle>Page workflow interrupted</CardTitle>
          <CardDescription>
            The control plane isolated this page error. Running engines and other routes remain independent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-muted/35 p-3 font-mono text-xs text-muted-foreground">
            <p className="break-words text-foreground">{error.message || "An unexpected interface error occurred."}</p>
            {error.digest && <p className="mt-2">Reference: {error.digest}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={reset}>
              <RefreshCw className="h-4 w-4" />
              Retry page
            </Button>
            <Button variant="outline" asChild>
              <Link href="/">
                <Home className="h-4 w-4" />
                Command center
              </Link>
            </Button>
          </div>
          {process.env.NODE_ENV === "development" && error.stack && (
            <details className="rounded-lg border bg-muted/20 p-3 text-xs">
              <summary className="cursor-pointer font-medium">Development stack trace</summary>
              <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-muted-foreground">{error.stack}</pre>
            </details>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
