#!/usr/bin/env node
/**
 * Read-only public Signal-source diagnostic.
 *
 * This runner imports only the market-data registry. It never initializes the
 * trade engine, loads credentials, signs a request, or calls an order endpoint.
 * Adapter correctness is covered by fixture tests; this probe reports which
 * public endpoints are reachable from the current deployment network.
 */

import {
  SIGNAL_SOURCE_DEFINITIONS,
  signalSourceSupportsSymbol,
} from "@/lib/signal-source-registry"

const symbol = String(process.env.SIGNAL_PROBE_SYMBOL || "BTCUSDT")
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, "")
const timeoutMs = Math.max(
  500,
  Math.min(30_000, Number(process.env.SIGNAL_PROBE_TIMEOUT_MS) || 5_000),
)
const concurrency = Math.max(
  1,
  Math.min(10, Number(process.env.SIGNAL_PROBE_CONCURRENCY) || 5),
)
const strict = process.argv.includes("--strict")

type ProbeResult = {
  sourceId: string
  ok: boolean
  status?: number
  candles: number
  latencyMs: number
  error?: string
}

async function probe(source: (typeof SIGNAL_SOURCE_DEFINITIONS)[number]): Promise<ProbeResult> {
  const startedAt = Date.now()
  const request = source.buildRequest({
    symbol,
    limit: 25,
    now: Date.now(),
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(request.url, {
      ...request.init,
      headers: {
        Accept: "application/json",
        ...(request.init?.headers || {}),
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        sourceId: source.id,
        ok: false,
        status: response.status,
        candles: 0,
        latencyMs: Date.now() - startedAt,
        error: `http_${response.status}`,
      }
    }
    const contentType = response.headers.get("content-type") || ""
    if (contentType && !contentType.toLowerCase().includes("json")) {
      throw new Error(`unexpected_content_type_${contentType.split(";")[0]}`)
    }
    const payload = await response.json()
    const candles = source.parse(payload)
    return {
      sourceId: source.id,
      ok: candles.length > 0,
      status: response.status,
      candles: candles.length,
      latencyMs: Date.now() - startedAt,
      ...(candles.length === 0 ? { error: "no_valid_candles" } : {}),
    }
  } catch (error) {
    return {
      sourceId: source.id,
      ok: false,
      candles: 0,
      latencyMs: Date.now() - startedAt,
      error: (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, " ")
        .slice(0, 180),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++
        output[index] = await mapper(values[index])
      }
    },
  )
  await Promise.all(workers)
  return output
}

async function main(): Promise<void> {
  const sources = SIGNAL_SOURCE_DEFINITIONS.filter((source) =>
    signalSourceSupportsSymbol(source, symbol),
  )
  const results = await mapLimit(sources, concurrency, probe)
  const reachable = results.filter((result) => result.ok)
  const output = {
    success: strict ? reachable.length === sources.length : true,
    mode: "public-market-data-read-only",
    symbol,
    registrySources: SIGNAL_SOURCE_DEFINITIONS.length,
    compatibleSources: sources.length,
    reachableSources: reachable.length,
    failedSources: results.length - reachable.length,
    orderEndpointsCalled: 0,
    authenticatedRequests: 0,
    results,
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  if (strict && reachable.length !== sources.length) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(
    `[signal-source-probe] ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
