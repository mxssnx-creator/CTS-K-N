"use client"

export const dynamic = "force-dynamic"

import { SignalIndicationSettings } from "@/components/settings/signal-indication-settings"

export default function SignalIndicationsSettingsPage() {
  return (
    <div className="space-y-4 p-3 sm:p-4">
      <SignalIndicationSettings />
    </div>
  )
}
