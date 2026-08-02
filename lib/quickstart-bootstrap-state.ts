function enabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

/**
 * A running engine is not proof that its historic bootstrap has completed.
 * Repeated QuickStart calls may arrive while the current generation is still
 * filling Base/Main/Real sets. Retain the existing completion only when both
 * durable surfaces attest to the same selected-symbol generation.
 */
export function canRetainQuickStartPrehistoricCoverage(input: {
  engineRunning: boolean
  needsFreshProcessing: boolean
  expectedSelectionEpoch: unknown
  engineState: Record<string, unknown> | null | undefined
  prehistoricState: Record<string, unknown> | null | undefined
}): boolean {
  if (!input.engineRunning || input.needsFreshProcessing) return false

  const expectedEpoch = String(input.expectedSelectionEpoch || "").trim()
  const engineEpoch = String(
    input.engineState?.symbol_selection_epoch ??
    input.engineState?.quickstart_symbol_generation ??
    "",
  ).trim()
  const historicEpoch = String(input.prehistoricState?.symbol_selection_epoch || "").trim()

  return Boolean(expectedEpoch) &&
    expectedEpoch === engineEpoch &&
    expectedEpoch === historicEpoch &&
    enabled(input.engineState?.prehistoric_data_loaded) &&
    enabled(input.prehistoricState?.is_complete)
}
