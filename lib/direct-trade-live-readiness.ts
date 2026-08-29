/**
 * Direct-Trade paper evaluation remains available, but its independent live
 * processor does not yet create and reconcile the same exact row TP + row SL
 * + physical-slot security-stop contract enforced by the canonical Live
 * stage. Fail closed instead of advertising ticker-polled exits as equivalent
 * native protection or sharing a net venue slot with another engine.
 */
export const DIRECT_TRADE_LIVE_EXECUTION_READY = false

export const DIRECT_TRADE_LIVE_EXECUTION_BLOCK_CODE =
  "direct_native_protection_not_ready"

export const DIRECT_TRADE_LIVE_EXECUTION_BLOCK_REASON =
  "Direct-Trade live entries require unified exact TP/SL/security controls and shared-slot ownership; paper evaluation remains available."

export function directTradeLiveExecutionReadiness() {
  return {
    ready: DIRECT_TRADE_LIVE_EXECUTION_READY,
    blockCode: DIRECT_TRADE_LIVE_EXECUTION_READY
      ? null
      : DIRECT_TRADE_LIVE_EXECUTION_BLOCK_CODE,
    blockReason: DIRECT_TRADE_LIVE_EXECUTION_READY
      ? null
      : DIRECT_TRADE_LIVE_EXECUTION_BLOCK_REASON,
  }
}
