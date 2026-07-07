export const EXCHANGE_CONFIGS = {
  bybit: {
    id: "bybit",
    name: "Bybit (X03)",
    displayName: "Bybit",
    type: "Unified",
    api_type: "unified",
    api_key: "",
    api_secret: "",
    docs: "https://bybit-exchange.github.io/docs/v5/intro",
    status: "active",
    capabilities: ["unified", "perpetual_futures", "spot", "leverage", "hedge_mode", "trailing"],
  },
  bingx: {
    id: "bingx",
    name: "BingX (X01)",
    displayName: "BingX",
    type: "Futures",
    api_type: "futures",
    api_key: "",
    api_secret: "",
    docs: "https://bingx-api.github.io/docs/#/en-us/swapV2/introduce",
    status: "active",
    capabilities: ["futures", "perpetual_futures", "leverage", "hedge_mode"],
  },
  pionex: {
    id: "pionex",
    name: "Pionex (X01)",
    displayName: "Pionex",
    type: "Futures",
    api_type: "futures",
    api_key: "",
    api_secret: "",
    docs: "https://pionex-doc.gitbook.io/apidocs/",
    status: "active",
    capabilities: ["futures", "perpetual_futures", "leverage", "hedge_mode"],
  },
  orangex: {
    id: "orangex",
    name: "OrangeX (X01)",
    displayName: "OrangeX",
    type: "Futures",
    api_type: "futures",
    api_key: "",
    api_secret: "",
    docs: "https://openapi-docs.orangex.com/",
    status: "active",
    capabilities: ["futures", "perpetual_futures", "leverage"],
  },
  binance: {
    id: "binance",
    name: "Binance",
    displayName: "Binance",
    type: "Spot/Futures",
    api_type: "perpetual_futures",
    api_key: "",
    api_secret: "",
    docs: "https://binance-docs.github.io/apidocs/",
    status: "active",
    capabilities: ["spot", "futures", "perpetual_futures", "leverage", "hedge_mode"],
  },
  okx: {
    id: "okx",
    name: "OKX",
    displayName: "OKX",
    type: "Spot/Futures",
    api_type: "perpetual_futures",
    api_key: "",
    api_secret: "",
    docs: "https://www.okx.com/docs-v5/en/",
    status: "active",
    capabilities: ["spot", "futures", "perpetual_futures", "leverage", "hedge_mode"],
  },
  gateio: {
    id: "gateio",
    name: "Gate.io",
    displayName: "Gate.io",
    type: "Spot/Futures",
    api_type: "futures",
    api_key: "",
    api_secret: "",
    docs: "https://www.gate.io/docs/developers/apiv4/",
    status: "active",
    capabilities: ["spot", "futures", "leverage"],
  },
  mexc: {
    id: "mexc",
    name: "MEXC",
    displayName: "MEXC",
    type: "Spot/Futures",
    api_type: "futures",
    api_key: "",
    api_secret: "",
    docs: "https://mexcdevelop.github.io/apidocs/",
    status: "active",
    capabilities: ["spot", "futures", "leverage"],
  },
  bitget: {
    id: "bitget",
    name: "Bitget",
    displayName: "Bitget",
    type: "Spot/Futures",
    api_type: "futures",
    api_key: "",
    api_secret: "",
    docs: "https://bitgetlimited.github.io/apidoc/en/mix/",
    status: "failing",
    capabilities: ["spot", "futures", "leverage"],
  },
  kucoin: {
    id: "kucoin",
    name: "KuCoin",
    displayName: "KuCoin",
    type: "Spot/Futures",
    api_type: "futures",
    api_key: "",
    api_secret: "",
    docs: "https://docs.kucoin.com/",
    status: "failing",
    capabilities: ["spot", "futures", "leverage"],
  },
  huobi: {
    id: "huobi",
    name: "Huobi",
    displayName: "Huobi",
    type: "Spot/Futures",
    api_type: "futures",
    api_key: "",
    api_secret: "",
    docs: "https://huobiapi.github.io/docs/spot/v1/en/",
    status: "failing",
    capabilities: ["spot", "futures", "leverage"],
  },
}

export const DEFAULT_SYMBOLS = ["BCHUSDT", "XRPUSDT", "ETHUSDT", "LINKUSDT", "DOGEUSDT", "HUSDT"]

export const FORCED_SYMBOLS = ["XRPUSDT", "BCHUSDT"]

export const INDICATION_RANGES = {
  min: 2,
  max: 30,
  step: 1,
}

export const STRATEGY_RANGES = {
  takeprofit: { min: 2, max: 22, step: 1 },
  stoploss: { min: 0.2, max: 2.2, step: 0.1 },
  trail_start: [0.3, 0.6, 1.0],
  trail_stop: [0.1, 0.2, 0.3],
  trail_step: 0.3,
}

export const PROJECT_NAME = "cts"
export const TRADE_SERVICE_NAME = `${PROJECT_NAME}-trade` // "cts-trade"

export const INTERVALS = {
  indication: 1000, // 1 second
  strategy: 1000, // 1 second
  real_position: 300, // 0.3 seconds
}

export function getExchangeConfig(identifier: string) {
  const normalized = identifier.toLowerCase()
  return EXCHANGE_CONFIGS[normalized as keyof typeof EXCHANGE_CONFIGS]
}

export function getSupportedExchanges() {
  return Object.entries(EXCHANGE_CONFIGS)
    .filter(([_, config]) => config.status === "active")
    .map(([id, config]) => ({
      id,
      name: config.displayName,
      type: config.type,
      capabilities: config.capabilities,
    }))
}
