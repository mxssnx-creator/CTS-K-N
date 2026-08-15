/**
 * Runtime policy for the continuous Historic -> Realtime hand-off.
 *
 * A complete historic Base -> Main -> Real matrix can take much longer than
 * the native one-second candle interval. Replaying every candle inside the
 * same Node process therefore creates an ever-growing queue and starves the
 * current Realtime/Main owner. The safe in-process default is a state bridge:
 * after Realtime has completed a current cycle, advance the historic
 * checkpoint to the newest locally loaded candle and report the bridged lag.
 *
 * Exact candle-by-candle replay remains available for an explicitly isolated,
 * capacity-tested worker. It is never inferred from NODE_ENV because both dev
 * and production can run in the same single-process topology.
 */

export type HistoricReplayMode = "realtime-bridge" | "exact"

export function resolveHistoricReplayMode(value = process.env.PREHISTORIC_REPLAY_MODE): HistoricReplayMode {
  return String(value || "").trim().toLowerCase() === "exact" ? "exact" : "realtime-bridge"
}
export function historicReplayNeedsRealtimeWarmup(mode: HistoricReplayMode): boolean {
  return mode !== "exact"
}
