export const dynamic = "force-dynamic"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Info } from "lucide-react"

export default function AdditionalPage() {
  return (
    <div className="page-section space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-5 w-5" />
            About Additional Features
          </CardTitle>
          <CardDescription>Supplementary operational references and workspace tools</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-semibold">What is this section?</h3>
            <p className="text-sm text-muted-foreground">
              The Reference section contains isolated tools and documentation that supplement the core CTS-K-N
              trading system without modifying or replacing any main functionality.
            </p>
          </div>

          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-semibold">Core System Protection</h3>
            <p className="text-sm text-muted-foreground">
              Features in this section do not mutate the running engine unless an individual page explicitly exposes
              an authenticated control. Core execution and progression continue independently.
            </p>
          </div>

          <div className="rounded-lg border p-4 space-y-2">
            <h3 className="font-semibold">Adding New Features</h3>
            <p className="text-sm text-muted-foreground">
              Reference tools are implemented under{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">/app/additional/</code>
              and registered in the sidebar so every visible destination has a real route and a consistent shell.
            </p>
          </div>

          <div className="rounded-lg bg-muted p-4 space-y-2">
            <p className="text-xs text-muted-foreground font-mono">
              Available now: local chat-history export and the systemwide volume-ratio calculation reference.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
