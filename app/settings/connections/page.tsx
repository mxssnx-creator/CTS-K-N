import { redirect } from "next/navigation"

/**
 * /settings/connections — redirects to the main Settings page which contains
 * the Connection tab. This avoids a 404 when any part of the app links here.
 */
export default function SettingsConnectionsPage() {
  redirect("/settings?tab=exchange")
}
