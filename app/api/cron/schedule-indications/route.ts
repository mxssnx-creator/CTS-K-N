/**
 * Production Cron Scheduler for Indication Generation
 * 
 * This endpoint can be called every 1-3 seconds by an external scheduler
 * (Vercel Crons, AWS EventBridge, etc.) to keep the trade engine constantly
 * fed with new indications.
 * 
 * Without this, indications only generate when a browser is open.
 */

import { NextResponse } from "next/server"
import { authorizeCronRequest, createInternalCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 60
export const revalidate = 0
export const fetchCache = "force-no-store"

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.ok) return cronAuthorizationResponse(auth)

  try {
    // Execute the shared route handler directly. HTTP self-fetches can deadlock
    // a single-worker dev/preview server and add needless network overhead.
    const mod = await import("@/app/api/cron/generate-indications/route")
    const response = await mod.GET(createInternalCronRequest("/api/cron/generate-indications"))
    const data = await response.json()

    return NextResponse.json(
      {
        success: response.ok,
        message: "Cron executed",
        data,
      },
      { status: response.ok ? 200 : 500 }
    )
  } catch (error) {
    console.error("[Cron] schedule-indications error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  // Support POST for task scheduler compatibility
  return GET(request)
}
