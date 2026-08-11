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
        <a
          href="#main-content"
          className="skip-navigation"
        >
          Skip to main content
        </a>
        <div className="app-shell flex h-dvh min-h-dvh w-full overflow-hidden">
          <AppSidebar />
          <main
            id="main-content"
            data-dashboard-scroll
            tabIndex={-1}
            className="app-shell-main relative flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
          >
            {children}
            <footer className="app-footer mt-auto flex min-w-0 items-center justify-between gap-3 px-4 py-3 sm:px-6">
              <span className="truncate text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
                Continuous execution control
              </span>
              <span className="shrink-0 select-none font-mono text-[10px] tracking-wide text-muted-foreground/60">
                CTS-K-N · v0.1.1
              </span>
            </footer>
          </main>
        </div>
        <Toaster />
      </SidebarProvider>
    </ConnectionStateProvider>
  )
}
