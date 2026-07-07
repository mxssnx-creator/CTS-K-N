"use client"

import { useEffect } from "react"
import { AlertCircle, RefreshCw, Home } from "lucide-react"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[v0] Page error:", error)
  }, [error])

  return (
    <div style={{ 
      minHeight: "100vh", 
      display: "flex", 
      alignItems: "center", 
      justifyContent: "center",
      padding: "20px",
      fontFamily: "system-ui, sans-serif"
    }}>
      <div style={{ maxWidth: "600px", width: "100%" }}>
        <h1 style={{ color: "#dc2626", marginBottom: "10px", display: "flex", alignItems: "center", gap: "8px" }}>
          <AlertCircle style={{ width: "24px", height: "24px" }} />
          Page Error
        </h1>
        <p style={{ color: "#6b7280", marginBottom: "20px" }}>
          {error.message}
        </p>
        {error.digest && (
          <p style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "20px" }}>
            Error ID: {error.digest}
          </p>
        )}
        <div style={{ display: "flex", gap: "10px" }}>
          <button 
            onClick={reset}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              background: "#000",
              color: "#fff",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "8px"
            }}
          >
            <RefreshCw style={{ height: "16px" }} />
            Try Again
          </button>
          <button 
            onClick={() => (window.location.href = "/")}
            style={{
              padding: "8px 16px",
              borderRadius: "6px",
              background: "#fff",
              color: "#000",
              border: "1px solid #d1d5db",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "8px"
            }}
          >
            <Home style={{ height: "16px" }} />
            Go Home
          </button>
        </div>
        {process.env.NODE_ENV === "development" && error.stack && (
          <details style={{ marginTop: "20px" }}>
            <summary style={{ cursor: "pointer", marginBottom: "10px" }}>Stack Trace</summary>
            <pre style={{ 
              background: "#1f2937", 
              color: "#e5e7eb", 
              padding: "12px", 
              borderRadius: "6px",
              overflow: "auto",
              fontSize: "12px"
            }}>
              {error.stack}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}
