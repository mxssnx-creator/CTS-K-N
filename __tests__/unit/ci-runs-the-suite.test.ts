import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/dev-preview-smoke.yml"), "utf8")

describe("CI runs the test suite before a merge can land", () => {
  test("the unit and integration suites are executed", () => {
    expect(workflow).toContain("Run unit and integration tests")
    expect(workflow).toContain('--testPathPatterns="__tests__/(unit|integration)"')
    expect(workflow).toContain("--ci")
  })

  test("Redis is available, because some integration suites need it", () => {
    expect(workflow).toContain("Start Redis for integration suites")
    expect(workflow).toContain("redis-cli -p 6399 ping")
  })

  test("the tests run BEFORE the dev-preview verifier, so a failure stops early", () => {
    expect(workflow.indexOf("Run unit and integration tests"))
      .toBeLessThan(workflow.indexOf("Run dev-preview smoke verifier"))
  })

  test("the reason is recorded, so the step is not removed as redundant later", () => {
    expect(workflow).toContain("landed on main red")
    expect(workflow).toContain("turning a test failure into a failed production")
  })
})
