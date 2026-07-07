"use client"

import { ConnectionSettingsHeader } from "@/components/settings/connection-settings-header"

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      {/* Connection-specific settings header */}
      <ConnectionSettingsHeader />
      
      {/* Settings content */}
      <div className="px-4">
        {children}
      </div>
    </div>
  )
}
