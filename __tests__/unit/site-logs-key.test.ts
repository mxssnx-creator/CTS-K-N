import { readFileSync } from "node:fs"
import { resolve } from "node:path"
describe("site logs never collide with the SQL layer's site_logs set", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/monitoring/site/route.ts"), "utf8")
  const verifier = readFileSync(resolve(process.cwd(), "lib/db-verifier.ts"), "utf8")
  test("the SQL layer keeps a site_logs table (a Redis set)", () => {
    expect(verifier).toContain('"site_logs"')
  })
  test("the site-log history uses its own list key", () => {
    expect(route).toContain('const SITE_LOGS_KEY = "site_logs:history"')
    expect(route).not.toMatch(/const SITE_LOGS_KEY = "site_logs"\s*$/m)
  })
})
