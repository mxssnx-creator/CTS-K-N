#!/usr/bin/env node
/**
 * Offline 50-symbol end-to-end engine soak (paper/simulated only).
 *
 * Thin wrapper around scripts/run-offline-engine-soak.mjs (the generic
 * N-symbol driver) with OFFLINE_SYMBOL_COUNT=50 — the original basket in the
 * original order. Every OFFLINE_* variable documented there applies.
 */
import process from "node:process"

process.env.OFFLINE_SYMBOL_COUNT ||= "50"
await import("./run-offline-engine-soak.mjs")
