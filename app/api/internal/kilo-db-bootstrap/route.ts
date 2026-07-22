import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// This path existed briefly during managed-store diagnostics. It must never
// expose deployment credentials; keep a hard 404 until the route disappears
// from every automatically generated deployment.
export function GET() {
  return new NextResponse(null, {
    status: 404,
    headers: { "Cache-Control": "no-store, max-age=0" },
  })
}
