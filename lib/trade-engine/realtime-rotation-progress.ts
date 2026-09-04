export interface RealtimeRotationProgress {
  basketGeneration: string
  configuredSymbolCount: number
  attemptedCurrentTick: number
  succeededCurrentTick: number
  failedCurrentTick: number
  coveredUnique: number
  complete: boolean
  failedSymbols: string[]
  stalledSymbols: string[]
}

export function realtimeBasketGeneration(
  symbols: readonly string[],
  ownerGeneration: number,
  settingsGeneration: number,
): string {
  const identity = Array.from(new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)))
    .sort()
    .join(",")
  return `${ownerGeneration}:${settingsGeneration}:${identity}`
}

/** Pure state machine used by the engine hot loop and its behavioral tests. */
export class RealtimeRotationTracker {
  private generation = ""
  private configured = new Set<string>()
  private covered = new Set<string>()

  beginBasket(generation: string, symbols: readonly string[]): void {
    if (generation === this.generation) return
    this.generation = generation
    this.configured = new Set(symbols)
    this.covered = new Set()
  }

  finishTick(
    generation: string,
    attemptedSymbols: readonly string[],
    successfulSymbols: readonly string[],
  ): RealtimeRotationProgress | null {
    if (generation !== this.generation) return null
    const attempted = Array.from(new Set(attemptedSymbols))
    const succeeded = new Set(successfulSymbols.filter((symbol) => this.configured.has(symbol)))
    for (const symbol of succeeded) this.covered.add(symbol)
    const failedSymbols = attempted.filter((symbol) => !succeeded.has(symbol))
    const stalledSymbols = Array.from(this.configured).filter((symbol) => !this.covered.has(symbol))
    return {
      basketGeneration: this.generation,
      configuredSymbolCount: this.configured.size,
      attemptedCurrentTick: attempted.length,
      succeededCurrentTick: succeeded.size,
      failedCurrentTick: failedSymbols.length,
      coveredUnique: this.covered.size,
      complete: this.configured.size > 0 && this.covered.size === this.configured.size,
      failedSymbols,
      stalledSymbols,
    }
  }
}
