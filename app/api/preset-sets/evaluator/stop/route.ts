import { type NextRequest, NextResponse } from "next/server"
import { getSetEvaluator } from "@/lib/preset-set-evaluator"

// POST /api/preset-sets/evaluator/stop - Stop hourly re-evaluation
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const evaluator = getSetEvaluator()
    evaluator.stop()

    return NextResponse.json({ message: "Set evaluator stopped", status: "stopped" })
  } catch (error) {
    console.error("[v0] Failed to stop Set evaluator:", error)
    return NextResponse.json({ error: "Failed to stop evaluator" }, { status: 500 })
  }
}
