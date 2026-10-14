import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = process.cwd()
const read = (file: string) => readFileSync(resolve(root, file), "utf8")

function sourceFiles(dir: string): string[] {
  return (readdirSync(resolve(root, dir), { recursive: true }) as string[])
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .map((file) => join(dir, file))
}

describe("UI never calls API routes that do not exist", () => {
  test("the mounted portfolio detail page no longer requests the non-existent risk-limits route", () => {
    const page = read("app/portfolios/[id]/page.tsx")
    expect(existsSync(resolve(root, "app/api/portfolios/[id]/risk-limits/route.ts"))).toBe(false)
    expect(page).not.toContain("risk-limits")
    expect(page).not.toContain("RiskSettings")
  })

  // Components that call a missing route must stay unmounted until the route
  // exists. `app/presets/page-backup.tsx` is not a Next.js route file.
  const callers: Array<{ component: string; route: string }> = [
    { component: "components/settings/exchange-connection-dialog.tsx", route: "app/api/settings/strategy/route.ts" },
    { component: "components/settings/exchange-connection-settings-dialog.tsx", route: "app/api/settings/strategy/route.ts" },
    { component: "components/settings/database-actions.tsx", route: "app/api/install/run-migration/route.ts" },
    { component: "components/presets/configuration-set-manager.tsx", route: "app/api/preset-config-sets/[id]/route.ts" },
    { component: "components/presets/create-configuration-set-dialog.tsx", route: "app/api/preset-config-sets/route.ts" },
    { component: "components/presets/coordination-results.tsx", route: "app/api/preset-config-sets/route.ts" },
    { component: "components/presets/preset-coordination-list.tsx", route: "app/api/preset-types/[id]/results/route.ts" },
    { component: "components/dashboard/volatility-screener-card.tsx", route: "app/api/symbols/screen-volatility/route.ts" },
  ]
  // An importer that is itself one of these unmounted callers does not mount it.
  const unmountedCallers = new Set(callers.map(({ component }) => component))
  const mountableSources = [...sourceFiles("app"), ...sourceFiles("components")]
    .filter((file) => !file.endsWith("page-backup.tsx") && !unmountedCallers.has(file))

  test.each(callers)("$component is unmounted while $route is missing", ({ component, route }) => {
    if (existsSync(resolve(root, route))) return
    const moduleName = component.replace(/^components\//, "").replace(/\.tsx$/, "")
    const baseName = moduleName.split("/").pop()!
    const importers = mountableSources.filter((file) => {
      if (file === component) return false
      const source = read(file)
      return source.includes(`@/components/${moduleName}"`) || source.includes(`./${baseName}"`)
    })
    expect(importers).toEqual([])
  })
})
