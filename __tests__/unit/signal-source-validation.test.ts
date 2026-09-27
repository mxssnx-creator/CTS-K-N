const mockStrings = new Map<string, string>()
const mockLists = new Map<string, string[]>()
const mockSets = new Map<string, Set<string>>()

const mockClient: any = {
  get: jest.fn(async (key: string) => mockStrings.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, options?: { NX?: boolean }) => {
    if (options?.NX && mockStrings.has(key)) return null
    mockStrings.set(key, String(value))
    return "OK"
  }),
  del: jest.fn(async (...keys: string[]) => keys.reduce((n, key) => n + Number(mockStrings.delete(key)), 0)),
  expire: jest.fn(async () => 1),
  lpush: jest.fn(async (key: string, ...values: string[]) => {
    const list = mockLists.get(key) || []
    list.unshift(...values.reverse())
    mockLists.set(key, list)
    return list.length
  }),
  ltrim: jest.fn(async (key: string, start: number, stop: number) => {
    mockLists.set(key, (mockLists.get(key) || []).slice(start, stop + 1))
  }),
  lrange: jest.fn(async (key: string, start: number, stop: number) =>
    (mockLists.get(key) || []).slice(start, stop + 1)),
  sscan: jest.fn(async (key: string) => ["0", [...(mockSets.get(key) || [])]]),
  smembers: jest.fn(async (key: string) => [...(mockSets.get(key) || [])]),
}

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => {}),
  getRedisClient: jest.fn(() => mockClient),
}))

import {
  SIGNAL_ACTIVE_SOURCES_DEFAULT,
  SIGNAL_ACTIVE_SOURCES_MAX,
  SIGNAL_SOURCE_TACTIC_KEYS,
  SIGNAL_SOURCE_VALIDATION_SETTINGS_DEFAULT,
  buildSignalSourceRanking,
  compareSignalSourceMetrics,
  computeSignalSourceMetrics,
  dedupeCorrelatedSignalEvaluations,
  filterDispatchableSignalEvaluations,
  normalizeSignalSourceValidationSettings,
  rankSignalSources,
  validateSignalSourceMetrics,
  validatedConsensusSatisfied,
  type SignalSourceOutcome,
  type SignalSourceValidationSettings,
} from "@/lib/signal-source-validation"
import { snapshotDispatchView } from "@/lib/signal-source-validation-store"
import { normalizeSignalIndicationSettings, signalConsensusWithVetoes } from "@/lib/signal-indication"
import { replaySignalSourceOutcomes, runSignalSourceOptimization } from "@/lib/signal-source-optimizer"
import { SIGNAL_SOURCE_DEFINITIONS, getSignalSource } from "@/lib/signal-source-registry"

const HOUR = 3_600_000
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0)

function outcomes(sourceId: string, pnls: number[], stepMs = HOUR): SignalSourceOutcome[] {
  return pnls.map((netPct, index) => ({
    sourceId,
    symbol: "BTCUSDT",
    direction: "long",
    closedAt: T0 + index * stepMs,
    netPct,
    origin: "synthetic",
  }))
}

const settings = (patch: Partial<SignalSourceValidationSettings> = {}): SignalSourceValidationSettings => ({
  ...SIGNAL_SOURCE_VALIDATION_SETTINGS_DEFAULT,
  tactics: { ...SIGNAL_SOURCE_VALIDATION_SETTINGS_DEFAULT.tactics },
  ...patch,
})

