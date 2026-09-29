import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const script = resolve(process.cwd(), "scripts/monitor-live-health.mjs")
/** Runs the pure evaluation in a real node process, the way the timer loads the file. */
function evaluate(snapshot: any, previous: any = null): { level: string; checks: any[]; state: any } {
  const code = `import * as m from ${JSON.stringify("file://" + script)}; console.log(JSON.stringify(m.evaluateHealth(${JSON.stringify(snapshot)}, ${JSON.stringify(previous)})))`
  return JSON.parse(execFileSync("node", ["--input-type=module", "-e", code], { encoding: "utf8" }).trim().split("\n").pop() as string)
}

const AT = "2026-09-29T10:00:00.000Z"
const healthy = () => ({
  at: AT, windowMin: 20,
  service: { active: true },
  engines: { overall: "healthy", byConn: { "bingx-x01": "running", "bingx-x02": "running" } },
  connections: { "bingx-x01": { live: "1", assigned: "1", active: "1", dashboard: "1", liveVolumeFactor: "10", volumeFactorLive: "10", positionMode: "hedge" } },
  expectedLive: ["bingx-x01"],
  holds: { "bingx-x01": { count: 0, longHolds: 0 } }, slotHalts: { "bingx-x01": 0 }, connHaltTtl: { "bingx-x01": -2 },
  funnel: { "bingx-x01": { baseCount: 18, mainEvaluated: 40, liveEvaluated: 90 } },
  results: { "bingx-x01": { lastClosedAgoMin: 30, window6h: { closed: 12, settled: 12, pf: 1.4, reasons: { stop_loss: 4, take_profit: 8 } }, window24h: { closed: 40, settled: 40, pf: 1.3, reasons: {} } } },
  audit: { "bingx-x01": { blockedVolumeResets: 0 } },
  entries: { attempts: 6, success: 5, failed: 1, errors: {}, blocked: {} },
  ticks: { count: 20, over30s: 0, maxMs: 4000 },
  resources: { rssMb: 1700, load1: 1.1, diskPct: 40, redisMb: 700 },
  collectorFailures: [],
})
const ids = (r: { checks: any[] }, level?: string) => r.checks.filter((c) => (level ? c.level === level : c.level !== "OK")).map((c) => c.id)

