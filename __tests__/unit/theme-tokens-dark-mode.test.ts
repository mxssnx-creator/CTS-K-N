import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// The app supports dark mode (tailwind darkMode: ["class"]). A component that
// hardcodes the light palette (slate/gray text on white) without any dark:
// variant renders invisible text on the dark theme. Surfaces and text roles
// must use the theme tokens (text-foreground, text-muted-foreground, bg-card,
// bg-muted, border-border) like the rest of the codebase.
const LIGHT_ONLY = /\b(text-(slate|gray|zinc|neutral)-(700|800|900)|bg-white|bg-(slate|gray|zinc|neutral)-50)\b/

describe("components are dark-mode safe", () => {
  test("no component hardcodes the light palette without a dark: variant", () => {
    const files = execSync('git ls-files "components/**/*.tsx" "app/**/*.tsx"', { cwd: process.cwd(), encoding: "utf8" })
      .split("\n").map((f) => f.trim()).filter(Boolean)
    const offenders = files.filter((file) => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8")
      return LIGHT_ONLY.test(source) && !source.includes("dark:")
    })
    expect(offenders).toEqual([])
  })

  test("the previously light-only dialogs now use theme tokens", () => {
    for (const file of [
      "components/dashboard/seed-system-dialog.tsx",
      "components/dashboard/connection-detailed-log-dialog.tsx",
      "components/dashboard/detailed-logging-dialog.tsx",
      "components/settings/system-settings.tsx",
      "components/settings/connection-log-dialog.tsx",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8")
      expect(source).not.toMatch(LIGHT_ONLY)
      expect(source).toMatch(/\b(text-foreground|text-muted-foreground|bg-card|bg-muted)\b/)
    }
  })
})
