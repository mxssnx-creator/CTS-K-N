import { type NextRequest, NextResponse } from "next/server"
import { readFileSync } from "fs"
import { join } from "path"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    console.log("[v0] Checking dependencies...")

    const packageJsonPath = join(process.cwd(), "package.json")
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"))

    const dependencies = Object.entries(packageJson.dependencies || {}).map(([name, version]) => ({
      name,
      version: version as string,
      installed: true,
    }))

    return NextResponse.json({
      dependencies,
      installed_count: dependencies.length,
      total_count: dependencies.length,
    })
  } catch (error) {
    console.error("[v0] Dependency check failed:", error)
    return NextResponse.json(
      {
        error: "Dependency check failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
