import type React from "react"
import { DashboardShell } from "@/components/dashboard-shell"
import { SettingsProtectionPanel } from "@/components/settings/settings-protection-panel"

export default function Layout({ children }: { children: React.ReactNode }) {
  return <DashboardShell><SettingsProtectionPanel />{children}</DashboardShell>
}
