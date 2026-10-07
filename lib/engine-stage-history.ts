// Main/Real coordinates are calculated on one-minute closes even though the
// engine's canonical market-data feed is 1s.  Keep one authoritative minimum
// here so startup, realtime indication processing, cache validation and the
// prehistoric per-type measurement agree: 90 one-minute bars require 5,400
// one-second samples. Dependency-free so pure calculation modules can use it.
export const ENGINE_STAGE_HISTORY_MINUTES = 90
export const ENGINE_STAGE_HISTORY_CANDLES = ENGINE_STAGE_HISTORY_MINUTES * 60
