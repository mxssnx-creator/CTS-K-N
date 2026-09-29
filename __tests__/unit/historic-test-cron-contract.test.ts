import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const route = readFileSync(resolve(process.cwd(), "app/api/cron/historic-test/route.ts"), "utf8")

describe("Historic Test trigger", () => {
  test("it is authorized like every other cron route", () => {
    expect(route).toContain("authorizeCronRequest(request)")
    expect(route).toContain("if (!auth.ok) return cronAuthorizationResponse(auth)")
    // GET and POST are the same handler now (the time box wraps it), so the one check covers both:
    // it runs inside `handle`, before any work, and both methods go through it.
    expect((route.match(/authorizeCronRequest\(request\)/g) || []).length).toBe(1)
    expect(route).toContain('export async function GET(request: Request) {\n  return runCronTimeBoxed("historic-test", request, () => handle(request))')
    expect(route).toContain("export const POST = GET")
    const handle = route.slice(route.indexOf("async function handle(request: Request)"))
    expect(handle.indexOf("authorizeCronRequest(request)")).toBeGreaterThan(-1)
    expect(handle.indexOf("authorizeCronRequest(request)")).toBeLessThan(handle.indexOf("await sweep()"))
  })

  test("it honours the isolation rule: only connection-relevant lanes are validated", () => {
    const gate = route.indexOf("if (!isConnectionAssignedToMain(connection)) {")
    const run = route.indexOf("maybeRunHistoricTest(connectionId,")
    expect(gate).toBeGreaterThan(0)
    expect(run).toBeGreaterThan(gate)
    expect(route).toContain("summary.connectionsNotRelevant++")
  })

  test("one failing connection never costs the sweep and is reported", () => {
    expect(route).toContain("summary.errors++")
    const catchBlock = route.slice(route.indexOf("} catch (error) {"))
    expect(catchBlock).toContain("summary.results.push({ connectionId, ran: false, skipped: null })")
    expect(catchBlock).not.toContain("throw")
  })

  test("the summary separates ran, skipped reasons and validated combinations", () => {
    expect(route).toContain("skipped: { disabled: 0, not_due: 0, no_symbols: 0 }")
    expect(route).toContain("summary.validatedCombinations += outcome.result.validated.length")
    expect(route).toContain("summary.connectionsRan++")
  })
})
