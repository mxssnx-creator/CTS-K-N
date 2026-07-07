import { type NextRequest, NextResponse } from "next/server"
import { getSetEvaluator } from "@/lib/preset-set-evaluator"

// POST /api/preset-sets/evaluator/start - Start hourly re-evaluation
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const evaluator = getSetEvaluator()
    evaluator.start()

    return NextResponse.json({ message: "Set evaluator started", status: "running" })
  } catch (error) {
    console.error("[v0] Failed to start Set evaluator:", error)
    return NextResponse.json({ error: "Failed to start evaluator" }, { status: 500 })
  }
}
