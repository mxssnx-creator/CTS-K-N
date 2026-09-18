import { readdirSync, existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const APP = resolve(process.cwd(), "app")
const sidebar = readFileSync(resolve(process.cwd(), "components/app-sidebar.tsx"), "utf8")
const routePresentation = readFileSync(resolve(process.cwd(), "lib/route-presentation.ts"), "utf8")

/** Every route that has a page.tsx. */
function routes(dir = APP, prefix = ""): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith("_") || entry.name === "api") continue
    const route = `${prefix}/${entry.name}`
    if (existsSync(join(dir, entry.name, "page.tsx"))) out.push(route)
    out.push(...routes(join(dir, entry.name), route))
  }
  return out
}

const allRoutes = routes()
const navHrefs = new Set(
  [...sidebar.matchAll(/href: "(\/[a-z0-9/_-]*)"/g)].map((m) => m[1]),
)

describe("navigation and pages stay consistent", () => {
  test("no throwaway scaffolding page ships", () => {
    for (const dead of ["/minimal", "/minimal-test", "/simple", "/test", "/test-layout", "/test-simple"]) {
      expect(allRoutes).not.toContain(dead)
      expect(routePresentation).not.toContain(`"${dead}":`)
    }
    // The real diagnostics pages stay.
    expect(allRoutes).toEqual(expect.arrayContaining(["/testing/connection", "/testing/orders", "/testing/engine"]))
  })

  test("the dashboard is not duplicated under a second route", () => {
    expect(allRoutes).not.toContain("/main")
    expect(existsSync(join(APP, "page.tsx"))).toBe(true)
  })

  test("every sidebar link points at a page that exists", () => {
    for (const href of navHrefs) {
      if (href === "/") continue
      expect(allRoutes).toContain(href)
    }
  })

  test("pages a user is meant to reach are reachable from the sidebar", () => {
    // Auth, admin and dynamic detail routes are reached contextually, and
    // settings/statistics sub-pages from their parent page.
    const contextual = /^\/(login|register|admin\/|portfolios\/\[|settings\/indications\/|statistics\/indications\/|statistics\/direct-trade|settings\/connections|additional$|health$)/
    const orphans = allRoutes.filter((route) => !navHrefs.has(route) && !contextual.test(route))
    expect(orphans).toEqual([])
  })
})
