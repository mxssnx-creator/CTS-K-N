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

/**
 * PREHISTORIC_EXACT_CONNECTIONS (comma list) runs the exact replay for those connections only, so a simulation connection can
 * evaluate every configuration over its whole prehistoric range while a live connection keeps the realtime bridge
 * (operator request 2026-10-02: "always calc all config possibilities" with prehistoric calcs). PREHISTORIC_REPLAY_MODE=exact
 * still switches every connection.
 */
export function resolveHistoricReplayMode(
  value = process.env.PREHISTORIC_REPLAY_MODE,
  connectionId?: string,
  exactConnections: string | undefined = process.env.PREHISTORIC_EXACT_CONNECTIONS,
): HistoricReplayMode {
  if (String(value || "").trim().toLowerCase() === "exact") return "exact"
  if (connectionId && String(exactConnections || "").split(",").map((id) => id.trim()).filter(Boolean).includes(connectionId)) return "exact"
  return "realtime-bridge"
}
export function historicReplayNeedsRealtimeWarmup(mode: HistoricReplayMode): boolean {
  return mode !== "exact"
}

/** Only exact replay evaluates the canonical Base→Main→Real graph. */
export function historicReplayNeedsCanonicalAdmission(mode: HistoricReplayMode): boolean {
  return mode === "exact"
}
