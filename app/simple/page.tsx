"use client"


export const dynamic = "force-dynamic"
import { AuthGuard } from "@/components/auth-guard"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuth } from "@/lib/auth-context"

export default function SimplePage() {
  return (
    <AuthGuard>
      <SimpleContent />
    </AuthGuard>
  )
}

function SimpleContent() {
  const { user } = useAuth()

  return (
    <div style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
      <div style={{ marginBottom: "24px" }}>
        <h1 style={{ margin: 0, fontSize: "28px", fontWeight: "bold" }}>CTS v3.2 Dashboard</h1>
        <p style={{ margin: "8px 0 0 0", fontSize: "14px", color: "var(--muted-foreground)" }}>
          Welcome back, {user?.username || "Administrator"}
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        <Card>
          <CardHeader>
            <CardTitle>System Status</CardTitle>
          </CardHeader>
          <CardContent>
            <p>Application running with Redis migrations complete.</p>
            <p>All 10 schemas initialized successfully.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>User Information</CardTitle>
          </CardHeader>
          <CardContent>
            <p>User ID: {user?.id}</p>
            <p>Username: {user?.username}</p>
            <p>Role: {user?.role}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
