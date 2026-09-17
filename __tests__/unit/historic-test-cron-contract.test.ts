import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const route = readFileSync(resolve(process.cwd(), "app/api/cron/historic-test/route.ts"), "utf8")

describe("Historic Test trigger", () => {
  test("it is authorized like every other cron route", () => {
    expect(route).toContain("authorizeCronRequest(request)")
    expect(route).toContain("if (!auth.ok) return cronAuthorizationResponse(auth)")
    expect((route.match(/authorizeCronRequest\(request\)/g) || []).length).toBe(2) // GET and POST
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
