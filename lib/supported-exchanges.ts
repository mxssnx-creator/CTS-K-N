/**
 * Exchanges the connector factory (lib/exchange-connectors/index.ts) can
 * build a connector for. A connection on any other exchange (seeded
 * templates such as MEXC, Gate.io, KuCoin, Bitget, Huobi) has no market data
 * and no order path: it must not be QuickStarted, or the engine "completes"
 * a run that evaluated nothing.
 */
export const SUPPORTED_CONNECTOR_EXCHANGES = ["bybit", "bingx", "pionex", "orangex", "binance", "okx", "instaforex"] as const

export function isSupportedConnectorExchange(exchange: unknown): boolean {
  const compact = String(exchange ?? "").toLowerCase().replace(/[^a-z]/g, "")
  return (SUPPORTED_CONNECTOR_EXCHANGES as readonly string[]).includes(compact)
}
