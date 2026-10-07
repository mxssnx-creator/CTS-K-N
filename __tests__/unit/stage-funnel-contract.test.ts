import { readFileSync } from "node:fs"
import path from "node:path"
import {
  baseStageFunnel,
  checkPipelineFunnel,
  checkStageFunnel,
  stageFunnelViolationsFromStats,
} from "@/lib/stage-funnel-contract"
import { COORDINATOR_OWNED_STAGE_TYPES } from "@/lib/statistics-tracker"

/**
 * Processing / progressing / running count gate-validated Sets only. The
 * 2026-10-07 24 h run reported Base sets_progressing 327 with passed_sets 0:
 * every emitted Base Set was shown as processing. These tests pin the
 * contract, the runtime guard, the verifier rule and the writers.
 */
const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("stage funnel contract", () => {
  it("accepts a consistent Base funnel", () => {
    expect(checkStageFunnel({ stage: "base", emitted: 165, awaitingHistory: 120, rejected: 42, valid: 3, processing: 3, running: 1 })).toEqual([])
  })

  it("rejects processing or running above valid", () => {
    expect(checkStageFunnel({ stage: "base", emitted: 327, valid: 0, processing: 327 }).join(" ")).toContain("base.processing (327) > base.valid (0)")
    expect(checkStageFunnel({ stage: "base", emitted: 5, valid: 1, running: 2 }).join(" ")).toContain("base.running (2) > base.valid (1)")
  })

  it("requires awaiting + rejected + valid to add up to emitted", () => {
    expect(checkStageFunnel({ stage: "base", emitted: 10, awaitingHistory: 4, rejected: 4, valid: 1 })).toHaveLength(1)
  })

  it("rejects negative and non-numeric counts", () => {
    expect(checkStageFunnel({ stage: "real", valid: -1 }).join(" ")).toContain("negative")
    expect(checkStageFunnel({ stage: "real", valid: Number.NaN }).join(" ")).toContain("not a number")
  })

  it("requires Main's input to be Base's valid count", () => {
    expect(checkPipelineFunnel({ base: { emitted: 9, valid: 3 }, main: { input: 3 } })).toEqual([])
    expect(checkPipelineFunnel({ base: { emitted: 9, valid: 3 }, main: { input: 9 } }).join(" ")).toContain("main.input (9) != base.valid (3)")
  })

  it("computes Base processing and running over valid Sets only", () => {
    const sets = [
      { setKey: "a", entryCount: 4 },
      { setKey: "b", entryCount: 2 },
      { setKey: "c", entryCount: 0 },
      { setKey: "d", entryCount: 7 },
    ]
    const funnel = baseStageFunnel({
      emitted: 4,
      awaitingHistory: 1,
      rejected: 0,
      validSetKeys: new Set(["a", "b", "c"]),
      sets,
      openSetKeys: new Set(["a", "d"]),
    })
    // d has entries and an open position but is not valid: not counted.
    expect(funnel).toMatchObject({ valid: 3, processing: 2, running: 1 })
    expect(checkStageFunnel(funnel)).toEqual([])
  })
})

describe("verifier rule on the stats payload", () => {
  it("fails the 2026-10-07 payload: Base progressing 327, passed 0", () => {
    const violations = stageFunnelViolationsFromStats({
      strategyDetail: { base: { setsProgressing: 327, setsRunningNow: 0, passed: 0, evaluated: 327 } },
    })
    expect(violations.join(" ")).toContain("base.setsProgressing (327) > base.passed (0)")
  })

  it("passes a consistent payload and flags passed > evaluated on any stage", () => {
    expect(stageFunnelViolationsFromStats({
      strategyDetail: {
        base: { setsProgressing: 3, setsRunningNow: 1, passed: 3, evaluated: 165 },
        main: { passed: 2, evaluated: 3 },
      },
    })).toEqual([])
    expect(stageFunnelViolationsFromStats({ strategyDetail: { real: { passed: 5, evaluated: 4 } } }).join(" ")).toContain("real.passed (5) > real.evaluated (4)")
  })

  it("is wired into the coverage verifier", () => {
    const verifier = src("scripts/verify-runtime-coverage.mjs")
    expect(verifier).toContain("stageFunnelViolationsFromStats(stats)")
    expect(verifier).toContain('add("error", "stage-funnel", violation)')
  })
})

describe("writers and readers follow the contract", () => {
  const coordinator = src("lib/strategy-coordinator.ts")

  it("no processing/progressing/running field is computed from the emitted Base pool", () => {
    // Scan every line that writes a processing-type field and reject the
    // emitted pool (`baseSets.filter`, `baseSets.length`, `baseRunningNow`).
    const offenders = coordinator.split("\n").filter((line) =>
      /(sets_progressing|sets_running_now|sets_with_open_positions|:progressing`\]|:running`\]|\$\{symbol\}:base`\])/.test(line) &&
      /(baseSets\.filter|baseSets\.length|baseRunningNow)/.test(line))
    expect(offenders).toEqual([])
    // Base resets them; Main writes them from the valid funnel.
    expect(coordinator).toContain("sets_progressing:         String(baseFunnel.processing)")
    expect(coordinator).toContain("[`${symbol}:base`]:           String(baseFunnel.running)")
  })

  it("the coordinator runs the runtime guard on every pass", () => {
    expect(coordinator).toContain("this.guardStageFunnel(symbol, { base: baseFunnel, main: { input: mainBaseInputCount } })")
    expect(coordinator).toContain('"stage_funnel_invariant_violation"')
  })

  it("the tracking route never falls back to the emitted pool for progressing", () => {
    const tracking = src("lib/detailed-tracking.ts")
    expect(tracking).not.toContain("base.sets_progressing || base.created_sets")
    expect(tracking).toContain('setsProgressing: sumFreshRow(base, "progressing", "sets_progressing")')
    expect(tracking).toContain("setsRunningNow: rows.base.validOpen")
  })

  it("the flat Base/Main/Real stage keys have one writer", () => {
    expect([...COORDINATOR_OWNED_STAGE_TYPES].sort()).toEqual(["base", "main", "real"])
    expect(coordinator).toContain("client.set(`strategies:${this.connectionId}:main:passed`")
    expect(coordinator).toContain("client.set(`strategies:${this.connectionId}:real:passed`")
  })
})
