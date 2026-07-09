import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  try {
    const { getStartupDiagnostics } = await import("@/lib/startup-diagnostics")
    return NextResponse.json({ success: true, diagnostics: await getStartupDiagnostics() })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error), observed_at: new Date().toISOString() },
      { status: 500 },
    )
  }
}
