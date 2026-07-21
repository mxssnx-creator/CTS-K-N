"use client"

import type React from "react"
import { ConnectionStateProvider } from "@/lib/connection-state"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { Toaster } from "sonner"

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <ConnectionStateProvider>
      <SidebarProvider>
        <div className="flex h-dvh min-h-screen w-full overflow-hidden bg-muted/20">
          <AppSidebar />
          <main className="flex flex-col flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
            {children}
            <footer className="mt-auto px-6 py-2 flex justify-end min-w-0 overflow-hidden">
              <span className="text-[11px] font-mono text-muted-foreground/40 select-none tracking-wide shrink-0">
                v0.1.1
              </span>
            </footer>
          </main>
        </div>
        <Toaster />
      </SidebarProvider>
    </ConnectionStateProvider>
  )
}
