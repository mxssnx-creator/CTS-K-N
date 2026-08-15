function enabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

/**
 * A running engine is not proof that its historic bootstrap has completed.
 * Repeated QuickStart calls may arrive while the current generation is still
 * filling Base/Main/Real sets. Retain the existing completion only when both
 * durable surfaces attest to the same selected-symbol generation. A stopped
 * process may retain it only after ProgressionStateManager has independently
 * verified its settings fingerprint and stamped the dedicated restart source.
 */
export function canRetainQuickStartPrehistoricCoverage(input: {
  engineRunning: boolean
  needsFreshProcessing: boolean
  stoppedProgressionMatchesCurrentState?: boolean
  expectedSymbolCount?: number
  expectedSymbolsHash?: string
  expectedSelectionEpoch: unknown
  engineState: Record<string, unknown> | null | undefined
  prehistoricState: Record<string, unknown> | null | undefined
}): boolean {
  const verifiedProcessRestartCache =
    input.engineState?.prehistoric_data_source === "verified-process-restart-cache"
  const verifiedStoppedProgression =
    !input.engineRunning && input.stoppedProgressionMatchesCurrentState === true
  if (
    (!input.engineRunning && !verifiedProcessRestartCache && !verifiedStoppedProgression) ||
    (input.needsFreshProcessing && !verifiedProcessRestartCache)
  ) {
    return false
  }

  const expectedEpoch = String(input.expectedSelectionEpoch || "").trim()
  const engineEpoch = String(
    input.engineState?.symbol_selection_epoch ??
    input.engineState?.quickstart_symbol_generation ??
    "",
  ).trim()
  const historicEpoch = String(input.prehistoricState?.symbol_selection_epoch || "").trim()

  const expectedSymbolCount = Math.max(0, Number(input.expectedSymbolCount || 0))
  const stoppedCoverageMatches = input.engineRunning || (
    expectedSymbolCount > 0 &&
    Number(input.prehistoricState?.symbols_processed || 0) === expectedSymbolCount &&
    Number(input.prehistoricState?.symbols_total || 0) === expectedSymbolCount &&
    Object.prototype.hasOwnProperty.call(input.prehistoricState || {}, "historic_avg_profit_factor") &&
    String(input.prehistoricState?.completed_progression_fingerprint || "") !== "" &&
    String(input.prehistoricState?.completed_symbols_hash || "") === String(input.expectedSymbolsHash || "")
  )

  return Boolean(expectedEpoch) &&
    expectedEpoch === engineEpoch &&
    expectedEpoch === historicEpoch &&
    enabled(input.engineState?.prehistoric_data_loaded) &&
    enabled(input.prehistoricState?.is_complete) &&
    stoppedCoverageMatches
}
