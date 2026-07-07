/**
 * Trade Engine Module Exports
 *
 * All consumers import directly from "@/lib/trade-engine" (the parent
 * lib/trade-engine.ts) which contains the GlobalTradeEngineCoordinator
 * singleton and all exported helpers.
 *
 * This barrel re-exports the two most-used sub-module classes for
 * convenience, without duplicating the top-level coordinator exports
 * (those live exclusively in lib/trade-engine.ts to avoid circular
 * re-export confusion).
 */

// Per-connection TradeEngine class
export { TradeEngine, TRADE_SERVICE_NAME, type TradeEngineConfig } from "./trade-engine"

// Engine manager for service lifecycle
export { TradeEngineManager, type EngineConfig } from "./engine-manager"
