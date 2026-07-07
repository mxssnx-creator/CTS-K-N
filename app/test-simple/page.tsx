"use client"
export const dynamic = "force-dynamic"


export default function TestPage() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">System Test</h1>
        <p className="text-lg text-muted-foreground">If you see this, the app is rendering correctly.</p>
        <div className="space-y-2 text-sm">
          <p>✓ Server is running</p>
          <p>✓ React rendering works</p>
          <p>✓ CSS is loaded</p>
          <p>✓ Layout is responsive</p>
        </div>
      </div>
    </div>
  )
}
