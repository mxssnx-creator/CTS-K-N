import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("run-with-env lifecycle", () => {
  const source = readFileSync(join(process.cwd(), "scripts/run-with-env.mjs"), "utf8")

  test("treats only a matching forwarded shutdown signal as clean", () => {
    expect(source).toContain("export function isExpectedForwardedTermination")
    expect(source).toContain('signal === "SIGTERM" || signal === "SIGINT"')
    expect(source).toContain("signal === forwardedSignal")
    expect(source).toContain("if (isExpectedForwardedTermination(signal, forwardedSignal))")
    expect(source).toContain("else if (signal) reject")
  })
})
