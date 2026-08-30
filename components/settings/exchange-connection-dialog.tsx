"use client"

import { MIN_VOLUME_FACTOR } from "@/lib/constants"
import {
  MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
  MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
} from "@/lib/main-trade-profit-factor"
import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ConnectionPredefinitionSelector } from "./connection-predefinition-selector"
import { Save, Loader2, ExternalLink, Info } from 'lucide-react'
import { toast } from "@/lib/simple-toast"
import { EXCHANGE_CONFIGS, getExchangeConfig } from "@/lib/config"
import { CONNECTION_PREDEFINITIONS } from "@/lib/connection-predefinitions"
import { normalizeMarketType } from "@/lib/market-types"
import {
  DEFAULT_FOREX_LOT_SIZE,
  DEFAULT_FOREX_POSITIONS_AVERAGE,
  DEFAULT_FOREX_SPREAD_BUFFER_PIPS,
  DEFAULT_FOREX_SPREAD_MULTIPLIER,
} from "@/lib/forex-market"

interface ExchangeConfig {
  name: string
  library: string
  packageName: string
  api_types: Array<{
    value: string
    label: string
    description: string
    capabilities: string[]
  }>
  connection_methods: Array<{
    value: string
    label: string
    description: string
    priority: number
    packageName?: string
  }>
  rate_limits: {
    requests_per_second: number
    requests_per_minute: number
  }
  docs_url: string
}

const EXCHANGE_API_CONFIGS: Record<string, ExchangeConfig> = {
  instaforex: {
    name: "InstaForex",
    library: "native-http",
    packageName: "native-http",
    api_types: [
      {
        value: "forex",
        label: "Forex account and market data",
        description: "Official quotes, charts, balance, open trades, and history; HTTP execution is not published",
        capabilities: ["forex", "quotes", "ohlcv", "account_read", "read_only"],
      },
    ],
    connection_methods: [
      { value: "rest", label: "REST / HTTP", description: "Official Client API and quotes feed", priority: 1 },
    ],
    rate_limits: { requests_per_second: 2, requests_per_minute: 60 },
    docs_url: "https://www.instaforex.com/client_cabinet_api",
  },
  bybit: {
    name: "Bybit",
    library: "pybit",
    packageName: "pybit",
    api_types: [
      {
        value: "unified",
        label: "Unified Trading Account",
        description: "Multi-asset unified margin account",
        capabilities: ["leverage", "hedge_mode", "trailing", "spot", "futures"],
      },
      {
        value: "perpetual_futures",
        label: "Perpetual Futures (USDT)",
        description: "USDT-margined perpetual contracts",
        capabilities: ["leverage", "hedge_mode", "trailing"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library",
        description: "Official Python SDK",
        packageName: "pybit",
        priority: 2,
      },
      { value: "typescript", label: "TypeScript Native", description: "Native TypeScript implementation", priority: 3 },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 120 },
    docs_url: "https://bybit-exchange.github.io/docs/",
  },
  bingx: {
    name: "BingX",
    library: "sdk",
    packageName: "bingx-api",
    api_types: [
      {
        value: "perpetual_futures",
        label: "Perpetual Futures (USDT)",
        description: "USDT-margined perpetual contracts",
        capabilities: ["leverage", "hedge_mode", "trailing"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Node Library",
        description: "bingx-api fast path with signed REST fallback",
        packageName: "bingx-api",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 5, requests_per_minute: 300 },
    docs_url: "https://bingx-api.github.io/docs/",
  },
  binance: {
    name: "Binance",
    library: "python-binance",
    packageName: "python-binance",
    api_types: [
      {
        value: "perpetual_futures",
        label: "Perpetual Futures (USDT)",
        description: "USDT-margined perpetual contracts",
        capabilities: ["leverage", "hedge_mode", "trailing"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library",
        description: "Official Python SDK",
        packageName: "python-binance",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 1200 },
    docs_url: "https://binance-docs.github.io/apidocs/",
  },
  okx: {
    name: "OKX",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "perpetual_futures",
        label: "Perpetual Futures (USDT)",
        description: "USDT-margined perpetual contracts",
        capabilities: ["leverage", "hedge_mode"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 20, requests_per_minute: 600 },
    docs_url: "https://www.okx.com/docs-v5/en/",
  },
  gateio: {
    name: "Gate.io",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 900 },
    docs_url: "https://www.gate.io/docs/developers/apiv4/",
  },
  pionex: {
    name: "Pionex",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage", "hedge_mode"],
      },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 5, requests_per_minute: 300 },
    docs_url: "https://pionex-doc.gitbook.io/apidocs/",
  },
  orangex: {
    name: "OrangeX",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 5, requests_per_minute: 300 },
    docs_url: "https://openapi-docs.orangex.com/",
  },
  mexc: {
    name: "MEXC",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 600 },
    docs_url: "https://mexcdevelop.github.io/apidocs/",
  },
  bitget: {
    name: "Bitget",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 600 },
    docs_url: "https://bitgetlimited.github.io/apidoc/en/mix/",
  },
  kucoin: {
    name: "KuCoin",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 300 },
    docs_url: "https://docs.kucoin.com/",
  },
  huobi: {
    name: "Huobi",
    library: "ccxt",
    packageName: "ccxt",
    api_types: [
      {
        value: "futures",
        label: "Futures Trading",
        description: "Futures contracts",
        capabilities: ["leverage"],
      },
      { value: "spot", label: "Spot Trading", description: "Spot market trading", capabilities: ["market", "limit"] },
    ],
    connection_methods: [
      { value: "rest", label: "REST API", description: "Standard HTTP requests", priority: 1 },
      {
        value: "library",
        label: "Python Library (CCXT)",
        description: "Universal crypto exchange library",
        packageName: "ccxt",
        priority: 2,
      },
    ],
    rate_limits: { requests_per_second: 10, requests_per_minute: 600 },
    docs_url: "https://huobiapi.github.io/docs/spot/v1/en/",
  },
}

