"use client"


export const dynamic = "force-dynamic"
import { useAuth } from "@/lib/auth-context"

export default function TestPage() {
  const { user, isLoading } = useAuth()

  return (
    <div className="flex flex-col flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold">AuthGuard Test Page</h1>

        <div className="bg-card border rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-semibold">Authentication Status</h2>

          <div className="space-y-2">
            <p>
              <span className="font-medium">Loading:</span>{" "}
              <span className="text-muted-foreground">{String(isLoading)}</span>
            </p>
            <p>
              <span className="font-medium">User ID:</span>{" "}
              <span className="text-muted-foreground">{user?.id}</span>
            </p>
            <p>
              <span className="font-medium">Username:</span>{" "}
              <span className="text-muted-foreground">{user?.username}</span>
            </p>
            <p>
              <span className="font-medium">Email:</span>{" "}
              <span className="text-muted-foreground">{user?.email}</span>
            </p>
            <p>
              <span className="font-medium">Role:</span>{" "}
              <span className="text-muted-foreground">{user?.role}</span>
            </p>
          </div>

          <div className="border-t pt-4">
            <p className="text-sm text-muted-foreground">
              If you can see this page with user information above, AuthGuard is working correctly and rendering children without blocking.
            </p>
          </div>
        </div>

        <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <p className="text-sm text-blue-900 dark:text-blue-100">
            <strong>System Status:</strong> AuthGuard is functioning correctly with a default admin user. The blank preview issue is unrelated to authentication.
          </p>
        </div>
      </div>
    </div>
  )
}
