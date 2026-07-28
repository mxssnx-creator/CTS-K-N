const mockStrings = new Map<string, string>()
const mockHashes = new Map<string, Record<string, string>>()
const mockSets = new Map<string, Set<string>>()
const mockLists = new Map<string, string[]>()

function listRange(values: string[], start: number, stop: number): string[] {
  const normalizedStart = start < 0 ? Math.max(0, values.length + start) : start
  const normalizedStop = stop < 0 ? values.length + stop : Math.min(stop, values.length - 1)
  return normalizedStop < normalizedStart ? [] : values.slice(normalizedStart, normalizedStop + 1)
}

const mockClient: any = {
  get: jest.fn(async (key: string) => mockStrings.get(key) ?? null),
  set: jest.fn(async (key: string, value: string, options?: { NX?: boolean }) => {
    if (options?.NX && mockStrings.has(key)) return null
    mockStrings.set(key, String(value))
    return "OK"
  }),
  incr: jest.fn(async (key: string) => {
    const next = (Number(mockStrings.get(key)) || 0) + 1
    mockStrings.set(key, String(next))
    return next
  }),
  expire: jest.fn(async () => 1),
  del: jest.fn(async (...keys: string[]) => {
    let removed = 0
    for (const key of keys) {
      removed += Number(mockStrings.delete(key))
      removed += Number(mockHashes.delete(key))
      removed += Number(mockSets.delete(key))
      removed += Number(mockLists.delete(key))
    }
    return removed
  }),
  hgetall: jest.fn(async (key: string) => ({ ...(mockHashes.get(key) || {}) })),
  hget: jest.fn(async (key: string, field: string) => mockHashes.get(key)?.[field] ?? null),
  hset: jest.fn(async (key: string, fieldOrValues: string | Record<string, unknown>, value?: unknown) => {
    const hash = mockHashes.get(key) || {}
    if (typeof fieldOrValues === "string") hash[fieldOrValues] = String(value ?? "")
    else for (const [field, entry] of Object.entries(fieldOrValues)) hash[field] = String(entry ?? "")
    mockHashes.set(key, hash)
    return 1
  }),
  hdel: jest.fn(async (key: string, ...fields: string[]) => {
    const hash = mockHashes.get(key) || {}
    let removed = 0
    for (const field of fields) removed += Number(delete hash[field])
    return removed
  }),
  hincrby: jest.fn(async (key: string, field: string, amount: number) => {
    const hash = mockHashes.get(key) || {}
    hash[field] = String((Number(hash[field]) || 0) + amount)
    mockHashes.set(key, hash)
    return Number(hash[field])
  }),
  sadd: jest.fn(async (key: string, ...members: string[]) => {
    const set = mockSets.get(key) || new Set<string>()
    let inserted = 0
    for (const member of members) {
      if (!set.has(member)) inserted++
      set.add(member)
    }
    mockSets.set(key, set)
    return inserted
  }),
  smembers: jest.fn(async (key: string) => [...(mockSets.get(key) || [])]),
  lpush: jest.fn(async (key: string, ...values: string[]) => {
    const list = mockLists.get(key) || []
    list.unshift(...values)
    mockLists.set(key, list)
    return list.length
  }),
  rpush: jest.fn(async (key: string, ...values: string[]) => {
    const list = mockLists.get(key) || []
    list.push(...values)
    mockLists.set(key, list)
    return list.length
  }),
  ltrim: jest.fn(async (key: string, start: number, stop: number) => {
    mockLists.set(key, listRange(mockLists.get(key) || [], start, stop))
  }),
  lrange: jest.fn(async (key: string, start: number, stop: number) =>
    listRange(mockLists.get(key) || [], start, stop)),
}

mockClient.multi = jest.fn(() => {
  const operations: Array<() => Promise<unknown>> = []
  const pipeline: any = {}
  for (const method of [
    "set", "expire", "hgetall", "hset", "hdel", "hincrby", "sadd", "lpush", "rpush", "ltrim",
  ]) {
    pipeline[method] = (...args: unknown[]) => {
      operations.push(() => mockClient[method](...args))
      return pipeline
    }
  }
  pipeline.exec = async () => Promise.all(operations.map((operation) => operation()))
  return pipeline
})

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => mockClient),
}))

