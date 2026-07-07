import { NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getConnection, updateConnection } from "@/lib/redis-db"


export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get("file") as File

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    const content = await file.text()
    const lines = content.split("\n")

    await initRedis()
    const client = getRedisClient()

    let imported = 0
    let skipped = 0
    let errors = 0
    const errorsList: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#")) {
        skipped++
        continue
      }

      try {
        const match = trimmed.match(/^([^=]+)\s*=\s*(.+)$/)
        if (!match) {
          skipped++
          continue
        }

        const actualKey = match[1].trim()
        const actualValue = match[2].trim()

        if (!actualKey || !actualValue) {
          skipped++
          continue
        }

        // Check if this is a connection field (format: connection-id:field-name)
        if (actualKey.includes(":")) {
          const colonIndex = actualKey.indexOf(":")
          const connId = actualKey.substring(0, colonIndex)
          const fieldName = actualKey.substring(colonIndex + 1)
          const connection = await getConnection(connId)

          if (connection) {
            let parsedValue: any = actualValue
            try {
              if (actualValue.startsWith("{") || actualValue.startsWith("[")) {
                parsedValue = JSON.parse(actualValue)
              }
            } catch {
              parsedValue = actualValue
            }

            const updated = {
              ...connection,
              [fieldName]: parsedValue,
            }
            await updateConnection(connId, updated)
            imported++
          } else {
            skipped++
          }
        } else {
          // Regular setting - store in Redis
          let parsedValue: any = actualValue
          try {
            if (actualValue.startsWith("{") || actualValue.startsWith("[")) {
              parsedValue = JSON.parse(actualValue)
            }
          } catch {
            parsedValue = actualValue
          }

          await client.set(`settings:${actualKey}`, typeof parsedValue === "string" ? parsedValue : JSON.stringify(parsedValue), { EX: 2592000 })
          imported++
        }
      } catch (error) {
        errors++
        errorsList.push(`Line: ${trimmed} - ${error instanceof Error ? error.message : "Unknown error"}`)
      }
    }

    console.log(`[v0] Import complete: ${imported} imported, ${skipped} skipped, ${errors} errors`)

    return NextResponse.json({
      success: true,
      imported,
      skipped,
      errors,
      errorsList,
      message: `Import complete: ${imported} items imported, ${skipped} skipped, ${errors} errors`,
    })
  } catch (error) {
    console.error("[v0] Failed to import settings:", error)
    return NextResponse.json(
      { error: "Failed to import settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