describe("source metrics and validation", () => {
  test("computes after-cost PF, drawdown, loss streak and hourly success", () => {
    const metrics = computeSignalSourceMetrics("a", outcomes("a", [0.5, -0.2, -0.3, 0.4, 0.1]))
    expect(metrics.samples).toBe(5)
    expect(metrics.profitFactor).toBeCloseTo(1 / 0.5, 6)
    expect(metrics.maxDrawdownPct).toBeCloseTo(0.5, 6)
    expect(metrics.maxLossStreak).toBe(2)
    expect(metrics.hourlySuccessRate).toBeCloseTo(3 / 5, 6)
  })

  test("gate requires samples, PF > 1 after cost, drawdown and loss-streak limits", () => {
    const t = settings()
    const winning = Array.from({ length: 12 }, (_, i) => (i % 3 === 2 ? -0.1 : 0.2))
    expect(validateSignalSourceMetrics(computeSignalSourceMetrics("a", outcomes("a", winning.slice(0, 11))), t))
      .toEqual({ passed: false, reason: "insufficient_samples" })
    expect(validateSignalSourceMetrics(computeSignalSourceMetrics("a", outcomes("a", winning)), t).passed).toBe(true)
    const losing = Array.from({ length: 12 }, (_, i) => (i % 2 ? 0.1 : -0.12))
    expect(validateSignalSourceMetrics(computeSignalSourceMetrics("a", outcomes("a", losing)), t).reason).toBe("profit_factor")
    const deep = [...Array(6).fill(0.9), -0.8, -0.8, -0.8, -0.8, 0.9, 0.9]
    expect(validateSignalSourceMetrics(computeSignalSourceMetrics("a", outcomes("a", deep)), t).reason).toBe("drawdown")
    const streaky = [...Array(6).fill(0.5), ...Array(6).fill(-0.01)]
    expect(validateSignalSourceMetrics(computeSignalSourceMetrics("a", outcomes("a", streaky)), t).reason).toBe("loss_streak")
  })

  test("ranking is drawdown-first, then PF, and deterministic on ties", () => {
    const lowDdLowPf = computeSignalSourceMetrics("z-low-dd", outcomes("z-low-dd", [0.1, -0.05, 0.1, -0.05]))
    const highDdHighPf = computeSignalSourceMetrics("a-high-dd", outcomes("a-high-dd", [2, -0.5, 2, -0.5]))
    expect(rankSignalSources([highDdHighPf, lowDdLowPf]).map((m) => m.sourceId)).toEqual(["z-low-dd", "a-high-dd"])
    const twinA = computeSignalSourceMetrics("twin-a", outcomes("twin-a", [0.2, -0.1, 0.2]))
    const twinB = computeSignalSourceMetrics("twin-b", outcomes("twin-b", [0.2, -0.1, 0.2]))
    expect(rankSignalSources([twinB, twinA]).map((m) => m.sourceId)).toEqual(["twin-a", "twin-b"])
    expect(rankSignalSources([twinA, twinB]).map((m) => m.sourceId)).toEqual(["twin-a", "twin-b"])
    expect(compareSignalSourceMetrics(twinA, twinA)).toBe(0)
  })
})

