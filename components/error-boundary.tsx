"use client"

import type React from "react"
import { Component, type ReactNode } from "react"
import { AlertCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    }
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      error,
      errorInfo: null,
    }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log to monitoring API
    fetch("/api/monitoring/site", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "error",
        category: "react",
        message: error.message,
        stack: error.stack,
        metadata: {
          componentStack: errorInfo.componentStack,
          errorBoundary: true,
        },
      }),
    }).catch(() => { /* non-critical */ })

    this.setState({
      error,
      errorInfo,
    })

    if (this.props.onError) {
      this.props.onError(error, errorInfo)
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="flex items-center justify-center min-h-[400px] p-6">
          <Card className="max-w-2xl w-full border-destructive">
            <CardHeader>
              <div className="flex items-center gap-3">
                <AlertCircle className="h-6 w-6 text-destructive" />
                <div>
                  <CardTitle>Something went wrong</CardTitle>
                  <CardDescription>An error occurred while rendering this component</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-muted p-4 rounded-lg">
                <p className="font-mono text-sm text-destructive">{this.state.error?.message}</p>
              </div>

              {process.env.NODE_ENV === "development" && this.state.error?.stack && (
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium mb-2">Stack Trace</summary>
                  <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-xs">{this.state.error.stack}</pre>
                </details>
              )}

              {process.env.NODE_ENV === "development" && this.state.errorInfo?.componentStack && (
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium mb-2">Component Stack</summary>
                  <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-xs">
                    {this.state.errorInfo.componentStack}
                  </pre>
                </details>
              )}

              <div className="flex gap-2">
                <Button onClick={this.handleReset} variant="default">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Try Again
                </Button>
                <Button onClick={() => window.location.reload()} variant="outline">
                  Reload Page
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
