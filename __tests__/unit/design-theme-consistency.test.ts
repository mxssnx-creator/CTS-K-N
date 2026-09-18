import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

/** Every component/page source file. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue
      sources(full, out)
    } else if (entry.endsWith(".tsx")) out.push(full)
  }
  return out
}

const files = [
  ...sources(resolve(process.cwd(), "components")),
  ...sources(resolve(process.cwd(), "app")),
]

/**
 * A light-only SURFACE: a very light neutral background or near-black text
 * pinned without a dark counterpart, which renders a bright card inside a dark
 * shell or dark text on a dark surface.
 *
 * Deliberately excluded:
 *  - mid-tones (-400..-600): they read acceptably in both themes and carry
 *    status dots;
 *  - `bg-white`: legitimately used for a foreground dot ON a solid coloured
 *    badge (white on green-600), where a dark variant would be wrong.
 */
const LIGHT_ONLY = /\b(bg-(gray|slate|zinc|neutral|stone)-(50|100|200)|text-(black|(gray|slate|zinc|neutral|stone)-(800|900|950)))\b/
/**
 * Comments that DESCRIBE these classes are documentation, not usage, and a
 * per-line test cannot see that a line sits inside a multi-line JSX comment.
 * Comments are therefore blanked before scanning, preserving line numbers so
 * offenders still report an accurate location.
 */
function stripComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "")
}

describe("theme consistency", () => {
  test("no light-only surface ships without a dark counterpart", () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"))
      for (const [index, line] of source.split("\n").entries()) {
        if (!LIGHT_ONLY.test(line)) continue
        if (line.includes("dark:")) continue
        offenders.push(`${file.replace(process.cwd() + "/", "")}:${index + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("the neutral status surface uses theme tokens, not a pinned grey", () => {
    const card = readFileSync(resolve(process.cwd(), "components/settings/connection-card.tsx"), "utf8")
    expect(card).toContain('return "bg-muted border-border text-foreground"')
    expect(card).toContain('"bg-muted text-muted-foreground border-border"')
  })

  test("interactive hover states use accent tokens so they invert with the theme", () => {
    const panel = readFileSync(resolve(process.cwd(), "components/system/system-verification-panel.tsx"), "utf8")
    expect(panel).toContain("hover:bg-accent hover:text-accent-foreground")
    expect(panel).not.toContain("hover:bg-gray-100")
  })
})
