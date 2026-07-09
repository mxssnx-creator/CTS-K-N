import fs from "fs"
import path from "path"

const ROOT = path.resolve(__dirname, "../..")
const FILES = [
  "components/dashboard/engine-progression-test-dialog.tsx",
  "components/dashboard/quickstart-full-system-test-dialog.tsx",
  "components/dashboard/quickstart-test-procedure-dialog.tsx",
  "app/api/testing/engine/[step]/route.ts",
  "app/api/testing/connection/[test]/route.ts",
]

describe("normal success-path synchronization avoids fixed sleeps", () => {
  test.each(FILES)("%s has no artificial sleep synchronization", (relativePath) => {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8")

    expect(source).not.toMatch(/PROGRESSION_POLL_INTERVAL_MS|PREHISTORIC_POLL_INTERVAL_MS|OBSERVATION_POLL_INTERVAL_MS/)
    expect(source).not.toMatch(/new\s+Promise\s*\([^)]*=>\s*setTimeout\s*\(/s)
    expect(source).not.toMatch(/await\s+[^\n;]*setTimeout\s*\(/s)
  })
})