import {
  __signalIndicationTestUtils,
  getSignalConfigurationPerformanceBatch,
  getSignalPerformanceDecision,
  getSignalSourceLanePerformanceDecision,
  mergeSignalRisks,
  normalizeSignalIndicationSettings,
  processSignalIndications,
  recordSignalPerformanceOutcome,
  signalConfigurationExecutionAllowed,
  signalSourceLaneManuallyDisabled,
} from "@/lib/signal-indication"
import { initRedis } from "@/lib/redis-db"
import { SIGNAL_SOURCE_DEFINITIONS } from "@/lib/signal-source-registry"

function recordSyntheticSignalOutcome(
  input: Parameters<typeof recordSignalPerformanceOutcome>[0],
) {
  return recordSignalPerformanceOutcome({
    ...input,
    // Test PnL values are synthetic market-move percentages. Preserve their
    // old numeric assertions while exercising the production cost-relative
    // outcome path explicitly.
    pnlPct: input.pnlPct ?? input.pnl,
    positionCostPct: input.positionCostPct ?? 0.1,
  })
}

function exchangeRows(direction: "long" | "short") {
  return Array.from({ length: 60 }, (_, index) => {
    const open = 100 + (direction === "long" ? index : -index) * 0.04
    const close = open + (direction === "long" ? 0.03 : -0.03)
    return [
      1_700_000_000_000 + index * 60_000,
      String(open),
      String(Math.max(open, close) + 0.05),
      String(Math.min(open, close) - 0.05),
      String(close),
      String(1_000 + index * 10),
    ]
  })
}