interface ConnectionForm {
  name: string
  exchange: string
  market_type: "crypto" | "forex"
  api_type: string
  connection_method: string
  connection_library: string
  api_key: string
  account_id: string
  api_secret: string
  api_passphrase: string
  symbol_suffix: string
  lot_size: string
  position_cost_percent: string
  spread_buffer_pips: string
  spread_multiplier: string
  positions_average: string
  max_spread_pips: string
  margin_type: string
  position_mode: string
  is_testnet: boolean
}

interface ExchangeConnectionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  connection?: any
  existingConnections?: any[]
}

export function ExchangeConnectionDialog({
  open,
  onOpenChange,
  onSuccess,
  connection,
  existingConnections = [],
}: ExchangeConnectionDialogProps) {
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<ConnectionForm>({
    name: "",
    exchange: "bybit",
    market_type: "crypto",
    api_type: "perpetual_futures",
    connection_method: "library",
    connection_library: "pybit",
    api_key: "",
    account_id: "",
    api_secret: "",
    api_passphrase: "",
    symbol_suffix: "",
    lot_size: String(DEFAULT_FOREX_LOT_SIZE),
    position_cost_percent: "0.1",
    spread_buffer_pips: String(DEFAULT_FOREX_SPREAD_BUFFER_PIPS),
    spread_multiplier: String(DEFAULT_FOREX_SPREAD_MULTIPLIER),
    positions_average: String(DEFAULT_FOREX_POSITIONS_AVERAGE),
    max_spread_pips: "3",
    margin_type: "cross",
    position_mode: "hedge",
    is_testnet: false,
  })

  useEffect(() => {
    if (connection) {
      setForm({
        name: connection.name || "",
        exchange: connection.exchange || "bybit",
        market_type: normalizeMarketType(connection.market_type || connection.asset_class, connection.exchange),
        api_type: connection.api_type || "perpetual_futures",
        connection_method: normalizeMarketType(connection.market_type || connection.asset_class, connection.exchange) === "forex"
          ? "rest"
          : connection.connection_method || "library",
        connection_library: normalizeMarketType(connection.market_type || connection.asset_class, connection.exchange) === "forex"
          ? "native-http"
          : connection.connection_library || "pybit",
        api_key: connection.api_key || "",
        account_id: connection.account_id || (normalizeMarketType(connection.market_type || connection.asset_class, connection.exchange) === "forex" ? connection.api_key || "" : ""),
        api_secret: connection.api_secret || "",
        api_passphrase: connection.api_passphrase || "",
        symbol_suffix: connection.symbol_suffix || "",
        lot_size: String(connection.lot_size || DEFAULT_FOREX_LOT_SIZE),
        position_cost_percent: String(connection.position_cost_percent || "0.1"),
        spread_buffer_pips: String(connection.spread_buffer_pips ?? DEFAULT_FOREX_SPREAD_BUFFER_PIPS),
        spread_multiplier: String(connection.spread_multiplier ?? DEFAULT_FOREX_SPREAD_MULTIPLIER),
        positions_average: String(connection.positions_average || connection.average_count || DEFAULT_FOREX_POSITIONS_AVERAGE),
        max_spread_pips: String(connection.max_spread_pips ?? "3"),
        margin_type: connection.margin_type || "cross",
        position_mode: connection.position_mode || "hedge",
        is_testnet: connection.id === "bingx-x02" || connection.is_testnet === true || connection.is_testnet === "1" || connection.is_testnet === "true",
      })
    } else {
      setForm({
        name: "",
        exchange: "bybit",
        market_type: "crypto",
        api_type: "perpetual_futures",
        connection_method: "library",
        connection_library: "pybit",
        api_key: "",
        account_id: "",
        api_secret: "",
        api_passphrase: "",
        symbol_suffix: "",
        lot_size: String(DEFAULT_FOREX_LOT_SIZE),
        position_cost_percent: "0.1",
        spread_buffer_pips: String(DEFAULT_FOREX_SPREAD_BUFFER_PIPS),
        spread_multiplier: String(DEFAULT_FOREX_SPREAD_MULTIPLIER),
        positions_average: String(DEFAULT_FOREX_POSITIONS_AVERAGE),
        max_spread_pips: "3",
        margin_type: "cross",
        position_mode: "hedge",
        is_testnet: false,
      })
    }
  }, [connection, open])

  useEffect(() => {
    const config = EXCHANGE_API_CONFIGS[form.exchange]
    if (config) {
      setForm((prev) => ({
        ...prev,
        market_type: form.exchange === "instaforex" ? "forex" : "crypto",
        api_type: config.api_types[0]?.value || "perpetual_futures",
        connection_method: form.exchange === "instaforex"
          ? "rest"
          : config.connection_methods[0]?.value || "rest",
        connection_library: form.exchange === "instaforex"
          ? "native-http"
          : config.library,
        ...(form.exchange === "instaforex" ? { is_testnet: false, position_mode: "one_way", margin_type: "cross" } : {}),
      }))
    }
  }, [form.exchange])

  const isForex = form.market_type === "forex" || form.exchange === "instaforex"
  const credentialReady = isForex
    ? /^[0-9]{4,12}$/.test(form.account_id.trim())
    : Boolean(form.api_key.trim() && form.api_secret.trim())
  const connectionReady = credentialReady

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error("Please enter a connection name")
      return
    }
    if (!connectionReady) {
      toast.error(isForex ? "Please enter a valid numeric InstaForex account id/login" : "Please enter API key and secret")
      return
    }
    setSaving(true)
    try {
      const [indicationRes, strategyRes, settingsRes] = await Promise.all([
        fetch("/api/settings/indications/main"),
        fetch("/api/settings/strategy"),
        fetch("/api/settings"),
      ])

      const indicationSettings = indicationRes.ok ? await indicationRes.json() : null
      const strategySettings = strategyRes.ok ? await strategyRes.json() : null
      const globalSettings = settingsRes.ok ? await settingsRes.json() : null

      const url = connection ? `/api/settings/connections/${connection.id}` : "/api/settings/connections"
      const method = connection ? "PATCH" : "POST"

      const payload = {
        ...form,
        market_type: isForex ? "forex" : "crypto",
        api_key: isForex ? form.account_id : form.api_key,
        api_secret: isForex ? "" : form.api_secret,
        account_id: isForex ? form.account_id : undefined,
        symbol_suffix: isForex ? form.symbol_suffix : undefined,
        quantity_unit: isForex ? "lots" : undefined,
        lot_size: isForex ? Number(form.lot_size) : undefined,
        position_cost_percent: isForex ? Number(form.position_cost_percent) : undefined,
        spread_buffer_pips: isForex ? Number(form.spread_buffer_pips) : undefined,
        spread_multiplier: isForex ? Number(form.spread_multiplier) : undefined,
        positions_average: isForex ? Number(form.positions_average) : undefined,
        average_count: isForex ? Number(form.positions_average) : undefined,
        max_spread_pips: isForex ? Number(form.max_spread_pips) : undefined,
        api_type: isForex ? "forex" : form.api_type,
        connection_method: isForex ? "rest" : form.connection_method,
        connection_library: isForex ? "native-http" : form.connection_library,
        execution_mode: isForex ? "read_only" : undefined,
        read_only: isForex ? true : undefined,
        execution_supported: isForex ? false : undefined,
        is_testnet: isForex ? false : form.is_testnet,
        connection_settings: {
          // Volume factor only for active connections (not predefined)
          baseVolumeFactor: MIN_VOLUME_FACTOR,
          baseVolumeFactorLive: MIN_VOLUME_FACTOR,
          baseVolumeFactorPreset: MIN_VOLUME_FACTOR,
          baseVolumeFactorSignal: MIN_VOLUME_FACTOR,
          
          // Use indication settings as defaults
          indicationTimeInterval: indicationSettings?.direction?.interval ?? 1,
          indicationTimeout: indicationSettings?.direction?.timeout ?? 0.25,
          indicationTimeoutMs: 250,
          indicationMinProfitFactor: MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
          
          // Canonical PositionCost-relative four-stage defaults. The legacy
          // aliases remain synchronized for older readers, while `strategies`
          // is the authoritative shape consumed by the runtime.
          strategyMinProfitFactor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
          liveTradeProfitFactorMinBase: MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
          liveTradeProfitFactorMinMain: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
          liveTradeProfitFactorMinReal: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
          liveTradeProfitFactorMinLive: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
          liveTradeDrawdownTimeHours: 12,
          presetTradeProfitFactorMinBase: MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
          presetTradeProfitFactorMinMain: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
          presetTradeProfitFactorMinReal: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
          presetTradeProfitFactorMinLive: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
          presetTradeDrawdownTimeHours: 12,
          strategies: {
            main: {
              base: {
                enabled: true,
                min_profit_factor: MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
                max_drawdown_time: 160,
                max_positions: 0,
              },
              main: {
                enabled: true,
                min_profit_factor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
                max_drawdown_time: 160,
                max_positions: 0,
              },
              real: {
                enabled: true,
                min_profit_factor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
                max_drawdown_time: 240,
                max_positions: 0,
              },
              live: {
                enabled: true,
                min_profit_factor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
                max_drawdown_time: 240,
                max_positions: 0,
              },
            },
            preset: {
              base: {
                enabled: true,
                min_profit_factor: MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
                max_drawdown_time: 160,
                max_positions: 0,
              },
              main: {
                enabled: true,
                min_profit_factor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
                max_drawdown_time: 160,
                max_positions: 0,
              },
              real: {
                enabled: true,
                min_profit_factor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
                max_drawdown_time: 240,
                max_positions: 0,
              },
              live: {
                enabled: true,
                min_profit_factor: MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
                max_drawdown_time: 240,
                max_positions: 0,
              },
            },
          },
          
          // Strategy toggles from global settings
          trailingWithTrailing: strategySettings?.trailing_enabled ?? true,
          blockEnabled: strategySettings?.block_enabled ?? true,
          dcaEnabled: strategySettings?.dca_enabled ?? false,
          normalEnabled: true,
          presetTradeBlockEnabled: true,
          presetTradeDcaEnabled: false,
          
          // Symbol settings
          useMainSymbols: globalSettings?.use_main_symbols ?? false,
          arrangementType: "market_cap_24h",
          arrangementCount: 10,
          volumeRangePercentage: 20,
          targetPositions: globalSettings?.positions_average || 300,
        },
      }

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }))
        throw new Error(errorData.details || errorData.error || "Failed to save connection")
      }

      toast.success(connection ? "Connection updated successfully" : "Connection added successfully")
      // Notify dashboard components so stats/cards refresh instantly
      window.dispatchEvent(
        new CustomEvent("connection-settings-updated", { detail: { connectionId: connection?.id } }),
      )
      onSuccess()
      onOpenChange(false)
    } catch (error) {
      console.error("[v0] Failed to save connection:", error)
      toast.error(error instanceof Error ? error.message : "Failed to save connection")
    } finally {
      setSaving(false)
    }
  }

  const loadPredefinedConnection = (predefinition: any) => {
    const baseName = predefinition.name
    let uniqueName = baseName
    let counter = 1

    while (existingConnections.some((conn) => conn.name === uniqueName)) {
      uniqueName = `${baseName} (${counter})`
      counter++
    }

    setForm({
      name: uniqueName,
      exchange: predefinition.id.split("-")[0],
      market_type: predefinition.marketType || (predefinition.exchange === "instaforex" ? "forex" : "crypto"),
      api_type: predefinition.apiType,
      connection_method: predefinition.connectionMethod,
      connection_library: predefinition.connectionLibrary,
      api_key: predefinition.apiKey || "",
      account_id: predefinition.accountId || predefinition.apiKey || "",
      api_secret: predefinition.apiSecret || "",
      api_passphrase: "",
        symbol_suffix: "",
      lot_size: String(DEFAULT_FOREX_LOT_SIZE),
      position_cost_percent: "0.1",
      spread_buffer_pips: String(DEFAULT_FOREX_SPREAD_BUFFER_PIPS),
      spread_multiplier: String(DEFAULT_FOREX_SPREAD_MULTIPLIER),
      positions_average: String(DEFAULT_FOREX_POSITIONS_AVERAGE),
      max_spread_pips: "3",
      margin_type: predefinition.marginType,
      position_mode: predefinition.positionMode,
      is_testnet: predefinition.id === "bingx-x02" || predefinition.defaultTestnet === true,
    })
  }

  const existingConnectionIds = existingConnections.map((conn) => conn.id)
  
  const availablePredefinedCount = CONNECTION_PREDEFINITIONS.filter(
    (pred) => !existingConnectionIds.includes(pred.id)
  ).length

  const selectedExchangeConfig = EXCHANGE_API_CONFIGS[form.exchange]
  const selectedApiType = selectedExchangeConfig?.api_types.find((t) => t.value === form.api_type)
  const selectedConnectionMethod = selectedExchangeConfig?.connection_methods.find(
    (m) => m.value === form.connection_method,
  )
  
  const exchangeInfo = getExchangeConfig(form.exchange)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{connection ? "Edit Connection" : "Add New Connection"}</DialogTitle>
          <DialogDescription>
            {connection ? "Update your exchange connection settings" : "Configure a new exchange API connection"}
          </DialogDescription>
        </DialogHeader>

        {!connection && availablePredefinedCount > 0 && (
          <div className="space-y-4 pb-4 border-b">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Quick Setup - Use Predefined Template</h3>
              <Badge variant="secondary" className="text-xs">
                {availablePredefinedCount} Available
              </Badge>
            </div>
            <ConnectionPredefinitionSelector
              onSelect={loadPredefinedConnection}
              existingConnectionIds={existingConnectionIds}
            />
          </div>
        )}

        <Tabs defaultValue="basic" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="basic">Basic Info</TabsTrigger>
            <TabsTrigger value="api">API Configuration</TabsTrigger>
            <TabsTrigger value="trading">Trading Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Connection Name *</Label>
                <Input
                  id="name"
                  placeholder="My Bybit Account"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="exchange">Exchange *</Label>
                <Select value={form.exchange} onValueChange={(value) => setForm({ ...form, exchange: value })}>
                  <SelectTrigger id="exchange">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(EXCHANGE_CONFIGS).map(([key, config]) => {
                      const apiConfig = EXCHANGE_API_CONFIGS[key]
                      return (
                        <SelectItem key={key} value={key}>
                          <div className="flex items-center gap-2">
                            <span>{config.displayName}</span>
                            <Badge variant="outline" className="text-xs">
                              {config.type}
                            </Badge>
                            {config.status === "failing" && (
                              <Badge variant="destructive" className="text-xs">
                                Failing
                              </Badge>
                            )}
                          </div>
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                {exchangeInfo && (
                  <div className="p-2 bg-muted rounded-md space-y-1">
                    <div className="flex items-center gap-2">
                      <Info className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs font-medium">{exchangeInfo.displayName} - {exchangeInfo.type}</span>
                      {exchangeInfo.status === "failing" && (
                        <Badge variant="destructive" className="text-xs">
                          Known Issues
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {exchangeInfo.capabilities.map((cap) => (
                        <Badge key={cap} variant="secondary" className="text-xs">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                    {exchangeInfo.docs && (
                      <a
                        href={exchangeInfo.docs}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                      >
                        <ExternalLink className="h-3 w-3" />
                        API Documentation
                      </a>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="market-type">Market Type *</Label>
                <Select
                  value={form.market_type}
                  onValueChange={(value) => {
                    const marketType = value === "forex" ? "forex" : "crypto"
                    setForm({
                      ...form,
                      market_type: marketType,
                      exchange: marketType === "forex"
                        ? "instaforex"
                        : form.exchange === "instaforex" ? "bybit" : form.exchange,
                      api_type: marketType === "forex" ? "forex" : form.api_type,
                      connection_method: marketType === "forex"
                        ? "rest"
                        : form.connection_method,
                      connection_library: marketType === "forex"
                        ? "native-http"
                        : form.connection_library,
                      is_testnet: marketType === "forex" ? false : form.is_testnet,
                    })
                  }}
                >
                  <SelectTrigger id="market-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="crypto">Crypto</SelectItem>
                    <SelectItem value="forex">Forex (InstaForex)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {isForex ? (
                <div className="space-y-2 col-span-2">
                  <Label htmlFor="account-id">InstaForex Account ID / Login *</Label>
                  <Input
                    id="account-id"
                    inputMode="numeric"
                    placeholder="Numeric account login"
                    value={form.account_id}
                    onChange={(e) => setForm({ ...form, account_id: e.target.value.replace(/\D/g, ""), api_key: e.target.value.replace(/\D/g, "") })}
                  />
                  <p className="text-xs text-muted-foreground">The official Client API uses the numeric account login for read-only account and trade-history data.</p>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="api-key">API Key *</Label>
                    <Input
                      id="api-key"
                      type="password"
                      placeholder="Enter API key"
                      value={form.api_key}
                      onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="api-secret">API Secret *</Label>
                    <Input
                      id="api-secret"
                      type="password"
                      placeholder="Enter API secret"
                      value={form.api_secret}
                      onChange={(e) => setForm({ ...form, api_secret: e.target.value })}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                id="testnet"
                checked={isForex ? false : form.is_testnet}
                onCheckedChange={(checked) => setForm({ ...form, is_testnet: checked })}
                disabled={isForex}
              />
              <Label htmlFor="testnet">{isForex ? "Forex read-only account (no testnet toggle)" : "Use Testnet (for testing only)"}</Label>
            </div>
          </TabsContent>

          <TabsContent value="api" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="api-type">API Type</Label>
                <Select value={form.api_type} onValueChange={(value) => setForm({ ...form, api_type: value })}>
                  <SelectTrigger id="api-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedExchangeConfig?.api_types.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        <div className="flex flex-col">
                          <span className="font-medium">{type.label}</span>
                          <span className="text-xs text-muted-foreground">{type.description}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedApiType && (
                  <div className="p-2 bg-muted rounded-md">
                    <p className="text-xs font-medium mb-1">{selectedApiType.description}</p>
                    <div className="flex flex-wrap gap-1">
                      {selectedApiType.capabilities.map((cap) => (
                        <Badge key={cap} variant="secondary" className="text-xs">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="connection-method">Connection Method</Label>
                <Select
                  value={form.connection_method}
                  onValueChange={(value) => setForm({
                    ...form,
                    connection_method: value,
                    connection_library: isForex ? "native-http" : form.connection_library,
                  })}
                >
                  <SelectTrigger id="connection-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedExchangeConfig?.connection_methods
                      .sort((a, b) => a.priority - b.priority)
                      .map((method) => (
                        <SelectItem key={method.value} value={method.value}>
                          <div className="flex flex-col">
                            <span className="font-medium">{method.label}</span>
                            <span className="text-xs text-muted-foreground">{method.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {selectedConnectionMethod && (
                  <div className="p-2 bg-muted rounded-md">
                    <p className="text-xs font-medium">{selectedConnectionMethod.description}</p>
                    {selectedConnectionMethod.packageName && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Package: {selectedConnectionMethod.packageName}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-2 col-span-2">
                {isForex && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    "InstaForex HTTP integration is read-only. Quotes and charts use the official feeds; account reads use the Client API, and order execution is unavailable."
                  </div>
                )}
                <Label htmlFor="connection-library">Connection Library</Label>
                <Input
                  id="connection-library"
                  placeholder="e.g., pybit, ccxt"
                  value={form.connection_library}
                  onChange={(e) => setForm({ ...form, connection_library: e.target.value })}
                  disabled={isForex}
                />
                <p className="text-xs text-muted-foreground">{isForex ? "Native HTTP connector for the official InstaForex feeds (read-only)" : "Library or SDK to use for API communication"}</p>
              </div>

              {isForex && (
                <div className="col-span-2 rounded-lg border border-cyan-200 bg-cyan-50/50 p-4 space-y-4 dark:border-cyan-900 dark:bg-cyan-950/20">
                  <div>
                    <p className="font-medium text-cyan-950 dark:text-cyan-100">InstaForex Forex market settings</p>
                    <p className="mt-1 text-xs text-cyan-900/80 dark:text-cyan-200/80">The connector uses official quotes/charts, live broker bid/ask spread, Forex lot units, and the higher default average count. Official HTTP order execution remains unavailable.</p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5"><Label htmlFor="symbol-suffix">Broker symbol suffix (optional)</Label><Input id="symbol-suffix" value={form.symbol_suffix} onChange={(e) => setForm({ ...form, symbol_suffix: e.target.value })} placeholder="e.g. .fx or .m" /></div>
                    <div className="space-y-1.5"><Label htmlFor="positions-average">Average count</Label><Input id="positions-average" type="number" min="1" max="600" value={form.positions_average} onChange={(e) => setForm({ ...form, positions_average: e.target.value })} /></div>
                    <div className="space-y-1.5"><Label htmlFor="lot-size">Contract size / lot</Label><Input id="lot-size" type="number" min="1" value={form.lot_size} onChange={(e) => setForm({ ...form, lot_size: e.target.value })} /></div>
                    <div className="space-y-1.5"><Label htmlFor="max-spread-pips">Max spread (pips)</Label><Input id="max-spread-pips" type="number" min="0" step="0.1" value={form.max_spread_pips} onChange={(e) => setForm({ ...form, max_spread_pips: e.target.value })} /></div>
                    <div className="space-y-1.5"><Label htmlFor="position-cost-percent">Fallback PositionCost %</Label><Input id="position-cost-percent" type="number" min="0.02" max="1" step="0.01" value={form.position_cost_percent} onChange={(e) => setForm({ ...form, position_cost_percent: e.target.value })} /></div>
                    <div className="space-y-1.5"><Label htmlFor="spread-buffer-pips">Spread buffer (pips)</Label><Input id="spread-buffer-pips" type="number" min="0" step="0.1" value={form.spread_buffer_pips} onChange={(e) => setForm({ ...form, spread_buffer_pips: e.target.value })} /></div>
                    <div className="space-y-1.5"><Label htmlFor="spread-multiplier">Spread multiplier</Label><Input id="spread-multiplier" type="number" min="0" step="0.1" value={form.spread_multiplier} onChange={(e) => setForm({ ...form, spread_multiplier: e.target.value })} /></div>
                  </div>
                </div>
              )}
            </div>

            {selectedExchangeConfig && (
              <div className="p-3 bg-muted rounded-md space-y-2">
                <h4 className="text-sm font-medium">Rate Limits</h4>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Per Second:</span>{" "}
                    <span className="font-medium">{selectedExchangeConfig.rate_limits.requests_per_second}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Per Minute:</span>{" "}
                    <span className="font-medium">{selectedExchangeConfig.rate_limits.requests_per_minute}</span>
                  </div>
                </div>
                <a
                  href={selectedExchangeConfig.docs_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-block"
                >
                  View API Documentation →
                </a>
              </div>
            )}
          </TabsContent>

          <TabsContent value="trading" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="margin-type">Margin Type</Label>
                <Select value={form.margin_type} onValueChange={(value) => setForm({ ...form, margin_type: value })} disabled={isForex}>
                  <SelectTrigger id="margin-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cross">
                      <div className="flex flex-col">
                        <span className="font-medium">Cross Margin</span>
                        <span className="text-xs text-muted-foreground">Share margin across all positions</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="isolated">
                      <div className="flex flex-col">
                        <span className="font-medium">Isolated Margin</span>
                        <span className="text-xs text-muted-foreground">Separate margin per position</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="position-mode">Position Mode</Label>
                <Select
                  value={form.position_mode}
                  onValueChange={(value) => setForm({ ...form, position_mode: value })}
                  disabled={isForex}
                >
                  <SelectTrigger id="position-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hedge">
                      <div className="flex flex-col">
                        <span className="font-medium">Hedge Mode</span>
                        <span className="text-xs text-muted-foreground">Hold long and short simultaneously</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="one-way">
                      <div className="flex flex-col">
                        <span className="font-medium">One-Way Mode</span>
                        <span className="text-xs text-muted-foreground">Single direction per symbol</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="p-4 bg-muted/50 rounded-lg space-y-2">
              <h4 className="text-sm font-medium">Trading Configuration Summary</h4>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Exchange:</span>{" "}
                  <span className="font-medium">{selectedExchangeConfig?.name}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Market:</span>{" "}
                  <span className="font-medium">{isForex ? "Forex" : "Crypto"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">API Type:</span>{" "}
                  <span className="font-medium">{selectedApiType?.label}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Margin:</span>{" "}
                  <span className="font-medium capitalize">{form.margin_type}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Position:</span>{" "}
                  <span className="font-medium capitalize">{form.position_mode}</span>
                </div>
              </div>
              {isForex && <p className="text-xs text-amber-700">Read-only data connection; this dialog cannot enable Forex order execution.</p>}
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                {connection ? "Update" : "Add"} Connection
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
