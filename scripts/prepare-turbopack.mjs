import { access, copyFile } from "node:fs/promises"
import { resolve } from "node:path"

const jsonPath = resolve(
  import.meta.dirname,
  "../node_modules/next/dist/lib/server-external-packages.json",
)
const jsoncPath = resolve(
  import.meta.dirname,
  "../node_modules/next/dist/lib/server-external-packages.jsonc",
)

async function main() {
  try {
    await access(jsonPath)
    await copyFile(jsonPath, jsoncPath)
  } catch (err) {
    // Ignore if files don't exist; Turbopack may not need this in all setups
  }
}

main().catch(() => {})