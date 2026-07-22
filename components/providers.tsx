"use client"

import type React from "react"
import { ThemeProvider } from "@/components/theme-provider"
import { AuthProvider } from "@/lib/auth-context"
import { ExchangeProvider } from "@/lib/exchange-context"
import { StyleInitializer } from "@/components/style-initializer"
import { ProgressTracker, SessionSynchronizer } from "@/components/session-synchronizer"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      <StyleInitializer />
      <SessionSynchronizer />
      <ProgressTracker />
      <AuthProvider>
        <ExchangeProvider>
          {children}
        </ExchangeProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}
