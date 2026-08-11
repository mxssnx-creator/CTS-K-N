"use client"

export const dynamic = "force-dynamic"

import { SignalIndicationSettings } from "@/components/settings/signal-indication-settings"

export default function SignalIndicationsSettingsPage() {
  return (
    <div className="page-section space-y-4">
      <SignalIndicationSettings />
    </div>
  )
}
