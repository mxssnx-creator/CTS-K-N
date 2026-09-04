import { execFileSync } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"

describe("production deploy X02 owner verification", () => {
  it("distinguishes a healthy owner, an intentional operator stop, and missing runtime proof", () => {
    const moduleUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "production-deploy-init.mjs"),
    ).href
    const program = `
      import { classifyProdVstMainEngineState } from ${JSON.stringify(moduleUrl)}

      const base = {
        success: true,
        enabled: { flag: true },
        modes: { mainTrade: { effective: true } },
      }
      const states = [
        {
          ...base,
          engineRunning: true,
          runtimeEvidence: {
            reason: "fresh-heartbeat",
            heartbeatFresh: true,
            heartbeatAt: 123456,
            operatorStopped: false,
            globalIntent: "running",
          },
        },
        {
          ...base,
          engineRunning: false,
          runtimeEvidence: {
            reason: "operator-stopped",
            heartbeatFresh: false,
            operatorStopped: true,
            globalIntent: "paused",
          },
        },
        {
          ...base,
          engineRunning: false,
          runtimeEvidence: {
            reason: "no-runtime-proof",
            heartbeatFresh: false,
            operatorStopped: false,
            globalIntent: "running",
          },
        },
      ]
      process.stdout.write(JSON.stringify(states.map(classifyProdVstMainEngineState)))
    `

    const result = JSON.parse(execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      program,
    ], { encoding: "utf8" }))

    expect(result).toEqual([
      { kind: "running", heartbeatAt: 123456 },
      { kind: "operator-stopped", globalIntent: "paused" },
      { kind: "waiting" },
    ])
  })
})
