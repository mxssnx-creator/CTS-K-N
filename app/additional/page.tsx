export const dynamic = "force-dynamic"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Info } from "lucide-react"

export default function AdditionalPage() {
  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">Additional Features</h2>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-5 w-5" />
            About Additional Features
          </CardTitle>
          <CardDescription>Experimental and supplementary features for CTS v3.1</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-semibold">What is this section?</h3>
            <p className="text-sm text-muted-foreground">
              The Additional section contains experimental features, tools, and pages that supplement the core CTS v3.1
              trading system without modifying or replacing any main functionality.
            </p>
          </div>

          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-semibold">Core System Protection</h3>
            <p className="text-sm text-muted-foreground">
              All features in this section are isolated from the main trading system. The core navigation pages
              (Overview, Live Trading, Presets, Settings, etc.) remain unchanged and fully functional.
            </p>
          </div>

          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-semibold">Adding New Features</h3>
            <p className="text-sm text-muted-foreground">
              To add a new feature, create a page under{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/app/additional/</code>
              and update the <code className="text-xs bg-muted px-1 py-0.5 rounded">additionalItems</code> array in
              <code className="text-xs bg-muted px-1 py-0.5 rounded">components/app-sidebar.tsx</code>.
            </p>
          </div>

          <div className="rounded-lg bg-muted p-4 space-y-2">
            <p className="text-xs text-muted-foreground font-mono">
              No additional features have been added yet. This section will appear in the sidebar navigation once items
              are added to the additionalItems array.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
