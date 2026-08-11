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
    <div className="page-section space-y-5">
      <div className="rounded-xl border bg-card/70 p-4">
        <p className="text-sm text-muted-foreground">
          Welcome back, {user?.username || "Administrator"}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>System Status</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">The authenticated React application shell rendered successfully.</p>
            <p className="mt-2 text-xs text-muted-foreground">Use Monitoring and Database Migrations for authoritative dependency health.</p>
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
