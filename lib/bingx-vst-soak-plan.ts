/** Explicit coverage must fit complete, paced virtual-order lifecycles. */
export function resolveVstSoakPlan(input: {
  durationMs: number; symbolCount?: number; cycles?: number; trailingUpdate?: boolean
}) {
  const integer = (value: number, min: number, max: number, label: string) => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer between ${min} and ${max}`)
    return value
  }
  const requestedSymbols = input.symbolCount === undefined ? undefined : integer(input.symbolCount, 4, 32, "VST symbol count")
  const defaultCycles = input.durationMs === 1_200_000 ? 16 : 6
  const cycles = integer(input.cycles ?? Math.max(defaultCycles, requestedSymbols || 4), 4, 128, "VST cycle count")
  if (requestedSymbols && cycles < requestedSymbols) throw new Error("VST cycles must cover every requested symbol")
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < cycles * 60_000) throw new Error("VST duration must allow at least 60 seconds per complete lifecycle")
  return {
    targetSymbols: requestedSymbols ?? Math.min(8, cycles),
    minimumSymbols: requestedSymbols ?? 4,
    cycles,
    cycleWindowMs: input.durationMs / cycles,
    plannedVenueSubmissions: cycles * (input.trailingUpdate ? 8 : 6),
  }
}

/** Venue catalog is authoritative; no unsupported symbol is invented. */
export function parseVstSoakCandidateSymbols(payload: unknown, preferred: readonly string[], limit = 128): string[] {
  const body = payload as any
  if (body?.code !== undefined && String(body.code) !== "0") throw new Error("VST contract catalog was rejected")
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.contracts) ? body.data.contracts : []
  const available = new Set<string>(rows.map((row: any) => String(row?.symbol || row?.contract || row?.name || "").toUpperCase().replace(/[-/_:]/g, ""))
    .filter((symbol: string) => /^[A-Z0-9]+USDT$/.test(symbol)))
  const ordered = [...preferred.filter(symbol => available.has(symbol)), ...available]
  return [...new Set(ordered)].slice(0, Math.max(0, Math.min(128, Math.floor(limit))))
}

/** Avoid coupling four trade paths to one side across a 32-symbol pass. */
export function vstSoakCoverageDirection(cycleIndex: number, symbolCount: number): "long" | "short" {
  if (!Number.isSafeInteger(cycleIndex) || cycleIndex < 0 || !Number.isSafeInteger(symbolCount) || symbolCount < 1) throw new Error("Invalid VST coverage cycle")
  const repeatedSymbolFlip = symbolCount % 2 === 0 ? Math.floor(cycleIndex / symbolCount) : 0
  const withinPassFlip = symbolCount >= 16 ? Math.floor((cycleIndex % symbolCount) / 8) : 0
  return (cycleIndex + repeatedSymbolFlip + withinPassFlip) % 2 === 0 ? "long" : "short"
}