describe("Signal indication persistence and independent performance gates", () => {
  beforeEach(() => {
    mockStrings.clear()
    mockHashes.clear()
    mockSets.clear()
    mockLists.clear()
    jest.clearAllMocks()
    __signalIndicationTestUtils.clearCaches()
  })

  test("mature exact config PF cannot be bypassed, and permanent live disable still wins", () => {
    const matureNegative = {
      allowed: false,
      ratio: -0.2,
      samples: 12,
      permanentlyDisabled: false,
    }
    const permanentlyDisabled = {
      ...matureNegative,
      samples: 16,
      permanentlyDisabled: true,
    }

    expect(signalConfigurationExecutionAllowed(true, matureNegative)).toBe(false)
    expect(signalConfigurationExecutionAllowed(false, matureNegative)).toBe(false)
    expect(signalConfigurationExecutionAllowed(true, permanentlyDisabled)).toBe(false)
    expect(signalConfigurationExecutionAllowed(true, undefined)).toBe(true)
  })

  test("gates only the mature exact Previous-position lane", async () => {
    const settings = normalizeSignalIndicationSettings({
      configMinimumPfRatio: 0.3,
    })
    for (let index = 0; index < 16; index++) {
      await recordSyntheticSignalOutcome({
        connectionId: "conn-exact-config",
        positionId: `exact-loss-${index}`,
        symbol: "BTCUSDT",
        direction: "long",
        pnl: -1,
        sourceIds: ["source-exact"],
        signalLanes: [{ sourceId: "source-exact", configId: "config-failing" }],
        liveExchange: false,
        settings,
        closedAt: 1_800_000_000_000 + index,
      })
    }

    const decisions = await getSignalConfigurationPerformanceBatch(
      "conn-exact-config",
      [
        {
          sourceId: "source-exact",
          symbol: "BTCUSDT",
          direction: "long",
          configId: "config-failing",
        },
        {
          sourceId: "source-exact",
          symbol: "BTCUSDT",
          direction: "long",
          configId: "config-fresh",
        },
        {
          sourceId: "source-exact",
          symbol: "BTCUSDT",
          direction: "short",
          configId: "config-failing",
        },
      ],
      settings.configMinimumPfRatio,
    )
    const [mature, freshConfig, freshDirection] = [...decisions.values()]

    expect(mature).toEqual({
      allowed: false,
      ratio: -1,
      samples: 12,
      permanentlyDisabled: false,
    })
    expect(signalConfigurationExecutionAllowed(true, mature)).toBe(false)
    expect(freshConfig).toEqual(expect.objectContaining({
      allowed: true,
      samples: 0,
      permanentlyDisabled: false,
    }))
    expect(freshDirection).toEqual(expect.objectContaining({
      allowed: true,
      samples: 0,
      permanentlyDisabled: false,
    }))
    await expect(getSignalSourceLanePerformanceDecision(mockClient, {
      connectionId: "conn-exact-config",
      sourceId: "source-exact",
      symbol: "BTCUSDT",
      direction: "long",
    })).resolves.toEqual({
      allowed: true,
      sourceAllowed: true,
      laneAllowed: true,
    })
  })

  test("derives permanent exact-config disable only from real exchange closes", async () => {
    expect(normalizeSignalIndicationSettings({
      directExecutionEnabled: false,
      configMinimumPfRatio: 2.7,
    })).toMatchObject({
      directExecutionEnabled: true,
      configMinimumPfRatio: 0.3,
    })

    const settings = normalizeSignalIndicationSettings({})
    const request = {
      sourceId: "paper-source",
      symbol: "BTCUSDT",
      direction: "long" as const,
      configId: "tp1_00:slr0_50:standard",
    }
    for (let index = 0; index < 16; index++) {
      await recordSyntheticSignalOutcome({
        connectionId: "conn-live-disable",
        positionId: `paper-loss-${index}`,
        symbol: request.symbol,
        direction: request.direction,
        pnl: -1,
        sourceIds: [request.sourceId],
        signalLanes: [{ sourceId: request.sourceId, configId: request.configId }],
        liveExchange: false,
        settings,
        closedAt: 1_800_000_000_000 + index,
      })
    }
    const paperDecision = (await getSignalConfigurationPerformanceBatch(
      "conn-live-disable",
      [request],
      settings.configMinimumPfRatio,
    )).get("paper-source|BTCUSDT|long|tp1_00:slr0_50:standard")
    expect(paperDecision).toEqual(expect.objectContaining({
      allowed: false,
      samples: 12,
      permanentlyDisabled: false,
    }))

    const liveRequest = { ...request, sourceId: "live-source" }
    for (let index = 0; index < 16; index++) {
      await recordSyntheticSignalOutcome({
        connectionId: "conn-live-disable",
        positionId: `live-loss-${index}`,
        symbol: liveRequest.symbol,
        direction: liveRequest.direction,
        pnl: -1,
        sourceIds: [liveRequest.sourceId],
        signalLanes: [{ sourceId: liveRequest.sourceId, configId: liveRequest.configId }],
        liveExchange: true,
        settings,
        closedAt: 1_800_000_100_000 + index,
      })
    }
    const liveDecision = (await getSignalConfigurationPerformanceBatch(
      "conn-live-disable",
      [liveRequest],
      settings.configMinimumPfRatio,
    )).get("live-source|BTCUSDT|long|tp1_00:slr0_50:standard")
    expect(liveDecision).toEqual(expect.objectContaining({
      allowed: false,
      samples: 12,
      permanentlyDisabled: true,
    }))
    expect(signalConfigurationExecutionAllowed(true, liveDecision)).toBe(false)
  })

  test("persists independent direct-source and consensus Sets with exact active/window counts", async () => {
    const rows = exchangeRows("long")
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const payload = url.includes("bybit")
        ? { result: { list: [...rows].reverse() } }
        : url.includes("okx")
          ? { data: [...rows].reverse() }
          : rows
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch
    const sourceIds = ["binance-usdm", "bybit-linear", "okx-swap"]
    const sources = Object.fromEntries(sourceIds.map((sourceId) => [
      sourceId,
      { enabled: true, weight: 1 },
    ]))
    const settings = normalizeSignalIndicationSettings({
      sources,
      maxSourcesPerCycle: 3,
      minimumSourceSignals: 3,
      minimumAgreement: 0.6,
      minimumStrength: 0.05,
      minimumConfidence: 0.5,
    })
    for (const sourceId of Object.keys(settings.sources)) {
      settings.sources[sourceId].enabled = sourceIds.includes(sourceId)
    }

    const indications = await processSignalIndications({
      connectionId: "conn-a",
      symbol: "BTCUSDT",
      settings,
      positionCostPct: 0.1,
      now: 1_800_000_000_000,
      sourceCursor: 0,
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    // Direct bootstrap execution is enabled by default: every allowed source
    // remains independent and the multi-source consensus is emitted beside it.
    expect(indications).toHaveLength(4)
    expect(indications.filter((item) => item.metadata?.mode === "direct_source")).toHaveLength(3)
    expect(new Set(
      indications
        .filter((item) => item.metadata?.mode === "direct_source")
        .map((item) => item.metadata.signal.sourceId),
    )).toEqual(new Set(sourceIds))
    const consensus = indications.find((item) => item.metadata?.mode === "multi_source_consensus")
    expect(consensus).toEqual(expect.objectContaining({
      type: "signal",
      direction: "long",
    }))
    expect(consensus.metadata.signal.sourceIds).toEqual(expect.arrayContaining(sourceIds))
    for (const sourceId of [...sourceIds, "consensus"]) {
      expect(
        mockLists.get(`indication_set:conn-a:BTCUSDT:signal:long:source:${sourceId}`),
      ).toHaveLength(1)
    }
    expect(mockHashes.get("indications_active:conn-a")?.["BTCUSDT:signal"]).toBe("4")
    expect(mockHashes.get("indication_sets_active:conn-a")?.["BTCUSDT:signal"]).toBe("4")
    expect(JSON.parse(mockStrings.get("signal:cycle:conn-a:BTCUSDT") || "{}").sourceRegistrySize).toBe(35)
    const candidateRank = JSON.parse(
      mockHashes.get("signal:candidate_rank:conn-a")?.BTCUSDT || "{}",
    )
    expect(candidateRank).toEqual(expect.objectContaining({
      symbol: "BTCUSDT",
      direction: "long",
      score: expect.any(Number),
      confidence: expect.any(Number),
      agreement: expect.any(Number),
    }))
    expect(candidateRank.score).toBeGreaterThan(0)

    const pfGatedBootstrap = await processSignalIndications({
      connectionId: "conn-pf-gated-bootstrap",
      symbol: "BTCUSDT",
      settings: { ...settings, directExecutionEnabled: false },
      positionCostPct: 0.1,
      now: 1_800_000_060_000,
      sourceCursor: 0,
      fetchImpl,
      persist: false,
    })
    expect(
      pfGatedBootstrap.filter((item) => item.metadata?.mode === "direct_source"),
    ).toHaveLength(3)
  })

  test("merges mixed-position Signal sources without widening SL or TP protection", () => {
    expect(mergeSignalRisks(
      {
        stopLossPct: 0.8,
        takeProfitPct: 1.4,
        rewardRisk: 1.75,
        sourceIds: ["binance-usdm", "okx-swap"],
        agreement: 0.7,
        confidence: 0.75,
        generatedAt: 100,
      },
      {
        stopLossPct: 0.35,
        takeProfitPct: 0.9,
        rewardRisk: 2.57,
        sourceIds: ["okx-swap", "bybit-linear"],
        agreement: 0.9,
        confidence: 0.88,
        generatedAt: 200,
      },
    )).toEqual({
      stopLossPct: 0.35,
      takeProfitPct: 0.9,
      rewardRisk: 0.9 / 0.35,
      sourceIds: ["binance-usdm", "okx-swap", "bybit-linear"],
      configIds: [],
      signalLanes: [],
      agreement: 0.9,
      confidence: 0.88,
      generatedAt: 200,
    })
  })

  test("singleflights concurrent production cycles and reuses the bounded result cache", async () => {
    const settings = normalizeSignalIndicationSettings({
      requestIntervalSeconds: 30,
    })
    const first = processSignalIndications({
      connectionId: "conn-cache",
      symbol: "BTCUSDT",
      settings,
      now: 1_800_000_000_000,
    })
    const second = processSignalIndications({
      connectionId: "conn-cache",
      symbol: "BTCUSDT",
      settings,
      now: 1_800_000_000_001,
    })
    await Promise.all([first, second])
    await processSignalIndications({
      connectionId: "conn-cache",
      symbol: "BTCUSDT",
      settings,
      now: 1_800_000_029_999,
    })
    expect(initRedis).toHaveBeenCalledTimes(1)

    await processSignalIndications({
      connectionId: "conn-cache",
      symbol: "BTCUSDT",
      settings,
      now: 1_800_000_030_000,
    })
    expect(initRedis).toHaveBeenCalledTimes(2)

    __signalIndicationTestUtils.clearCaches()
    await processSignalIndications({
      connectionId: "conn-cache",
      symbol: "BTCUSDT",
      settings,
      now: 1_800_000_030_001,
    })
    expect(initRedis).toHaveBeenCalledTimes(3)
  })

  test("enforces a configurable Signal request interval with a hard 30-second minimum", () => {
    expect(normalizeSignalIndicationSettings({}).requestIntervalSeconds).toBe(30)
    expect(normalizeSignalIndicationSettings({ requestIntervalSeconds: 1 }).requestIntervalSeconds).toBe(30)
    expect(normalizeSignalIndicationSettings({ requestIntervalSeconds: 45 }).requestIntervalSeconds).toBe(45)
    expect(normalizeSignalIndicationSettings({ requestIntervalSeconds: 10_000 }).requestIntervalSeconds).toBe(3600)
    expect(normalizeSignalIndicationSettings({ cacheTtlMs: 20_000 }).requestIntervalSeconds).toBe(30)
    expect(normalizeSignalIndicationSettings({ cacheTtlMs: 60_000 }).requestIntervalSeconds).toBe(60)
  })

  test("normalizes and enforces independent source-symbol disable lists", () => {
    const settings = normalizeSignalIndicationSettings({
      maxSourcesPerCycle: 35,
      sources: {
        "bingx-swap": {
          enabled: true,
          weight: 1,
          disabledSymbols: ["btc-usdt", "BTCUSDT", "", "eth/usdt"],
        },
      },
    })
    expect(settings.sources["bingx-swap"].disabledSymbols).toEqual(["BTCUSDT", "ETHUSDT"])

    const btcSources = __signalIndicationTestUtils.selectSources(settings, "BTCUSDT", 0)
    const solSources = __signalIndicationTestUtils.selectSources(settings, "SOLUSDT", 0)
    expect(btcSources.some((source) => source.id === "bingx-swap")).toBe(false)
    expect(solSources.some((source) => source.id === "bingx-swap")).toBe(true)
  })

  test("normalizes manual source-symbol-direction lanes independently", () => {
    const settings = normalizeSignalIndicationSettings({
      sources: {
        "bingx-swap": {
          enabled: true,
          weight: 1,
          disabledLanes: [
            "btc-usdt:LONG",
            "BTCUSDT:long",
            "eth/usdt:short",
            "invalid",
          ],
        },
      },
    })
    expect(settings.sources["bingx-swap"].disabledLanes).toEqual([
      "BTCUSDT:long",
      "ETHUSDT:short",
    ])
    expect(signalSourceLaneManuallyDisabled(settings, "bingx-swap", "BTCUSDT", "long")).toBe(true)
    expect(signalSourceLaneManuallyDisabled(settings, "bingx-swap", "BTCUSDT", "short")).toBe(false)
    expect(signalSourceLaneManuallyDisabled(settings, "bingx-swap", "ETHUSDT", "short")).toBe(true)
  })

  test("uses deterministic local Signal sources in forced simulation without HTTP", async () => {
    const priorSimulated = process.env.FORCE_SIMULATED
    const priorLive = process.env.FORCE_LIVE
    process.env.FORCE_SIMULATED = "1"
    process.env.FORCE_LIVE = "0"

    try {
      const indications = await processSignalIndications({
        connectionId: "conn-simulated-signal",
        symbol: "BTCUSDT",
        settings: {
          maxSourcesPerCycle: 10,
          minimumSourceSignals: 3,
          requestIntervalSeconds: 30,
        },
        persist: false,
        now: 1_800_000_000_000,
      })

      expect(indications).toHaveLength(SIGNAL_SOURCE_DEFINITIONS.length + 1)
      expect(indications.filter((item) => item.metadata?.mode === "direct_source")).toHaveLength(
        SIGNAL_SOURCE_DEFINITIONS.length,
      )
      const consensus = indications.find((item) => item.metadata?.mode === "multi_source_consensus")
      expect(consensus).toEqual(expect.objectContaining({
        type: "signal",
        symbol: "BTCUSDT",
        direction: "long",
      }))
      expect(consensus.metadata.signal).toEqual(expect.objectContaining({
        selectedSourceCount: SIGNAL_SOURCE_DEFINITIONS.length,
        evaluatedSourceCount: SIGNAL_SOURCE_DEFINITIONS.length,
        allowedSourceCount: SIGNAL_SOURCE_DEFINITIONS.length,
      }))
      expect(consensus.metadata.signal.sourceIds).toHaveLength(SIGNAL_SOURCE_DEFINITIONS.length)
      expect(consensus.metadata.signal.sourceIds).toEqual(
        expect.arrayContaining(["bingx-swap", "binance-usdm", "bybit-linear", "okx-swap"]),
      )
      expect(mockHashes.get("signal:source_health:conn-simulated-signal")).toBeDefined()
    } finally {
      if (priorSimulated === undefined) delete process.env.FORCE_SIMULATED
      else process.env.FORCE_SIMULATED = priorSimulated
      if (priorLive === undefined) delete process.env.FORCE_LIVE
      else process.env.FORCE_LIVE = priorLive
    }
  })

  test("honours a persisted source circuit after process restart", async () => {
    const now = 1_800_000_000_000
    const sourceIds = ["binance-usdm", "bybit-linear", "okx-swap"]
    const settings = normalizeSignalIndicationSettings({
      maxSourcesPerCycle: 3,
      minimumSourceSignals: 3,
    })
    for (const sourceId of Object.keys(settings.sources)) {
      settings.sources[sourceId].enabled = sourceIds.includes(sourceId)
    }
    mockHashes.set("signal:source_health:conn-circuit", Object.fromEntries(
      sourceIds.map((sourceId) => [sourceId, JSON.stringify({
        sourceId,
        successes: 0,
        failures: 3,
        consecutiveFailures: 3,
        lastLatencyMs: 100,
        lastCandleCount: 0,
        circuitOpenUntil: now + 60_000,
      })]),
    ))
    const fetchImpl = jest.fn(async () => new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch

    const result = await processSignalIndications({
      connectionId: "conn-circuit",
      symbol: "BTCUSDT",
      settings,
      now,
      fetchImpl,
    })

    expect(result).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test("uses exactly the canonical last 12 outcomes and isolates source, symbol and direction", async () => {
    const settings = normalizeSignalIndicationSettings({
      // Persisted legacy values cannot override the fixed 12-position
      // source/config evaluation contract.
      performanceLookback: 15,
      performanceMinSamples: 15,
      performanceCooldownMinutes: 60,
    })
    await Promise.all(Array.from({ length: 15 }, (_, index) =>
      recordSyntheticSignalOutcome({
        connectionId: "conn-a",
        positionId: `loss-${index}`,
        symbol: "BTCUSDT",
        direction: "long",
        pnl: -1,
        sourceIds: ["source-a"],
        settings,
        closedAt: 1_800_000_000_000 + index,
      }),
    ))
    // A retry of an already-booked close cannot alter the window.
    await recordSyntheticSignalOutcome({
      connectionId: "conn-a",
      positionId: "loss-0",
      symbol: "BTCUSDT",
      direction: "long",
      pnl: 100,
      sourceIds: ["source-a"],
      settings,
      closedAt: 1_800_000_100_000,
    })

    const disabled = await getSignalPerformanceDecision(mockClient, {
      connectionId: "conn-a",
      sourceId: "source-a",
      symbol: "BTCUSDT",
      direction: "long",
      settings,
      now: 1_800_000_010_000,
    })
    expect(disabled.allowed).toBe(false)
    expect(disabled.reason).toBe("negative_pnl")
    expect(disabled.state.count).toBe(12)
    expect(disabled.state.totalPnl).toBe(-12)
    expect(disabled.state.grossProfit).toBe(0)
    expect(disabled.state.grossLoss).toBe(12)
    expect(disabled.state.profitFactor).toBe(0)

    for (const [sourceId, symbol, direction] of [
      ["source-b", "BTCUSDT", "long"],
      ["source-a", "ETHUSDT", "long"],
      ["source-a", "BTCUSDT", "short"],
    ] as const) {
      const independent = await getSignalPerformanceDecision(mockClient, {
        connectionId: "conn-a",
        sourceId,
        symbol,
        direction,
        settings,
        now: 1_800_000_010_000,
      })
      expect(independent.allowed).toBe(true)
      expect(independent.reason).toBe("bootstrap")
    }

    const probeAt = disabled.state.disabledUntil + 1
    const probe = await getSignalPerformanceDecision(mockClient, {
      connectionId: "conn-a",
      sourceId: "source-a",
      symbol: "BTCUSDT",
      direction: "long",
      settings,
      now: probeAt,
    })
    const duplicateProbe = await getSignalPerformanceDecision(mockClient, {
      connectionId: "conn-a",
      sourceId: "source-a",
      symbol: "BTCUSDT",
      direction: "long",
      settings,
      now: probeAt + 1,
    })
    expect(probe).toEqual(expect.objectContaining({ allowed: true, probe: true, reason: "cooldown_probe" }))
    expect(duplicateProbe.allowed).toBe(false)
  })

  test("cannot override the fixed 12-position legacy performance contract", () => {
    const settings = normalizeSignalIndicationSettings({
      performanceLookback: 100,
      performanceMinSamples: 1,
      performanceDisableBelowPnl: -1_000_000,
    })
    expect(settings.performanceLookback).toBe(12)
    expect(settings.performanceMinSamples).toBe(12)
    expect(settings.performanceDisableBelowPnl).toBe(0)
  })

  test("defaults all 35 sources, physical capacity 350 and best-first admission", () => {
    const defaults = normalizeSignalIndicationSettings({})
    const clamped = normalizeSignalIndicationSettings({
      maxPositionsTotal: 9_999,
      positionSelectionMode: "fifo",
    })
    expect(defaults.maxSourcesPerCycle).toBe(35)
    expect(defaults.maxPositionsTotal).toBe(350)
    expect(defaults.positionSelectionMode).toBe("best_first")
    expect(clamped.maxPositionsTotal).toBe(350)
    expect(clamped.positionSelectionMode).toBe("best_first")
  })

  test("keeps source health diagnostic while exact configuration lanes own admission", async () => {
    const settings = normalizeSignalIndicationSettings({})
    // BTC/Long loses its newest ten outcomes. Later ETH/Long wins keep the
    // source-wide newest-12 window positive, so only the exact BTC/Long lane
    // must be disabled.
    for (let index = 0; index < 10; index++) {
      await recordSyntheticSignalOutcome({
        connectionId: "conn-v2-lanes",
        positionId: `btc-loss-${index}`,
        symbol: "BTCUSDT",
        direction: "long",
        pnl: -1,
        sourceIds: ["source-lanes"],
        settings,
        closedAt: 1_800_000_000_000 + index,
      })
    }
    for (let index = 0; index < 12; index++) {
      await recordSyntheticSignalOutcome({
        connectionId: "conn-v2-lanes",
        positionId: `eth-win-${index}`,
        symbol: "ETHUSDT",
        direction: "long",
        pnl: 2,
        sourceIds: ["source-lanes"],
        settings,
        closedAt: 1_800_000_001_000 + index,
      })
    }

    await expect(getSignalSourceLanePerformanceDecision(mockClient, {
      connectionId: "conn-v2-lanes",
      sourceId: "source-lanes",
      symbol: "BTCUSDT",
      direction: "long",
    })).resolves.toEqual({
      allowed: true,
      sourceAllowed: true,
      laneAllowed: true,
    })
    await expect(getSignalSourceLanePerformanceDecision(mockClient, {
      connectionId: "conn-v2-lanes",
      sourceId: "source-lanes",
      symbol: "ETHUSDT",
      direction: "long",
    })).resolves.toEqual({
      allowed: true,
      sourceAllowed: true,
      laneAllowed: true,
    })
    await expect(getSignalSourceLanePerformanceDecision(mockClient, {
      connectionId: "conn-v2-lanes",
      sourceId: "source-lanes",
      symbol: "BTCUSDT",
      direction: "short",
    })).resolves.toEqual({
      allowed: true,
      sourceAllowed: true,
      laneAllowed: true,
    })

    // A separate source with twelve negative closes remains diagnostic only,
    // even for a fresh symbol/direction lane.
    for (let index = 0; index < 12; index++) {
      await recordSyntheticSignalOutcome({
        connectionId: "conn-v2-lanes",
        positionId: `source-loss-${index}`,
        symbol: "SOLUSDT",
        direction: "short",
        pnl: -1,
        sourceIds: ["source-negative"],
        settings,
        closedAt: 1_800_000_002_000 + index,
      })
    }
    await expect(getSignalSourceLanePerformanceDecision(mockClient, {
      connectionId: "conn-v2-lanes",
      sourceId: "source-negative",
      symbol: "XRPUSDT",
      direction: "long",
    })).resolves.toEqual({
      allowed: true,
      sourceAllowed: true,
      laneAllowed: true,
    })
  })

  test("attributes consensus outcomes to the consensus lane without contaminating contributors", async () => {
    const settings = normalizeSignalIndicationSettings({})
    for (let index = 0; index < 12; index++) {
      await recordSyntheticSignalOutcome({
        connectionId: "conn-consensus-isolation",
        positionId: `consensus-loss-${index}`,
        symbol: "BTCUSDT",
        direction: "long",
        pnl: -1,
        sourceIds: ["binance-usdm", "okx-swap", "bybit-linear"],
        signalLanes: [{
          sourceId: "consensus",
          configId: "tp1_00:slr0_50:standard",
        }],
        settings,
        closedAt: 1_800_000_000_000 + index,
      })
    }

    await expect(getSignalSourceLanePerformanceDecision(mockClient, {
      connectionId: "conn-consensus-isolation",
      sourceId: "consensus",
      symbol: "BTCUSDT",
      direction: "long",
    })).resolves.toEqual({
      allowed: true,
      sourceAllowed: true,
      laneAllowed: true,
    })
    await expect(getSignalSourceLanePerformanceDecision(mockClient, {
      connectionId: "conn-consensus-isolation",
      sourceId: "binance-usdm",
      symbol: "BTCUSDT",
      direction: "long",
    })).resolves.toEqual({
      allowed: true,
      sourceAllowed: true,
      laneAllowed: true,
    })
  })

  test("attributes an exact direct-source lane without disabling contributors or consensus", async () => {
    const settings = normalizeSignalIndicationSettings({})
    for (let index = 0; index < 12; index++) {
      await recordSyntheticSignalOutcome({
        connectionId: "conn-direct-isolation",
        positionId: `direct-loss-${index}`,
        symbol: "ETHUSDT",
        direction: "short",
        pnl: -1,
        sourceIds: ["binance-usdm", "okx-swap", "bybit-linear"],
        signalLanes: [{
          sourceId: "binance-usdm",
          configId: "tp1_00:slr0_50:standard",
        }],
        settings,
        closedAt: 1_810_000_000_000 + index,
      })
    }

    await expect(getSignalSourceLanePerformanceDecision(mockClient, {
      connectionId: "conn-direct-isolation",
      sourceId: "binance-usdm",
      symbol: "ETHUSDT",
      direction: "short",
    })).resolves.toEqual({
      allowed: true,
      sourceAllowed: true,
      laneAllowed: true,
    })
    for (const sourceId of ["okx-swap", "consensus"]) {
      await expect(getSignalSourceLanePerformanceDecision(mockClient, {
        connectionId: "conn-direct-isolation",
        sourceId,
        symbol: "ETHUSDT",
        direction: "short",
      })).resolves.toEqual({
        allowed: true,
        sourceAllowed: true,
        laneAllowed: true,
      })
    }
  })

  test("drops old losses when the newest rolling 12 outcomes are profitable", async () => {
    const settings = normalizeSignalIndicationSettings({
      performanceLookback: 12,
      performanceMinSamples: 12,
    })
    for (let index = 0; index < 20; index++) {
      await recordSyntheticSignalOutcome({
        connectionId: "conn-window",
        positionId: `position-${index}`,
        symbol: "SOLUSDT",
        direction: "short",
        pnl: index < 5 ? -10 : 1,
        sourceIds: ["source-window"],
        settings,
        closedAt: 1_800_000_000_000 + index,
      })
    }
    const decision = await getSignalPerformanceDecision(mockClient, {
      connectionId: "conn-window",
      sourceId: "source-window",
      symbol: "SOLUSDT",
      direction: "short",
      settings,
      now: 1_800_000_100_000,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe("performing")
    expect(decision.state).toEqual(expect.objectContaining({
      count: 12,
      wins: 12,
      grossProfit: 12,
      grossLoss: 0,
      profitFactor: 999,
      totalPnl: 12,
    }))
  })

  test("calculates exact gross-profit/gross-loss PF for every independent last-12 lane", async () => {
    const settings = normalizeSignalIndicationSettings({})
    for (let index = 0; index < 12; index++) {
      await recordSyntheticSignalOutcome({
        connectionId: "conn-pf",
        positionId: `position-${index}`,
        symbol: "ETHUSDT",
        direction: "short",
        pnl: index < 8 ? 2 : -4,
        sourceIds: ["source-pf"],
        settings,
        closedAt: 1_800_000_000_000 + index,
      })
    }

    const decision = await getSignalPerformanceDecision(mockClient, {
      connectionId: "conn-pf",
      sourceId: "source-pf",
      symbol: "ETHUSDT",
      direction: "short",
      settings,
      now: 1_800_000_100_000,
    })
    expect(decision.state).toEqual(expect.objectContaining({
      count: 12,
      wins: 8,
      grossProfit: 16,
      grossLoss: 16,
      profitFactor: 1,
      totalPnl: 0,
    }))
  })
})
