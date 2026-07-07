import type React from "react"

export const dynamic = "force-dynamic"

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      {children}
    </div>
  )
}
