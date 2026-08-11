import Link from "next/link"
import { ArrowLeft, Radar } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-xl overflow-hidden bg-card/95">
        <div className="h-1 bg-gradient-to-r from-primary via-cyan-500 to-transparent" />
        <CardHeader>
          <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
            <Radar className="h-5 w-5" />
          </div>
          <CardTitle>Route outside the control plane</CardTitle>
          <CardDescription>The requested page is not registered in this CTS-K-N workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              Return to command center
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