describe("activation gating and capacity", () => {
  const good = Array.from({ length: 12 }, (_, i) => (i % 4 === 3 ? -0.1 : 0.15))

  test("unvalidated candidates never dispatch; established sources bootstrap unless strict", () => {
    const registry = [
      { id: "cand", lifecycle: "candidate" as const, enabled: true, priority: 3 },
      { id: "est", lifecycle: "established" as const, enabled: true, priority: 1 },
    ]
    const ranking = buildSignalSourceRanking({ registry, outcomes: [], settings: settings() })
    expect(ranking.find((e) => e.sourceId === "cand")?.status).toBe("candidate")
    expect(ranking.find((e) => e.sourceId === "est")?.status).toBe("bootstrap")
    const strict = buildSignalSourceRanking({ registry, outcomes: [], settings: settings({ strictActivation: true }) })
    expect(strict.every((e) => e.status === "candidate")).toBe(true)

    const lifecycleById = new Map([["cand", "candidate" as const], ["est", "established" as const]])
    const evaluations = [
      { sourceId: "cand", direction: "long" as const, atrPct: 0.1, stopLossPct: 0.3 },
      { sourceId: "est", direction: "long" as const, atrPct: 0.1, stopLossPct: 0.3 },
    ]
    // No snapshot at all: candidate still blocked.
    const noSnapshot = filterDispatchableSignalEvaluations({
      evaluations, snapshot: null, lifecycleById, settings: settings(),
      stopLossAtrMultiplier: 0.85, stopLossMaxPct: 1.5, now: T0,
    })
    expect(noSnapshot.allowed.map((e) => e.sourceId)).toEqual(["est"])
    expect(noSnapshot.vetoed).toEqual([{ sourceId: "cand", reason: "status_candidate" }])

    // Once the candidate validates it becomes active and may dispatch.
    const validated = buildSignalSourceRanking({ registry, outcomes: outcomes("cand", good), settings: settings() })
    expect(validated.find((e) => e.sourceId === "cand")?.status).toBe("active")
    const view = snapshotDispatchView({
      connectionId: "c", hourKey: "h", generatedAt: T0, trigger: "manual",
      capacity: 50, activeCount: 2, validatedCount: 1, entries: validated,
    })
    const afterValidation = filterDispatchableSignalEvaluations({
      evaluations, snapshot: view, lifecycleById, settings: settings(),
      stopLossAtrMultiplier: 0.85, stopLossMaxPct: 1.5, now: T0,
    })
    expect(afterValidation.allowed.map((e) => e.sourceId).sort()).toEqual(["cand", "est"])
  })

  test("established sources with enough failing evidence are rejected", () => {
    const ranking = buildSignalSourceRanking({
      registry: [{ id: "est", lifecycle: "established", enabled: true, priority: 1 }],
      outcomes: outcomes("est", Array(12).fill(-0.1)),
      settings: settings(),
    })
    expect(ranking[0].status).toBe("rejected")
  })

  test("capacity defaults to 50, bounds 1..200, and fills best-first", () => {
    expect(SIGNAL_ACTIVE_SOURCES_DEFAULT).toBe(50)
    expect(normalizeSignalSourceValidationSettings({}).maxActiveSources).toBe(50)
    expect(normalizeSignalSourceValidationSettings({ maxActiveSources: 500 }).maxActiveSources).toBe(SIGNAL_ACTIVE_SOURCES_MAX)
    expect(normalizeSignalSourceValidationSettings({ maxActiveSources: 0 }).maxActiveSources).toBe(1)
    expect(normalizeSignalSourceValidationSettings({ maxActiveSources: 200 }).maxActiveSources).toBe(200)
    expect(normalizeSignalIndicationSettings({ sourceValidation: { maxActiveSources: 999 } }).sourceValidation.maxActiveSources)
      .toBe(200)

    const registry = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`, lifecycle: "candidate" as const, enabled: true, priority: 3,
    }))
    // s0 has the deepest drawdown, s4 the shallowest.
    const all = registry.flatMap((source, i) =>
      outcomes(source.id, Array.from({ length: 12 }, (_, k) => (k === 5 ? -0.1 * (5 - i) : 0.3))))
    const ranking = buildSignalSourceRanking({ registry, outcomes: all, settings: settings({ maxActiveSources: 2 }) })
    expect(ranking.filter((e) => e.status === "active").map((e) => e.sourceId)).toEqual(["s4", "s3"])
    expect(ranking.filter((e) => e.status === "standby").map((e) => e.sourceId)).toEqual(["s2", "s1", "s0"])
  })

  test("settings can only tighten validation thresholds", () => {
    const loosened = normalizeSignalSourceValidationSettings({
      minSamples: 1, minProfitFactor: 0.5, maxDrawdownPct: 50, maxLossStreak: 99,
    })
    expect(loosened.minSamples).toBe(12)
    expect(loosened.minProfitFactor).toBe(1)
    expect(loosened.maxDrawdownPct).toBe(3)
    expect(loosened.maxLossStreak).toBe(5)
    const tightened = normalizeSignalSourceValidationSettings({ minSamples: 30, maxDrawdownPct: 1 })
    expect(tightened.minSamples).toBe(30)
    expect(tightened.maxDrawdownPct).toBe(1)
  })
})

describe("tactics: toggles and effects (veto-only)", () => {
  test("all tactics default on and can each be disabled", () => {
    const defaults = normalizeSignalSourceValidationSettings({})
    for (const key of SIGNAL_SOURCE_TACTIC_KEYS) {
      expect(defaults.tactics[key]).toBe(true)
      expect(normalizeSignalSourceValidationSettings({ tactics: { [key]: false } }).tactics[key]).toBe(false)
    }
  })

  const lifecycleById = new Map<string, "established" | "candidate">([["a", "established"]])
  const base = { sourceId: "a", direction: "long" as const, atrPct: 0.1, stopLossPct: 0.3 }

  test("volatility regime gate vetoes a clipped ATR stop only when enabled", () => {
    const hot = { ...base, atrPct: 2 }
    const run = (on: boolean) => filterDispatchableSignalEvaluations({
      evaluations: [hot], snapshot: null, lifecycleById,
      settings: settings({ tactics: { ...settings().tactics, volatilityRegimeGate: on } }),
      stopLossAtrMultiplier: 0.85, stopLossMaxPct: 1.5, now: T0,
    })
    expect(run(true).allowed).toHaveLength(0)
    expect(run(true).vetoed[0].reason).toBe("volatility_regime")
    expect(run(false).allowed).toHaveLength(1)
  })

  test("hour-of-day gate vetoes a source in its net-negative UTC hour", () => {
    // 4 losing outcomes all closing at 05:xx UTC, plus winners elsewhere.
    const history = [
      ...[0, 1, 2, 3].map((day) => ({ ...outcomes("a", [-0.1])[0], closedAt: T0 + day * 24 * HOUR + 5 * HOUR })),
      ...outcomes("a", Array(12).fill(0.2), 24 * HOUR).map((o) => ({ ...o, closedAt: o.closedAt + 10 * HOUR })),
    ]
    const ranking = buildSignalSourceRanking({
      registry: [{ id: "a", lifecycle: "established", enabled: true, priority: 1 }],
      outcomes: history,
      settings: settings(),
    })
    expect(ranking[0].negativeHoursUtc).toEqual([5])
    const view = snapshotDispatchView({
      connectionId: "c", hourKey: "h", generatedAt: T0, trigger: "manual",
      capacity: 50, activeCount: 1, validatedCount: 1, entries: ranking,
    })
    const at = (hour: number, on: boolean) => filterDispatchableSignalEvaluations({
      evaluations: [base], snapshot: view, lifecycleById,
      settings: settings({ tactics: { ...settings().tactics, hourOfDayGate: on } }),
      stopLossAtrMultiplier: 0.85, stopLossMaxPct: 1.5, now: T0 + hour * HOUR,
    }).allowed.length
    expect(at(5, true)).toBe(0)
    expect(at(6, true)).toBe(1)
    expect(at(5, false)).toBe(1)
  })

  test("drawdown quarantine sidelines a validated source with a fresh drawdown", () => {
    const pnls = [...Array(10).fill(0.4), -0.9, -0.9]
    const registry = [{ id: "a", lifecycle: "candidate" as const, enabled: true, priority: 3 }]
    const on = buildSignalSourceRanking({ registry, outcomes: outcomes("a", pnls), settings: settings() })
    expect(on[0].status).toBe("quarantined")
    const off = buildSignalSourceRanking({
      registry,
      outcomes: outcomes("a", pnls),
      settings: settings({ tactics: { ...settings().tactics, drawdownQuarantine: false } }),
    })
    expect(off[0].status).toBe("active")
  })

  test("correlation dedupe keeps one best-ranked member per venue family", () => {
    const evaluations = [
      { ...base, sourceId: "okx-swap" },
      { ...base, sourceId: "okx-spot" },
      { ...base, sourceId: "bingx-swap" },
    ]
    const ranks = new Map([["okx-spot", 1], ["okx-swap", 2], ["bingx-swap", 3]])
    expect(dedupeCorrelatedSignalEvaluations(evaluations, ranks).map((e) => e.sourceId)).toEqual(["okx-spot", "bingx-swap"])
  })

  test("validated consensus needs an active contributor once any source is validated", () => {
    const view = {
      statuses: new Map([["v", "active"], ["b", "bootstrap"]] as const),
      ranks: new Map(),
      negativeHoursUtc: new Map(),
    } as any
    expect(validatedConsensusSatisfied([{ sourceId: "b" }], view)).toBe(false)
    expect(validatedConsensusSatisfied([{ sourceId: "b" }, { sourceId: "v" }], view)).toBe(true)
    expect(validatedConsensusSatisfied([{ sourceId: "b" }], null)).toBe(true)
  })
})

describe("consensus vetoes never loosen the quorum", () => {
  const evaluation = (sourceId: string, direction: "long" | "short") => ({
    sourceId, sourceName: sourceId, direction, confidence: 0.9, strength: 0.8, stopLossPct: 0.3,
    takeProfitPct: 0.6, rewardRisk: 2, atrPct: 0.2, lastPrice: 100, candleCount: 60, weight: 1,
  })
  const signalSettings = normalizeSignalIndicationSettings({ minimumSourceSignals: 3 })

  test("gated consensus requires the baseline to agree", () => {
    const gated = [evaluation("a", "long"), evaluation("b", "long"), evaluation("c", "long")]
    const baselineShort = [...gated, evaluation("d", "short"), evaluation("e", "short"), evaluation("f", "short"), evaluation("g", "short")]
    expect(signalConsensusWithVetoes({
      baseline: gated, gated, settings: signalSettings, requiredSourceSignals: 3, dispatchView: null,
    })?.direction).toBe("long")
    expect(signalConsensusWithVetoes({
      baseline: baselineShort, gated, settings: signalSettings, requiredSourceSignals: 3, dispatchView: null,
    })).toBeNull()
  })

  test("correlation dedupe can veto a quorum made of one venue's duplicates", () => {
    const gated = [evaluation("okx-swap", "long"), evaluation("okx-spot", "long"), evaluation("bingx-swap", "long")]
    const on = signalConsensusWithVetoes({
      baseline: gated, gated, settings: signalSettings, requiredSourceSignals: 3, dispatchView: null,
    })
    expect(on).toBeNull()
    const off = signalConsensusWithVetoes({
      baseline: gated,
      gated,
      settings: normalizeSignalIndicationSettings({
        minimumSourceSignals: 3,
        sourceValidation: { tactics: { correlationDedupe: false } },
      }),
      requiredSourceSignals: 3,
      dispatchView: null,
    })
    expect(off?.direction).toBe("long")
  })
})

describe("replay and hourly optimization job", () => {
  beforeEach(() => {
    mockStrings.clear()
    mockLists.clear()
    mockSets.clear()
  })

  test("replay deducts cost and books ambiguous bars as stops", () => {
    const source = getSignalSource("okx-spot")!
    const candles = Array.from({ length: 120 }, (_, i) => {
      const open = 100 + i * 0.05
      return { timestamp: T0 + i * 60_000, open, high: open + 0.12, low: open - 0.04, close: open + 0.04, volume: 1000 }
    })
    const replayed = replaySignalSourceOutcomes({
      source, symbol: "BTCUSDT", candles, positionCostPct: 0.1,
      settings: normalizeSignalIndicationSettings({}),
    })
    expect(replayed.length).toBeGreaterThan(0)
    for (const outcome of replayed) {
      expect(outcome.origin).toBe("replay")
      expect(outcome.sourceId).toBe("okx-spot")
    }
    // Consecutive trades never overlap.
    for (let i = 1; i < replayed.length; i++) expect(replayed[i].closedAt).toBeGreaterThan(replayed[i - 1].closedAt)
  })

  test("hourly job runs once per UTC hour, is idempotent and writes an audit record", async () => {
    const now = T0 + 30 * 60_000
    const good = outcomes("okx-spot", Array.from({ length: 12 }, (_, i) => (i % 4 === 3 ? -0.1 : 0.15)))
    const first = await runSignalSourceOptimization({ connectionId: "conn-x", now, settings: {}, outcomes: good })
    expect(first.ran).toBe(true)
    expect(first.snapshot?.entries.find((e) => e.sourceId === "okx-spot")?.status).toBe("active")
    expect(first.snapshot?.entries.find((e) => e.sourceId === "kucoin-spot")?.status).toBe("candidate")
    expect(first.snapshot?.entries).toHaveLength(SIGNAL_SOURCE_DEFINITIONS.length)
    expect(first.audit?.changes.length).toBe(SIGNAL_SOURCE_DEFINITIONS.length)

    const second = await runSignalSourceOptimization({ connectionId: "conn-x", now: now + 10 * 60_000, settings: {}, outcomes: good })
    expect(second).toEqual({ ran: false, skipped: "already_ran_this_hour" })
    expect(mockLists.get("signal:source_validation:conn-x:audit")).toHaveLength(1)

    const nextHour = await runSignalSourceOptimization({ connectionId: "conn-x", now: now + HOUR, settings: {}, outcomes: good })
    expect(nextHour.ran).toBe(true)
    // Same evidence => identical ranking => no changes recorded.
    expect(nextHour.audit?.changes).toEqual([])
    expect(mockLists.get("signal:source_validation:conn-x:audit")).toHaveLength(2)
  })
})