describe("the live health verdict", () => {
  test("a healthy system is OK and reports no finding", () => {
    const r = evaluate(healthy())
    expect(r.level).toBe("OK")
    expect(ids(r)).toEqual([])
  })
  test("an inactive service and a missing engine are critical", () => {
    const s = healthy(); s.service.active = false; s.engines.byConn["bingx-x01"] = "stopped"
    const r = evaluate(s)
    expect(r.level).toBe("CRIT")
    expect(ids(r, "CRIT")).toEqual(expect.arrayContaining(["service", "engine_bingx-x01"]))
  })
  test("an unreachable health endpoint is critical, not silently fine", () => {
    const s: any = healthy(); s.engines = null
    expect(ids(evaluate(s), "CRIT")).toContain("engines")
  })
  test("a 109400 order rejection is critical: the positionSide failure of 2026-09-29", () => {
    const s = healthy(); s.entries = { attempts: 6, success: 0, failed: 6, errors: { "109400": 6 }, blocked: {} }
    const r = evaluate(s)
    expect(ids(r, "CRIT")).toContain("entries_positionside")
  })
  test("attempts without one success warn; no attempts at all do not", () => {
    const failing = healthy(); failing.entries = { attempts: 4, success: 0, failed: 4, errors: { "101204": 4 }, blocked: {} }
    expect(ids(evaluate(failing), "WARN")).toContain("entries_failed")
    const quiet = healthy(); quiet.entries = { attempts: 0, success: 0, failed: 0, errors: {}, blocked: {} }
    expect(ids(evaluate(quiet))).toEqual([])
  })
  test("many entries blocked by the rollback cooldown warn", () => {
    const s = healthy(); s.entries.blocked = { post_rollback_cooldown: 148 }
    expect(ids(evaluate(s), "WARN")).toContain("entries_blocked")
  })
  test("long holds, slot halts and a connection halt", () => {
    const s = healthy(); s.holds["bingx-x01"] = { count: 11, longHolds: 11 }; s.slotHalts["bingx-x01"] = 25; s.connHaltTtl["bingx-x01"] = 800
    const r = evaluate(s)
    expect(ids(r, "WARN")).toContain("holds_bingx-x01")
    expect(ids(r, "CRIT")).toEqual(expect.arrayContaining(["slot_halts_bingx-x01", "conn_halt_bingx-x01"]))
    s.slotHalts["bingx-x01"] = 7
    expect(ids(evaluate(s), "WARN")).toContain("slot_halts_bingx-x01")
  })
  test("holds and a mirror mismatch on a connection that is not live are only noted", () => {
    const s = healthy()
    ;(s.connections as any)["bingx-x02"] = { live: "0", assigned: "1", active: "1", dashboard: "1", liveVolumeFactor: "10", volumeFactorLive: "1", positionMode: "hedge" }
    ;(s.holds as any)["bingx-x02"] = { count: 2, longHolds: 2 }
    const r = evaluate(s)
    expect(r.level).toBe("INFO")
    expect(ids(r, "INFO")).toEqual(expect.arrayContaining(["volume_mirror_bingx-x02", "holds_bingx-x02"]))
    expect(ids(r, "WARN")).toEqual([])
  })
  test("the volume factor falling to the 0.1 minimum between runs is critical (the reset of 07:44)", () => {
    const before = { snapshot: healthy(), state: {} }
    const s = healthy(); s.connections["bingx-x01"].liveVolumeFactor = "0.1"
    const r = evaluate(s, before)
    expect(ids(r, "CRIT")).toContain("volume_bingx-x01")
    expect(ids(r, "WARN")).toContain("volume_mirror_bingx-x01") // 0.1 against volume_factor_live 10
  })
  test("a switch flipping between runs warns, and a one-way live connection warns", () => {
    const before = { snapshot: healthy(), state: {} }
    const s = healthy(); s.connections["bingx-x01"].assigned = "0"; s.connections["bingx-x01"].positionMode = "one_way"
    const r = evaluate(s, before)
    expect(ids(r, "WARN")).toEqual(expect.arrayContaining(["flag_bingx-x01_assigned", "position_mode_bingx-x01"]))
  })
  test("a blocked implicit volume reset is reported", () => {
    const s = healthy(); s.audit["bingx-x01"].blockedVolumeResets = 2
    expect(ids(evaluate(s), "WARN")).toContain("audit_volume_bingx-x01")
  })
  test("the funnel must stay starved for three runs before it warns", () => {
    const starved = () => { const s = healthy(); s.funnel["bingx-x01"].mainEvaluated = 0; return s }
    let previous: any = null
    const levels: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = evaluate(starved(), previous)
      levels.push(ids(r).includes("funnel_bingx-x01") ? "WARN" : "ok")
      previous = { snapshot: starved(), state: r.state }
    }
    expect(levels).toEqual(["ok", "ok", "WARN"])
    const recovered = evaluate(healthy(), previous)
    expect(recovered.state.funnelZeroRuns["bingx-x01"]).toBe(0)
  })
  test("no trade for 6 h warns, for 12 h is critical, and a connection that is not live is ignored", () => {
    const s = healthy(); s.results["bingx-x01"].lastClosedAgoMin = 400
    expect(ids(evaluate(s), "WARN")).toContain("no_trades_bingx-x01")
    s.results["bingx-x01"].lastClosedAgoMin = 800
    expect(ids(evaluate(s), "CRIT")).toContain("no_trades_bingx-x01")
    s.expectedLive = []
    expect(ids(evaluate(s))).not.toContain("no_trades_bingx-x01")
  })
  test("profit factor needs enough samples before it counts", () => {
    const s = healthy(); s.results["bingx-x01"].window6h = { closed: 5, settled: 5, pf: 0.2, reasons: {} }
    expect(ids(evaluate(s))).toEqual([])
    s.results["bingx-x01"].window6h = { closed: 20, settled: 20, pf: 0.6, reasons: {} }
    expect(ids(evaluate(s), "WARN")).toContain("pf6h_bingx-x01")
    s.results["bingx-x01"].window24h = { closed: 60, settled: 60, pf: 0.46, reasons: {} }
    expect(ids(evaluate(s), "CRIT")).toContain("pf24h_bingx-x01")
  })
  test("slow scheduler ticks, and memory including growth between runs", () => {
    const s = healthy(); s.ticks = { count: 20, over30s: 3, maxMs: 55000 }
    expect(ids(evaluate(s), "WARN")).toContain("ticks_slow")
    const big = healthy(); big.resources.rssMb = 2700
    expect(ids(evaluate(big), "WARN")).toContain("rss")
    big.resources.rssMb = 3600
    expect(ids(evaluate(big), "CRIT")).toContain("rss")
    const before = { snapshot: { ...healthy(), at: "2026-09-29T09:45:00.000Z" }, state: {} }
    const grown = healthy(); grown.resources.rssMb = 2200
    expect(ids(evaluate(grown, before), "WARN")).toContain("rss_growth")
  })
  test("a collector that failed is itself a finding", () => {
    const s = healthy(); s.collectorFailures = ["results"]
    expect(ids(evaluate(s), "WARN")).toContain("collector_results")
  })
  test("the installer keeps the monitor outside /opt/cts-kn and makes it an idle, bounded oneshot", () => {
    const sh = readFileSync(resolve(process.cwd(), "scripts/install-monitor.sh"), "utf8")
    expect(sh).toContain('TARGET_DIR="${CTS_MONITOR_DIR:-/opt/cts-monitor}"')
    expect(sh).toContain("Type=oneshot")
    expect(sh).toContain("OnUnitActiveSec=15min")
    expect(sh).toContain("MemoryMax=300M")
  })
  test("the monitor writes only its own Redis keys", () => {
    const src = readFileSync(script, "utf8")
    const writes = [...src.matchAll(/redis\(\["(set|lpush|ltrim|del|hset|expire)"/g)].map((m) => m[0])
    expect(writes.length).toBeGreaterThan(0)
    for (const w of src.matchAll(/redis\(\["(set|lpush|ltrim|del|hset|expire)",\s*([A-Z_a-z:"-]+)/g)) expect(w[2]).toMatch(/LATEST_KEY|HISTORY_KEY/)
  })
})
