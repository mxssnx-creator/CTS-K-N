/**
 * Volume Calculator - Ratio-Based System
 * 
 * Calculates position volume based on ratio multipliers where ratio 1.0 = system default
 * 
 * RATIO-BASED SYSTEM:
 *   - Ratio 1.0 (default): Base volume for live trading (system internal default)
 *   - Ratio > 1.0: Higher volumes for strategy evaluations and optimizations
 *   - Channel/base ratios below 1.0 are normalized to identity 1.0
 *   - Final calculated quantity = base_notional * ratios, then venue floors
 *   - Strategy internal calculations use higher ratios
 * 
 * Features:
 *   - Position volume calculated from the immutable Base identity, leverage, and risk management
 *   - Volume calculated at Exchange level when actual orders are executed
 *   - ONLY used by ExchangePositionManager
 *   - Base/Main/Real pseudo positions use counts and ratios (no absolute volumes)
 *   - Per-engine volume factors (main_volume_factor, preset_volume_factor) apply to live orders
 *   - The shared system ratio is identity and never silently changes quantity
 * 
 * Redis-native: All data stored in Redis via redis-db
 */

import { initRedis, getSettings, getAppSettings, setSettings, getRedisClient, getConnection } from "@/lib/redis-db"
import { getMaxLeverageForExchange } from "@/lib/leverage-policy"
import {
  applySystemVolumeFactor,
  BASE_VOLUME_RATIO,
  DEFAULT_VOLUME_STEP_RATIO,
  MAX_VOLUME_STEP_RATIO,
  MIN_VOLUME_STEP_RATIO,
  SYSTEM_VOLUME_FACTOR_MULTIPLIER,
} from "@/lib/constants"
import { getCanonicalConnectionSettingsOverlay, overlayNonEmpty } from "@/lib/connection-settings-overlay"
import { normalizePositionCostPercent, POSITION_COST_PERCENT_DEFAULT } from "@/lib/position-cost"
import {
  DEFAULT_FOREX_LOT_SIZE,
  DEFAULT_FOREX_POSITIONS_AVERAGE,
  forexNotionalUsd,
  isForexSymbol,
} from "@/lib/forex-market"
import { normalizeMarketType, type MarketType } from "@/lib/market-types"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import {
  normalizeExchangeQuantityRules,
  roundQuantityDown,
  resolveExecutableQuantity,
} from "@/lib/order-quantity"
import { tradingPairKey } from "@/lib/trading-pair-keys"

/** Hard upper bound for one live/VST position relative to its PositionCost budget. */
export const MAX_LIVE_POSITION_COST_MULTIPLIER = 5

/**
 * Volume calculations are diagnostics, not trading state. Keep a useful
 * audit window without creating one Redis detail key per calculation forever.
 */
export const VOLUME_CALC_LOG_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const VOLUME_CALC_LOG_INDEX_LIMIT = 500

interface VolumeCalculationParams {
  baseVolumeFactor?: number
  positionsAverage?: number
  riskPercentage?: number
  maxLeverage?: number
  /** Legacy pure input: fraction of balance (0.001 = 0.1%). */
  positionCost?: number
  /** Canonical operator input: UI percent (0.1 = 0.1%). */
  positionCostPercent?: number
  /** Explicit fraction form for callers that already converted percent/100. */
  positionCostFraction?: number
  accountBalance: number
  currentPrice: number
  leverage?: number
  exchangeMinVolume?: number
  exchangeMinNotionalUsdt?: number
  quantityStep?: number
  quantityPrecision?: number
  marketType?: MarketType
  lotSize?: number
  /** Canonical pair key used for USD notional conversion of Forex lots. */
  symbol?: string
  /** Quote-currency → USD rate for cross pairs, when available. */
  quoteToUsdRate?: number

  // ── LIVE-only channel factor (pseudo positions retain channel identity) ──
  //
  // RATIO-BASED VOLUME SYSTEM:
  //   - Channel ratio 1.0 = identity
  //   - Live exchange volume = base_notional * ratio * channel factor
  //   - Strategy internal calcs can use higher ratios for optimization
  //
  // Which Trade Engine is asking for sizing? Determines which volume-
  // factor multiplier (if any) is applied to the LIVE notional.
  //
  // The Strategy stack (Base/Main/Real pseudo positions) is RATIO-based
  // and count-driven per spec — it MUST NOT receive a Main/Preset/Signal
  // channel multiplier. Strategy callers leave `tradeMode` undefined and
  // keep that channel path at identity.
  //
  //   - `"main"`   → multiply by `mainVolumeFactor`   (a.k.a. live_volume_factor)
  //   - `"preset"` → multiply by `presetVolumeFactor` (a.k.a. preset_volume_factor)
  //   - omitted    → no engine multiplier (pseudo-position / Strategy path)
  tradeMode?: "main" | "preset"

  // Volume scaling factors applied at the LIVE-EXECUTION layer only.
  // These are RATIO MULTIPLIERS where:
  //   - 1.0 = system baseline (no scaling from engine factor)
  //   - >1.0 = higher volume for aggregated/optimized orders
  //   - <1.0 = invalid for channel/base ratios and normalized to 1.0
  // Live-engine factors default to identity ratio 1 when missing or invalid.
  // Bounded to [1, 10] inside `calculatePositionVolume` so a misconfigured
  // setting can never blow out a live order to 100× the intended size.
  mainVolumeFactor?: number
  presetVolumeFactor?: number
  /** Signal-specific Main-channel factor; identity 1 for non-Signal orders. */
  signalVolumeFactor?: number
  /** Originating indication type. Only `signal` activates signalVolumeFactor. */
  indicationType?: string
  // Adjust-type variant multiplier: block=1.5-2.0, dca=0.5, others=1.0.
  // Applied after liveEngineFactor; absent/undefined → 1.0 (no scaling).
  // Clamped to [0.01, 5] unless an explicitly combined Position-Count target
  // is being materialized. Unlike channel/base ratios, this explicitly
  // supports independent low-volume Position-Count/DCA variants.
  // RATIO-based: 1.0 = no variant scaling, >1 = larger, <1 = smaller
  sizeMultiplier?: number
  /**
   * Combined Position-Count rows represent the sum of every valid Set and may
   * legitimately exceed the ordinary variant cap. Callers must opt in only
   * after resolving that physical aggregate target.
   */
  allowUnboundedVariantMultiplier?: boolean
}

export interface VolumeCalculationResult {
  calculatedVolume?: number
  finalVolume?: number
  leverage: number
  positionSize?: number
  volume?: number
  volumeUsd?: number
  volumeAdjusted: boolean
  adjustmentReason?: string
  riskAmount?: number
  /** Pure strategy notional before exchange/universal minimum floors. */
  intendedNotionalUsd?: number
  /** Exchange/universal minimum notional implied by the effective quantity floor. */
  exchangeMinNotionalUsd?: number
  /** Raw sizing inputs echoed for live-stage risk validation and diagnostics. */
  accountBalance?: number
  positionCost?: number
  positionCostPercent?: number
  positionsAverage?: number
  liveEngineFactor?: number
  signalVolumeFactor?: number
  sizeMultiplier?: number
  exchangeMinVolume?: number
  volumeStepRatio?: number
  volumeBalanceAnchor?: number
  volumeBalanceEffective?: number
  /** Explicit global post-factor execution ratio, surfaced to UI/statistics. */
  systemVolumeFactor?: number
  /** True when sizing used the emergency balance fallback instead of venue data. */
  balanceIsFallback?: boolean
  quantityStep?: number
  quantityPrecision?: number
  exchangeMinQuantity?: number
  volumeKind?: "base" | "lots"
  lotSize?: number
  /** False means Forex sizing was refused because USD conversion was absent. */
  conversionAvailable?: boolean
  conversionSource?: string
  /** Maximum USD notional approved for this live/VST execution. */
  maxExecutionNotionalUsd?: number
  /** True when a channel/variant aggregate was reduced to the hard cap. */
  liveMultiplierCapped?: boolean
}


export class VolumeCalculator {
  /**
   * Universal hard floor: $5 notional covers BingX/Binance/Bybit/OKX minimums
   * while remaining conservative for margin constraints. The 101400 auto-correction
   * handler persists exact per-pair minimums to `settings:trading_pair:{symbol}`,
   * so this floor is mainly the safety net for first-time pairs.
   *
   * BingX perpetual minimum maintenance margin per position is approximately $5
   * notional at 10x leverage → $0.50 margin. At $3 notional BingX returns
   * code=101204 (Insufficient margin) on pairs like XRP, SOL, BNB.
   */
  static readonly UNIVERSAL_MIN_NOTIONAL_USD = 5

  /**
   * Fetch account balance and compute the leverage safety cap.
   *
   * Extracted into its own method so the balance-fetch + cap logic lives in
   * a single clean scope with no `let` mutation — eliminating the TDZ risk
   * that existed when this logic was inlined inside calculateVolumeForConnection.
   *
   * Returns { accountBalance, maxLeverage } — both always finite numbers.
   */
  static async resolveBalanceAndLeverage(
    connectionId: string,
    rawLeverage: number,
  ): Promise<{ accountBalance: number; maxLeverage: number; balanceIsFallback: boolean }> {
    // Fetch balance — default $10,000 so the leverage cap is benign when
    // the exchange API is unreachable or the connection has no real key.
    let balance = 10000
    let balanceIsFallback = true
    try {
      const cachedBalance = await getSettings(`connection_balance:${connectionId}`)
      if (cachedBalance?.balance && parseFloat(String(cachedBalance.balance)) > 0) {
        balance = parseFloat(String(cachedBalance.balance))
        // Old cache entries predate the provenance marker. Treat them as
        // unverified rather than allowing a stale/default balance to authorize
        // a live order. A fresh connector read below is the only path that can
        // explicitly mark the value authoritative.
        const fallbackMarker = cachedBalance.is_fallback ?? cachedBalance.isFallback
        balanceIsFallback = fallbackMarker === undefined
          ? true
          : isTruthyFlag(fallbackMarker)
      } else {
        const connection = await getConnection(connectionId)
        const connectionMarketType = normalizeMarketType(
          connection?.market_type ?? connection?.asset_class,
          connection?.exchange,
        )
        const connectionAccountId = String(connection?.account_id ?? connection?.api_key ?? "").trim()
        const canReadBalance = connectionMarketType === "forex"
          ? /^[0-9]{4,12}$/.test(connectionAccountId)
          : Boolean(
              connection?.api_key &&
              connection?.api_secret &&
              !connection.api_key.includes("PLACEHOLDER") &&
              connection.api_key.length >= 20,
            )
        if (canReadBalance) {
          const { createExchangeConnector } = await import("@/lib/exchange-connectors")
          const connector = await createExchangeConnector(connection.exchange, {
            apiKey: connectionMarketType === "forex" ? connectionAccountId : connection.api_key || "",
            apiSecret: connectionMarketType === "forex" ? "" : connection.api_secret || "",
            apiPassphrase: connectionMarketType === "forex" ? connection.api_passphrase : undefined,
            accountId: connectionMarketType === "forex" ? connectionAccountId : undefined,
            accountPassword: connectionMarketType === "forex" ? connection.account_password : undefined,
            accountServer: connectionMarketType === "forex" ? connection.account_server : undefined,
            bridgeUrl: connectionMarketType === "forex" ? connection.bridge_url : undefined,
            bridgeToken: connectionMarketType === "forex" ? connection.bridge_token : undefined,
            terminalPath: connectionMarketType === "forex" ? connection.terminal_path : undefined,
            apiBaseUrl: connection.api_base_url,
            quotesBaseUrl: connection.quotes_base_url,
            chartsUrl: connection.charts_url,
            executionMode: connectionMarketType === "forex" ? connection.execution_mode : undefined,
            forexExecutionMode: connectionMarketType === "forex" ? connection.forex_execution_mode : undefined,
            connectionMethod: connectionMarketType === "forex" ? connection.connection_method : undefined,
            connectionLibrary: connectionMarketType === "forex" ? connection.connection_library : undefined,
            readOnly: connectionMarketType === "forex"
              ? connection.read_only === true || connection.read_only === "1" || connection.read_only === "true"
              : undefined,
            apiType: connection.api_type,
            contractType: connection.contract_type,
            marketType: connectionMarketType,
            isTestnet: isTruthyFlag(connection.is_testnet),
          })
          try {
            const result = await connector.getBalance()
            if (result?.success && result?.balance && result.balance > 0) {
              balance = result.balance
              balanceIsFallback = false
            }
          } catch {
            // getBalance threw (e.g. 100421 timestamp error) — use the $10k default.
            // Fall through to cache write below so subsequent calls skip the live fetch.
          }
        }
        // Cache the resolved balance (real or fallback) so every subsequent live
        // dispatch in this cycle skips the getBalance() round-trip entirely.
        // TTL: 90 s — short enough that a real balance change is picked up within
        // two minutes, long enough to cover a full 15-symbol cycle at 1 Hz.
        await setSettings(`connection_balance:${connectionId}`, {
          balance,
          updated_at: new Date().toISOString(),
          is_fallback: balanceIsFallback,
        })
        // setSettings writes a hash and therefore cannot carry SET's EX
        // option. Apply the TTL explicitly so a crashed process cannot leave
        // an unbounded balance-cache key behind.
        await getRedisClient()
          .expire(`settings:connection_balance:${connectionId}`, 90)
          .catch(() => 0)
        // Optionally refresh the cache in the background after 90 s to avoid
        // every worker racing for the balance on the same expiry boundary.
        setTimeout(async () => {
          try {
            const { getRedisClient: _rc } = await import("@/lib/redis-db")
            await _rc().del(`settings:connection_balance:${connectionId}`)
          } catch { /* best-effort TTL reset */ }
        }, 90_000)
      }
    } catch {
      // Non-critical — fall back to the $10k default so volume is calculated.
    }

    // No balance-based leverage cap — operator policy is always-max-leverage.
    // The exchange setLeverage call clamps to the per-symbol bracket and the
    // 101204 auto-halve retry handles any remaining margin rejections.
    return { accountBalance: balance, maxLeverage: rawLeverage, balanceIsFallback }
  }

  /**
   * Calculate position volume with risk management (pure math, no DB).
   *
   * BEHAVIOR: minimum volume is ALWAYS enforced — never reject for "qty
   * too small". Three layers:
   *   1. Per-pair `exchangeMinVolume` (from trading_pair metadata)
   *   2. Universal $5-notional floor when no per-pair min is known
   *   3. Numeric safety: if math yields 0/NaN/Infinity (e.g. balance=0
   *      or currentPrice rounding), still emit at least layer 1 or 2.
   *
   * The result is flagged `volumeAdjusted: true` with an
   * `adjustmentReason` explaining the clamp so UI + logs show the user
   * exactly why the quantity doesn't match the pure math.
   */
  static calculatePositionVolume(params: VolumeCalculationParams): VolumeCalculationResult {
    const {
      positionsAverage,
      riskPercentage,
      maxLeverage,
      positionCost,
      positionCostPercent,
      positionCostFraction,
      accountBalance,
      currentPrice,
      leverage = 1,
      exchangeMinVolume = 0,
      exchangeMinNotionalUsdt = 0,
      quantityStep,
      quantityPrecision,
      marketType: requestedMarketType,
      lotSize,
      symbol,
      quoteToUsdRate,
      tradeMode,
      mainVolumeFactor,
      presetVolumeFactor,
      signalVolumeFactor,
      indicationType,
      sizeMultiplier,
      allowUnboundedVariantMultiplier = false,
    } = params

    // Symbol inference is only a compatibility fallback for callers that
    // predate the marketType field. An explicit market type always wins, so
    // crypto symbols cannot be reclassified by a stale alias.
    const marketType = normalizeMarketType(
      requestedMarketType ?? (symbol && isForexSymbol(symbol) ? "forex" : "crypto"),
    )
    const isForex = marketType === "forex"
    const resolvedLotSize = isForex
      ? Math.max(1, Number(lotSize) || DEFAULT_FOREX_LOT_SIZE)
      : 1
    const configuredMinimum = Math.max(0, Number(exchangeMinVolume) || 0)
    const forexMinimumLots = isForex ? Math.max(0.01, configuredMinimum) : 0
    const forexLotStep = isForex
      ? Math.max(0.00000001, Number(quantityStep) > 0 ? Number(quantityStep) : 0.01)
      : 0
    const forexLotPrecision = isForex
      ? Math.max(0, Math.min(8, Number.isFinite(Number(quantityPrecision)) && Number(quantityPrecision) >= 0 ? Math.floor(Number(quantityPrecision)) : 2))
      : 0
    const forexNotionalPerLot = isForex && symbol
      ? forexNotionalUsd(1, currentPrice, symbol, resolvedLotSize, quoteToUsdRate)
      : 0
    const forexConversionAvailable = !isForex || (Boolean(symbol) && forexNotionalPerLot > 0)

    // Keep the unit conversion at the boundary. Internally all sizing uses a
    // fraction of balance, while settings and stats use UI percent values.
    // This prevents the common 0.1-versus-0.001 mistake from changing live
    // volume by 100x when a caller crosses an engine boundary.
    const resolvedPositionCostFraction = (() => {
      const explicitFraction = Number(positionCostFraction)
      if (Number.isFinite(explicitFraction) && explicitFraction > 0) return explicitFraction
      const percent = Number(positionCostPercent)
      if (Number.isFinite(percent) && percent > 0) return percent / 100
      const legacyFraction = Number(positionCost)
      return Number.isFinite(legacyFraction) && legacyFraction > 0 ? legacyFraction : 0
    })()
    const resolvedPositionCostPercent = resolvedPositionCostFraction * 100
    const systemVolumeFactor = Number(SYSTEM_VOLUME_FACTOR_MULTIPLIER)

    const quantityRules = normalizeExchangeQuantityRules({
      quantityStep,
      quantityPrecision,
      minQuantity: isForex ? forexMinimumLots : exchangeMinVolume,
      minNotionalUsdt: exchangeMinNotionalUsdt,
    })

    // ── Resolve the engine-specific channel factor (Live-only) ────
    //
    // RATIO-BASED SYSTEM:
    //   - Default channel ratio = 1.0
    //   - Live orders = base_notional * channel factor * variant * system ratio
    //   - Strategy calcs retain channel identity and use the same ratio basis
    //
    // Only applied when the CALLER explicitly identifies as a Live trade
    // engine via `tradeMode`. The Strategy stack (Base/Main/Real pseudo
    // positions) never sets `tradeMode`, so it always sees a 1.0 channel
    // identity multiplier here.
    //
    // Ratio multipliers:
    //   - 1.0 = identity (default, no engine scaling)
    //   - >1.0 = higher volumes for aggregation and optimization
    //   - <1.0 = invalid for base/channel ratios and normalized to 1.0
    //
    // Bounds: [1, 10]. Ratio 1 is the exchange-minimum baseline.
    // Sub-unit Position-Count coordination is a separate variant multiplier
    // and is retained by `clampVariant`; it must never leak into a channel
    // factor or silently reduce the global basis. Clipping here means the
    // slider's UI range (1-10x) is also enforced server-side even if a
    // malformed POST bypasses the UI.
    const clampFactor = (raw: number | undefined): number => {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) return 1
      return Math.max(1, Math.min(10, n))
    }
    const channelVolumeFactor =
      tradeMode === "preset" ? clampFactor(presetVolumeFactor)
      : tradeMode === "main" ? clampFactor(mainVolumeFactor)
      : 1  // Strategy / pseudo-position path → identity (ratio-only)
    const effectiveSignalVolumeFactor =
      tradeMode === "main" && String(indicationType || "").trim().toLowerCase() === "signal"
        ? clampFactor(signalVolumeFactor)
        : 1
    // Base coordination remains exactly 1. Main/Preset and Signal are
    // independent, explicit ratios applied once at the Live boundary.
    const liveEngineFactor = channelVolumeFactor * effectiveSignalVolumeFactor

    // ── Resolve the effective minimum that MUST be honored ──────────
    // Take the larger of the per-pair minimum and the universal $5
    // notional floor. Guarantees we always have a positive lower bound
    // as long as `currentPrice > 0` (the upstream caller is responsible
    // for rejecting price=0 before we get here).
    const universalMinFromNotional =
      currentPrice > 0
        ? VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD / currentPrice
        : 0
    const exchangeNotionalMinVolume = currentPrice > 0 && exchangeMinNotionalUsdt > 0
      ? exchangeMinNotionalUsdt / currentPrice
      : 0
    const effectiveMin = isForex
      ? (forexConversionAvailable ? forexMinimumLots : 0)
      : Math.max(
          exchangeMinVolume || 0,
          exchangeNotionalMinVolume,
          universalMinFromNotional,
        )

    const roundForexLotsUp = (raw: number): number => {
      if (!isForex) return raw
      const safeRaw = Number.isFinite(raw) && raw > 0 ? raw : 0
      const stepped = Math.ceil((Math.max(safeRaw, forexMinimumLots) - Number.EPSILON) / forexLotStep) * forexLotStep
      return Number(Math.max(forexMinimumLots, stepped).toFixed(forexLotPrecision))
    }

    const executableQuantity = (raw: number): { quantity: number; adjusted: boolean; reason?: string } => {
      if (!isForex) {
        return resolveExecutableQuantity(
          raw,
          currentPrice,
          quantityRules,
          { universalMinNotionalUsdt: VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD },
        )
      }
      if (!forexConversionAvailable) {
        return {
          quantity: 0,
          adjusted: true,
          reason: `Forex USD conversion rate unavailable for ${symbol}; refusing to synthesize a lot quantity`,
        }
      }
      const quantity = roundForexLotsUp(raw)
      return {
        quantity,
        adjusted: quantity !== raw,
        reason: quantity !== raw
          ? `Forex volume rounded up to ${quantity.toFixed(forexLotPrecision)} lots on a ${forexLotStep.toFixed(forexLotPrecision)}-lot step`
          : undefined,
      }
    }

    const volumeNotional = (quantity: number): number =>
      isForex
        ? forexNotionalUsd(Math.max(0, Number(quantity) || 0), currentPrice, symbol, resolvedLotSize, quoteToUsdRate)
        : Math.max(0, Number(quantity) || 0) * currentPrice

    /**
     * Round a live/VST quantity down to the approved notional ceiling. Venue
     * minimums may round an entry upward, but they must never enlarge a live
     * order beyond the risk budget. If the minimum itself does not fit, fail
     * closed with quantity zero so the caller can record a blocked entry.
     */
    const executableQuantityAtMost = (
      raw: number,
      maxNotionalUsd: number,
    ): { quantity: number; adjusted: boolean; reason?: string } => {
      if (!(maxNotionalUsd > 0) || !(currentPrice > 0)) {
        return { quantity: 0, adjusted: true, reason: "Live exposure ceiling is unavailable" }
      }
      const safeRaw = Number.isFinite(raw) && raw > 0 ? raw : 0
      const minimum = isForex
        ? roundForexLotsUp(effectiveMin)
        : resolveExecutableQuantity(
            Math.max(effectiveMin, 0),
            currentPrice,
            quantityRules,
            { universalMinNotionalUsdt: VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD },
          ).quantity
      const maxQuantity = isForex
        ? roundQuantityDown(maxNotionalUsd / Math.max(forexNotionalPerLot, Number.EPSILON), {
            quantityStep: forexLotStep,
            quantityPrecision: forexLotPrecision,
          })
        : roundQuantityDown(maxNotionalUsd / currentPrice, quantityRules)
      if (!(maxQuantity > 0) || maxQuantity + Number.EPSILON < minimum) {
        return {
          quantity: 0,
          adjusted: true,
          reason: `Live exposure ceiling ${maxNotionalUsd.toFixed(2)} USD is below the executable minimum`,
        }
      }

      // Preserve the normal entry-rounding contract while the requested
      // quantity is already below the ceiling. Only a quantity that actually
      // crosses the ceiling must be rounded down; otherwise a harmless
      // 0.545-lot request would become 0.54 lots even though 0.55 still fits
      // inside the approved notional budget.
      const crossesCeiling = safeRaw > maxQuantity + Number.EPSILON
      const candidate = crossesCeiling
        ? (isForex
            ? roundQuantityDown(maxQuantity, {
                quantityStep: forexLotStep,
                quantityPrecision: forexLotPrecision,
              })
            : roundQuantityDown(maxQuantity, quantityRules))
        : executableQuantity(safeRaw).quantity
      if (!(candidate > 0) || candidate + Number.EPSILON < minimum || volumeNotional(candidate) > maxNotionalUsd + 1e-8) {
        return {
          quantity: 0,
          adjusted: true,
          reason: `Live quantity cannot satisfy the ${maxNotionalUsd.toFixed(2)} USD exposure ceiling after venue rounding`,
        }
      }
      return {
        quantity: candidate,
        adjusted: candidate !== raw,
        reason: candidate !== raw
          ? `live/VST quantity capped at ${volumeNotional(candidate).toFixed(2)} USD (${MAX_LIVE_POSITION_COST_MULTIPLIER}x PositionCost budget)`
          : undefined,
      }
    }

    /**
     * Final clamp: never return less than `effectiveMin`, never NaN,
     * never Infinity. Used by both the positionCost and the
     * risk-percentage branches below.
     */
    const clampUp = (raw: number): { final: number; adjusted: boolean; reason?: string } => {
      const safeRaw = Number.isFinite(raw) && raw > 0 ? raw : 0
      if (effectiveMin > 0 && safeRaw < effectiveMin) {
        const usingUniversalFallback = !isForex && exchangeMinVolume <= 0
        const minimumLabel = isForex
          ? `Forex minimum ${forexMinimumLots.toFixed(forexLotPrecision)} lots`
          : usingUniversalFallback
            ? `universal $${VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD} notional fallback`
            : "exchange minimum"
        return {
          final: effectiveMin,
          adjusted: true,
          reason:
            safeRaw <= 0
              ? `Sizing math yielded ${raw} — clamped up to enforced minimum ${effectiveMin.toFixed(isForex ? forexLotPrecision : 8)} (${minimumLabel}).`
              : `Calculated volume ${safeRaw.toFixed(8)} was below ${minimumLabel} ${effectiveMin.toFixed(isForex ? forexLotPrecision : 8)} — clamped up to minimum order size.`,
        }
      }
      return { final: safeRaw, adjusted: false }
    }

    if (resolvedPositionCostFraction > 0) {
      // ── positions_average + engine factor wired into positionCost ─────
      //
      // Previous formula:
      //   pos_usd = (balance × positionCost) / posAvg
      //
      // Final formula (with channel and variant ratios):
      //   pos_usd = balance × positionCost × liveEngineFactor × variant / posAvg
      //
      // With positionCost expressed as a fraction of balance (the
      // calling site already converts `pct/100`), the denominator
      // divides total budgeted exposure across the expected concurrent
      // position count. The `liveEngineFactor` (1.0 by default; tunable
      // per Trade Engine — Main vs. Preset — through the Settings
      // dialog) lets operators independently scale the notional of
      // Main-engine orders vs. Preset-engine orders without touching
      // positionCost (which controls the per-position BUDGET share —
      // the two knobs compose).
      //
      // Strategy / pseudo-position calls leave `tradeMode` undefined, so
      // `liveEngineFactor === 1`. They intentionally do not receive a
      // Main/Preset channel factor.
      // ── Adjust-type / Position-Count variant multiplier ───────────────
      // Ordinary Block/DCA variants stay bounded. Only a caller that has
      // resolved one physical combined Position-Count target may opt in to a
      // larger aggregate; that preserves every valid Set without allowing a
      // malformed standalone configuration to inflate an exchange order.
      // Applied after liveEngineFactor so both multipliers compose:
      //   notional = balance × positionCost × liveEngineFactor × variantMult
      //              × systemVolumeFactor / posAvg
      const clampVariant = (raw: number | undefined): number => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0) return 1
        const normalized = Math.max(0.01, n)
        return allowUnboundedVariantMultiplier ? normalized : Math.min(5, normalized)
      }
      const variantMult = clampVariant(sizeMultiplier)

      const posAvg = positionsAverage && positionsAverage > 0 ? positionsAverage : 1
      const positionCostNotionalUsd = (accountBalance * resolvedPositionCostFraction) / posAvg
      // The ratio-derived notional is authoritative in every mode. Exchange
      // minimums are floors only; they must never replace the requested base
      // notional, otherwise Main/Preset ratios become indistinguishable from
      // a minimum order and Block/DCA scaling is lost.
      const positionSizeUsd = applySystemVolumeFactor(
        positionCostNotionalUsd * liveEngineFactor * variantMult,
      )
      const maxExecutionNotionalUsd = (tradeMode === "main" || tradeMode === "preset")
        ? positionCostNotionalUsd * MAX_LIVE_POSITION_COST_MULTIPLIER
        : undefined
      const calculatedVolume = currentPrice > 0 && forexConversionAvailable
        ? positionSizeUsd / (isForex ? forexNotionalPerLot : currentPrice)
        : 0
      const executionNotional = maxExecutionNotionalUsd
        ? Math.min(positionSizeUsd, maxExecutionNotionalUsd)
        : positionSizeUsd
      const executionVolume = currentPrice > 0 && forexConversionAvailable
        ? executionNotional / (isForex ? forexNotionalPerLot : currentPrice)
        : 0
      const { final: clampedFinal, adjusted: clampedAdjusted, reason: clampReason } = clampUp(executionVolume)
      const executable = maxExecutionNotionalUsd
        ? executableQuantityAtMost(clampedFinal, maxExecutionNotionalUsd)
        : executableQuantity(clampedFinal)
      const capAdjusted = Boolean(maxExecutionNotionalUsd && positionSizeUsd > maxExecutionNotionalUsd)
      const final = executable.quantity
      const adjusted = clampedAdjusted || executable.adjusted || capAdjusted
      const reason = [clampReason, executable.reason].filter(Boolean).join("; ") || undefined

      // Surface multiplier provenance in the adjustment reason only when
      // the factor actually changed sizing (≠ 1.0) to avoid log spam.
      const factorReason =
        channelVolumeFactor !== 1 && tradeMode
          ? `${tradeMode}-engine volume factor ${channelVolumeFactor.toFixed(2)}x applied`
          : undefined
      const signalFactorReason =
        effectiveSignalVolumeFactor !== 1
          ? `Signal volume factor ${effectiveSignalVolumeFactor.toFixed(2)}x applied`
          : undefined
      const variantReason =
        variantMult !== 1
          ? `variant size multiplier ${variantMult.toFixed(2)}x applied (Block/DCA adjust-type)`
          : undefined
      const systemReason = systemVolumeFactor !== 1
        ? `system volume factor ${systemVolumeFactor.toFixed(2)}x applied`
        : undefined
      const composedReason = [
        adjusted ? reason : undefined,
        factorReason,
        signalFactorReason,
        variantReason,
        systemReason,
      ].filter(Boolean).join(" | ") || undefined

      return {
        calculatedVolume,
        finalVolume: final,
        volume: final,
        volumeUsd: volumeNotional(final),
        leverage,
        volumeAdjusted: adjusted || Boolean(factorReason || signalFactorReason || variantReason || systemReason),
        adjustmentReason: composedReason,
        intendedNotionalUsd: positionSizeUsd,
        exchangeMinNotionalUsd: volumeNotional(effectiveMin),
        accountBalance,
        positionCost: resolvedPositionCostFraction,
        positionCostPercent: resolvedPositionCostPercent,
        positionsAverage: posAvg,
        liveEngineFactor,
        signalVolumeFactor: effectiveSignalVolumeFactor,
        sizeMultiplier: variantMult,
        exchangeMinVolume: effectiveMin,
        systemVolumeFactor,
        quantityStep: quantityRules.quantityStep,
        quantityPrecision: quantityRules.quantityPrecision,
        exchangeMinQuantity: quantityRules.minQuantity,
        volumeKind: isForex ? "lots" : "base",
        lotSize: isForex ? resolvedLotSize : undefined,
        conversionAvailable: forexConversionAvailable,
        conversionSource: isForex && symbol
          ? (quoteToUsdRate && quoteToUsdRate > 0 ? "provided_quote_to_usd" : "pair_price_or_quote")
          : undefined,
        maxExecutionNotionalUsd,
        liveMultiplierCapped: capAdjusted,
      }
    }

    if (!riskPercentage || !positionsAverage) {
      throw new Error("riskPercentage and positionsAverage are required when positionCost is not provided")
    }

    const calculatedLeverage = maxLeverage || leverage
    const totalRiskAmount = accountBalance * (riskPercentage / 100)
    const riskPerPosition = totalRiskAmount / positionsAverage
    const rawVariant = Number(sizeMultiplier)
    const riskVariantMultiplier = Number.isFinite(rawVariant) && rawVariant > 0
      ? (allowUnboundedVariantMultiplier
          ? Math.max(0.01, rawVariant)
          : Math.min(5, Math.max(0.01, rawVariant)))
      : 1
    // The Base→Main→Real coordination basis is immutable identity.
    // Low-volume variants are represented exclusively by `sizeMultiplier`
    // (Position-Count/DCA), while Main/Preset/Signal are explicit Live
    // channels. The deprecated `baseVolumeFactor` input is accepted by the
    // public contract for snapshot compatibility but is intentionally ignored.
    const strategyBaseRatio = BASE_VOLUME_RATIO
    const adjustedRisk = applySystemVolumeFactor(
      riskPerPosition *
      strategyBaseRatio *
      liveEngineFactor *
      riskVariantMultiplier,
    )
    const positionSize = adjustedRisk / (riskPercentage / 100)
    const rawVolume = currentPrice > 0 && forexConversionAvailable
      ? positionSize / ((isForex ? forexNotionalPerLot : currentPrice) * calculatedLeverage)
      : 0

    const riskPositionCostBudget = (accountBalance * (riskPercentage / 100)) / positionsAverage
    const maxExecutionNotionalUsd = (tradeMode === "main" || tradeMode === "preset")
      ? riskPositionCostBudget * MAX_LIVE_POSITION_COST_MULTIPLIER
      : undefined
    const rawExecutionNotional = volumeNotional(rawVolume)
    const executionNotional = maxExecutionNotionalUsd
      ? Math.min(rawExecutionNotional, maxExecutionNotionalUsd)
      : rawExecutionNotional
    const executionVolume = currentPrice > 0 && forexConversionAvailable
      ? executionNotional / (isForex ? forexNotionalPerLot : currentPrice)
      : 0
    const { final: clampedFinal, adjusted: clampedAdjusted, reason: clampReason } = clampUp(executionVolume)
    const executable = maxExecutionNotionalUsd
      ? executableQuantityAtMost(clampedFinal, maxExecutionNotionalUsd)
      : executableQuantity(clampedFinal)
    const capAdjusted = Boolean(maxExecutionNotionalUsd && rawExecutionNotional > maxExecutionNotionalUsd)
    const final = executable.quantity
    const adjusted = clampedAdjusted || executable.adjusted || capAdjusted
    const reason = [clampReason, executable.reason].filter(Boolean).join("; ") || undefined

    return {
      calculatedVolume: rawVolume,
      finalVolume: final,
      volume: final,
      volumeUsd: volumeNotional(final),
      leverage: calculatedLeverage,
      positionSize,
      volumeAdjusted: adjusted || liveEngineFactor !== 1 || riskVariantMultiplier !== 1 || systemVolumeFactor !== 1,
      adjustmentReason: [
        reason,
        liveEngineFactor !== 1 ? `live channel ratio ${liveEngineFactor.toFixed(2)}x applied` : undefined,
        riskVariantMultiplier !== 1 ? `variant ratio ${riskVariantMultiplier.toFixed(2)}x applied` : undefined,
        systemVolumeFactor !== 1
          ? `system volume factor ${systemVolumeFactor.toFixed(2)}x applied`
          : undefined,
      ].filter(Boolean).join(" | ") || undefined,
      riskAmount: adjustedRisk,
      intendedNotionalUsd: volumeNotional(rawVolume),
      exchangeMinNotionalUsd: volumeNotional(effectiveMin),
      accountBalance,
      positionCost: resolvedPositionCostFraction || undefined,
      positionCostPercent: resolvedPositionCostPercent || undefined,
      positionsAverage,
      liveEngineFactor,
      signalVolumeFactor: effectiveSignalVolumeFactor,
      sizeMultiplier: riskVariantMultiplier,
        exchangeMinVolume: effectiveMin,
        systemVolumeFactor,
        quantityStep: quantityRules.quantityStep,
        quantityPrecision: quantityRules.quantityPrecision,
        exchangeMinQuantity: quantityRules.minQuantity,
        volumeKind: isForex ? "lots" : "base",
        lotSize: isForex ? resolvedLotSize : undefined,
        conversionAvailable: forexConversionAvailable,
      conversionSource: isForex && symbol
          ? (quoteToUsdRate && quoteToUsdRate > 0 ? "provided_quote_to_usd" : "pair_price_or_quote")
          : undefined,
      maxExecutionNotionalUsd,
      liveMultiplierCapped: capAdjusted,
    }
  }

  /**
   * Resolve the LIVE engine + scaling factor for a given connection.
   *
   * Used by `calculateVolumeForConnection` when the caller passes
   * `tradeMode` explicitly OR leaves it for auto-resolve from the
   * connection's `is_preset_trade` / `is_live_trade` flags. Two-tier
   * factor stack:
   *
   *   per-connection override (saved by VolumeConfigurationPanel)
   *   > global setting (Settings → Overall → Volume Configuration)
   *   > 1.0 (canonical exchange-minimum ratio when unset)
   *
   * Trade-mode resolution from connection flags:
   *   - `is_preset_trade === true` AND `is_live_trade !== true` → "preset"
   *   - else                                                    → "main"
   *
   * Both flags true is unusual but possible during transitions; we
   * pick "main" because it's the conservative default — Preset's
   * factor often applies more aggressive multipliers and we don't
   * want an in-flight toggle to silently up-size existing live orders.
   *
   * Strategy callers (pseudo-position-manager) DO NOT call this helper
   * — they pass NO `tradeMode` to `calculateVolumeForConnection`, so
   * the engine factor never applies to pseudo positions per spec.
   */
  static resolveLiveEngine(
    connection: Record<string, unknown> | null | undefined,
    appSettings: Record<string, unknown> | null | undefined,
  ): {
    tradeMode: "main" | "preset"
    mainVolumeFactor: number
    presetVolumeFactor: number
    signalVolumeFactor: number
    volumeStepRatio: number
  } {
    const truthy = (v: unknown) =>
      v === true || v === "true" || v === 1 || v === "1"
    const num = (v: unknown, fallback: number) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : fallback
    }
    const factor = (v: unknown): number => Math.max(1, Math.min(10, num(v, 1)))
    const conn = connection || {}
    const app = appSettings || {}

    const isPreset = truthy(conn["is_preset_trade"])
    const isLive   = truthy(conn["is_live_trade"])
    const tradeMode: "main" | "preset" = isPreset && !isLive ? "preset" : "main"

    // Priority stack for the main (live) volume factor:
    //   1. Per-connection override in connection:{id} hash  → `live_volume_factor`
    //   2. Per-connection override in connection_settings:{id} overlay → same key
    //      (when the caller passes the merged settings object as `appSettings`)
    //   3. Global app_settings hash written by migration 034 → `volume_factor_live`
    //   4. Legacy UI-named variant                          → `mainTradeVolumeFactor`
    //   5. Snake-case UI variant                            → `main_trade_volume_factor`
      //   6. Canonical identity ratio (1.0) when unset
    //
    // Key-name history:
    //   Migration 034 writes `volume_factor_live` to app_settings.
    //   The volume endpoint writes `live_volume_factor` to connection:{id}.
    //   Older UI code may have written `mainTradeVolumeFactor` / `main_trade_volume_factor`.
    //   All variants are tried so every write path resolves correctly.
    const mainVolumeFactor = factor(
      conn["live_volume_factor"]
        ?? app["live_volume_factor"]
        ?? app["volume_factor_live"]
        ?? app["mainTradeVolumeFactor"]
        ?? app["main_trade_volume_factor"],
    )

    // Priority stack for the preset volume factor:
    //   1. Per-connection `preset_volume_factor`
    //   2. Global `volume_factor_preset` (migration 034)
    //   3. Legacy UI variants
    //   4. Canonical identity ratio (1.0) when unset
    const presetVolumeFactor = factor(
      conn["preset_volume_factor"]
        ?? app["preset_volume_factor"]
        ?? app["volume_factor_preset"]
        ?? app["presetTradeVolumeFactor"]
        ?? app["preset_trade_volume_factor"],
    )

    const signalVolumeFactor = factor(
      conn["signal_volume_factor"]
        ?? app["signal_volume_factor"]
        ?? app["volume_factor_signal"]
        ?? app["signalTradeVolumeFactor"]
        ?? app["signal_trade_volume_factor"]
        ?? app["signalVolumeFactor"],
    )

    const rawStep = num(
      conn["volume_step_ratio"]
        ?? app["volume_step_ratio"]
        ?? app["volumeStepRatio"]
        ?? app["main_volume_step_ratio"]
        ?? app["mainVolumeStepRatio"],
      DEFAULT_VOLUME_STEP_RATIO,
    )
    const volumeStepRatio = Math.max(MIN_VOLUME_STEP_RATIO, Math.min(MAX_VOLUME_STEP_RATIO, rawStep))

    return {
      tradeMode,
      mainVolumeFactor,
      presetVolumeFactor,
      signalVolumeFactor,
      volumeStepRatio,
    }
  }


  /**
   * Keep live-order sizing stable across tiny balance changes. The first
   * balance seen for each connection/mode becomes the sizing anchor; profit
   * only increases order size after the balance crosses anchor × (1 + step).
   * Drawdowns reset the anchor downward immediately so sizing never keeps using
   * a stale higher balance. Example: anchor 100, step 0.6 → recalc at >= 160.
   */
  private static async resolveSteppedSizingBalance(
    connectionId: string,
    tradeMode: "main" | "preset" | undefined,
    accountBalance: number,
    volumeStepRatio: number,
  ): Promise<{ sizingBalance: number; anchorBalance: number }> {
    const safeBalance = Number.isFinite(accountBalance) && accountBalance > 0 ? accountBalance : 0
    if (safeBalance <= 0) return { sizingBalance: accountBalance, anchorBalance: accountBalance }

    const mode = tradeMode === "preset" ? "preset" : "main"
    const step = Math.max(MIN_VOLUME_STEP_RATIO, Math.min(MAX_VOLUME_STEP_RATIO, Number(volumeStepRatio) || DEFAULT_VOLUME_STEP_RATIO))
    const key = `connection_volume_step_anchor:${connectionId}:${mode}`

    try {
      const existing = await getSettings(key)
      const rawAnchor = typeof existing === "object" && existing ? (existing as any).anchor_balance : existing
      const anchor = Number(rawAnchor)

      if (!Number.isFinite(anchor) || anchor <= 0 || safeBalance < anchor || safeBalance >= anchor * (1 + step)) {
        await setSettings(key, {
          anchor_balance: safeBalance,
          step_ratio: step,
          updated_at: new Date().toISOString(),
        })
        return { sizingBalance: safeBalance, anchorBalance: safeBalance }
      }

      return { sizingBalance: anchor, anchorBalance: anchor }
    } catch {
      return { sizingBalance: safeBalance, anchorBalance: safeBalance }
    }
  }

  /**
   * Calculate volume for a specific connection and symbol using Redis settings.
   *
   * ── `tradeMode` is an explicit, opt-in parameter ───────────────────
   * `calculateVolumeForConnection` is called from BOTH:
   *   - the pseudo-position manager (Strategy stack — ratio-only, MUST
   *     NOT see a volume multiplier per spec), and
   *   - the live-stage executor (real exchange orders — MUST see the
   *     multiplier).
   *
   * Auto-resolving the engine would silently apply the factor to
   * Strategy pseudo positions too, violating the spec. Instead the
   * caller decides:
   *   - Pseudo-position-manager (Strategy): omits `tradeMode` →
   *     `liveEngineFactor = 1` → ratio-only preserved.
   *   - Live-stage: passes `tradeMode: "main" | "preset"` explicitly
   *     (resolved via `resolveLiveEngine` at callsite).
   *
   * This is enforced by the type system: the only way to apply an
   * engine factor is to pass `tradeMode`, which the Strategy stack
   * never does.
   */
  static async calculateVolumeForConnection(
    connectionId: string,
    symbol: string,
    currentPrice: number,
    options: {
      tradeMode?: "main" | "preset"
      /** Originating indication; `signal` applies the independent Signal factor. */
      indicationType?: string
      // Block/DCA variant multiplier from RealPosition.sizeMultiplier.
      // Absent / undefined → treated as 1.0 (no Block/DCA scaling).
      sizeMultiplier?: number
      /** See VolumeCalculationParams; reserved for a physical combined target. */
      allowUnboundedVariantMultiplier?: boolean
      /** Live bid/ask-aware PositionCost supplied by the market boundary. */
      positionCostPercentOverride?: number
      marketType?: MarketType
      lotSize?: number
      /** Quote-currency → USD rate for cross-pair Forex sizing. */
      quoteToUsdRate?: number
      // Live-stage margin retries can ask for a concrete leverage target
      // after an exchange-side leverage reduction. This keeps quantity
      // sizing coupled to the new margin target instead of blindly
      // resubmitting the quantity calculated for the original leverage.
      leverageOverride?: number
    } = {},
  ): Promise<VolumeCalculationResult> {
    try {
      await initRedis()

      // Get settings from Redis via the mirror-aware reader. The volume
      // calculator needs `exchangePositionCost`/`positionCost`,
      // `leveragePercentage`, and `useMaximalLeverage` from global app
      // settings plus per-connection overrides. Legacy defaults can remain in
      // `connection_settings:{id}` after migrations, while the Settings UI
      // writes the canonical mirror `settings:connection_settings:{id}`; read
      // both and let the canonical mirror win so live order sizing cannot fall
      // back to stale defaults in production.
      const globalSettings = (await getAppSettings()) || {}
      const connSettings = await getCanonicalConnectionSettingsOverlay(connectionId).catch(() => ({} as Record<string, string>))
      const connection = await getConnection(connectionId).catch(() => null)

      const settings: Record<string, unknown> = overlayNonEmpty(
        { ...(globalSettings as Record<string, unknown>) },
        connSettings as Record<string, unknown>,
      )
      if (connection) {
        const CONN_FIELDS_TO_OVERLAY = [
          "exchangePositionCost", "exchange_position_cost", "positionCost",
          "position_cost_percent", "positionCostPercent",
          "positions_average", "positionsAverage",
          "average_count", "averageCount", "market_type", "asset_class", "lot_size", "lotSize",
          "live_volume_factor", "preset_volume_factor", "signal_volume_factor", "volume_step_ratio",
          "leveragePercentage", "useMaximalLeverage",
        ] as const
        for (const f of CONN_FIELDS_TO_OVERLAY) {
          const v = (connection as Record<string, unknown>)[f]
          if (v !== undefined && v !== null && v !== "") settings[f] = v
        }
      }

      // ── Position cost resolution ─────────────────────────────────────
      // Priority: canonical per-connection settings overlay > connection:{id}
      // direct fields > global app_settings > built-in default 0.1%. Resolve
      // this AFTER all overlays; the old order calculated it before direct
      // connection/canonical settings were merged, producing default-sized live
      // orders despite saved operator sizing.
      const marketType = normalizeMarketType(
        options.marketType ?? settings.market_type ?? settings.asset_class,
        connection?.exchange,
      )
      const positionCostRaw =
        options.positionCostPercentOverride ??
        settings.exchangePositionCost ??
        settings.positionCost ??
        settings.exchange_position_cost ??
        settings.position_cost_percent ??
        settings.positionCostPercent ??
        POSITION_COST_PERCENT_DEFAULT
      const clampedPositionCostPercent = normalizePositionCostPercent(positionCostRaw)

      // ── Positions-average resolution ─────────────────────────────────
      const positionsAverage = (() => {
        const fallback = marketType === "forex" ? DEFAULT_FOREX_POSITIONS_AVERAGE : 2
        const raw = parseFloat(String(settings.positions_average ?? settings.positionsAverage ?? settings.average_count ?? fallback))
        return Number.isFinite(raw) && raw > 0 ? Math.min(600, raw) : fallback
      })()
      const lotSize = marketType === "forex"
        ? Math.max(1, Number(options.lotSize ?? settings.lot_size ?? settings.lotSize ?? connection?.lot_size) || DEFAULT_FOREX_LOT_SIZE)
        : undefined

      // Resolve effective leverage:
      //   useMaximalLeverage (default true)  → exchange predefinition max
      //   useMaximalLeverage false            → maxLeverage × (leveragePercentage / 100)
      //
      // Two downstream safety nets still apply after this:
      //   1. setLeverage(symbol, X) on the connector — venue clamps to per-symbol bracket.
      //   2. The live-stage 101204 auto-halve retry handles margin rejections.
      const exchangeMax   = getMaxLeverageForExchange(connection?.exchange)
      const useMaximal    = settings.useMaximalLeverage === true ||
                            settings.useMaximalLeverage === "true" ||
                            settings.useMaximalLeverage === undefined  // default on
      const levPct        = Math.max(1, Math.min(100, parseFloat(String(settings.leveragePercentage ?? "100"))))
      const overrideLeverage = Number(options.leverageOverride)
      const rawLeverage   = Number.isFinite(overrideLeverage) && overrideLeverage > 0
        ? Math.max(1, Math.floor(overrideLeverage))
        : useMaximal
          ? exchangeMax
          : Math.max(1, Math.round(exchangeMax * (levPct / 100)))

      // Delegate balance-fetch + leverage-cap to the helper method so the
      // logic lives in its own clean scope (no let mutation, no TDZ risk).
      const { accountBalance, maxLeverage, balanceIsFallback } =
        await VolumeCalculator.resolveBalanceAndLeverage(connectionId, rawLeverage)

      // ── Exchange minimum order size from Redis trading-pair metadata ─
      let tradingPair = await getRedisClient()
        .hgetall(tradingPairKey(symbol, connectionId))
        .catch(() => ({} as Record<string, unknown>))
      const exchangeMinVolume = tradingPair?.min_order_size
        ? parseFloat(String(tradingPair.min_order_size))
        : undefined

      // ── Resolve engine factor IFF caller asked for it ──────────────
      //
      // We only do the connection-flag resolution when the caller
      // passed `options.tradeMode`. The pseudo-position-manager call
      // omits it, so this entire block is skipped for Strategy callers
      // — they go through with no engine multiplier (the in-place
      // ratio-only behaviour the spec requires).
      //
      // Live-stage callers pass tradeMode: "main" | "preset" explicitly.
      // Strategy callers omit it → liveEngineFactor stays 1.0.
      let resolvedMode: "main" | "preset" | undefined = options.tradeMode
      let mainVolumeFactor = 1
      let presetVolumeFactor = 1
      let signalVolumeFactor = 1
      let volumeStepRatio = DEFAULT_VOLUME_STEP_RATIO
      if (resolvedMode === "main" || resolvedMode === "preset") {
        // Pass BOTH the connection record (has live_volume_factor written
        // by the volume endpoint) AND the merged settings object (has
        // live_volume_factor from connection_settings overlay + global
        // volume_factor_live from app_settings) so resolveLiveEngine
        // can find the factor from whichever write path was used.
        const resolved = VolumeCalculator.resolveLiveEngine(connection, settings)
        mainVolumeFactor = resolved.mainVolumeFactor
        presetVolumeFactor = resolved.presetVolumeFactor
        signalVolumeFactor = resolved.signalVolumeFactor
        volumeStepRatio = resolved.volumeStepRatio
        // We honour the CALLER's explicit mode; resolveLiveEngine's
        // tradeMode result is informational here (used only when the
        // caller did not specify).
      }

      const steppedBalance = resolvedMode
        ? await VolumeCalculator.resolveSteppedSizingBalance(
            connectionId,
            resolvedMode,
            accountBalance,
            volumeStepRatio,
          )
        : { sizingBalance: accountBalance, anchorBalance: accountBalance }

      const result = this.calculatePositionVolume({
        positionCostPercent: clampedPositionCostPercent,
        positionsAverage,
        accountBalance: steppedBalance.sizingBalance,
        currentPrice,
        leverage: maxLeverage,
        exchangeMinVolume,
        exchangeMinNotionalUsdt: Number(
          tradingPair?.min_notional_usdt ??
          tradingPair?.minNotionalUsdt ??
          tradingPair?.min_notional ??
          tradingPair?.minNotional ??
          0,
        ) || 0,
        quantityStep: Number(
          tradingPair?.quantity_step ??
          tradingPair?.quantityStep ??
          tradingPair?.step_size ??
          0,
        ) || undefined,
        quantityPrecision: Number(
          tradingPair?.quantity_precision ??
          tradingPair?.quantityPrecision ??
          0,
        ) || undefined,
        tradeMode: resolvedMode,
        mainVolumeFactor,
        presetVolumeFactor,
        signalVolumeFactor,
        indicationType: options.indicationType,
        // Variant multiplier forwarded from the callsite (Block/DCA sizing).
        sizeMultiplier: options.sizeMultiplier,
        allowUnboundedVariantMultiplier: options.allowUnboundedVariantMultiplier === true,
        marketType,
        lotSize,
        symbol,
        quoteToUsdRate: options.quoteToUsdRate,
      })

      result.accountBalance = steppedBalance.sizingBalance
      result.volumeBalanceEffective = steppedBalance.sizingBalance
      result.volumeBalanceAnchor = steppedBalance.anchorBalance
      result.volumeStepRatio = volumeStepRatio
      result.balanceIsFallback = balanceIsFallback

      return result
    } catch (error) {
      console.error("[v0] Failed to calculate volume for connection:", error)
      throw error
    }
  }

  /**
   * Log volume calculation to Redis
   */
  static async logVolumeCalculation(
    connectionId: string,
    symbol: string,
    calculation: VolumeCalculationResult,
  ): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      const logId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const logKey = `volume_calc:${connectionId}:${logId}`

      await client.set(logKey, JSON.stringify({
        connection_id: connectionId,
        symbol,
        leverage: calculation.leverage,
        calculated_volume: calculation.calculatedVolume,
        final_volume: calculation.finalVolume || calculation.volume,
        volume_usd: calculation.volumeUsd,
        volume_adjusted: calculation.volumeAdjusted,
        adjustment_reason: calculation.adjustmentReason || null,
        intended_notional_usd: calculation.intendedNotionalUsd,
        exchange_min_notional_usd: calculation.exchangeMinNotionalUsd,
        account_balance: calculation.accountBalance,
        balance_is_fallback: calculation.balanceIsFallback === true,
        position_cost: calculation.positionCost,
        position_cost_percent: calculation.positionCostPercent,
        positions_average: calculation.positionsAverage,
        live_engine_factor: calculation.liveEngineFactor,
        signal_volume_factor: calculation.signalVolumeFactor,
        size_multiplier: calculation.sizeMultiplier,
        volume_step_ratio: calculation.volumeStepRatio,
        volume_balance_anchor: calculation.volumeBalanceAnchor,
        volume_balance_effective: calculation.volumeBalanceEffective,
        quantity_step: calculation.quantityStep,
        quantity_precision: calculation.quantityPrecision,
        exchange_min_quantity: calculation.exchangeMinQuantity,
        volume_kind: calculation.volumeKind,
        lot_size: calculation.lotSize,
        max_execution_notional_usd: calculation.maxExecutionNotionalUsd,
        live_multiplier_capped: calculation.liveMultiplierCapped === true,
        created_at: new Date().toISOString(),
      }), { EX: VOLUME_CALC_LOG_RETENTION_SECONDS })

      // Store in Redis list instead of sorted set (Upstash doesn't support zadd)
      const volumeCalcsKey = `volume_calcs:${connectionId}`
      let volumeCalcs: string[] = []
      
      const existing = await client.get(volumeCalcsKey)
      if (existing) {
        try {
          const parsed = JSON.parse(existing)
          volumeCalcs = Array.isArray(parsed)
            ? parsed.map((value) => String(value)).filter(Boolean)
            : []
        } catch { volumeCalcs = [] }
      }
      
      // Prepend new entry
      volumeCalcs.unshift(logId)
      
      // Trim the index and eagerly delete detail keys that just fell out of
      // it. The detail TTL remains the safety net for orphaned/legacy keys.
      const evictedLogIds = volumeCalcs.length > VOLUME_CALC_LOG_INDEX_LIMIT
        ? volumeCalcs.slice(VOLUME_CALC_LOG_INDEX_LIMIT)
        : []
      if (evictedLogIds.length > 0) {
        await client.del(...evictedLogIds.map((id) => `volume_calc:${connectionId}:${id}`)).catch(() => 0)
        volumeCalcs = volumeCalcs.slice(0, VOLUME_CALC_LOG_INDEX_LIMIT)
      }
      
      await client.set(
        volumeCalcsKey,
        JSON.stringify(volumeCalcs),
        { EX: VOLUME_CALC_LOG_RETENTION_SECONDS },
      )
    } catch (error) {
      console.error("[v0] Failed to log volume calculation:", error)
    }
  }

  /**
   * Get volume calculation history from Redis
   */
  static async getVolumeHistory(connectionId: string, _symbol?: string, limit = 100) {
    try {
      await initRedis()
      const client = getRedisClient()

      // Get recent log IDs from list (prepended order, so slice from beginning)
      const volumeCalcsKey = `volume_calcs:${connectionId}`
      const existing = await client.get(volumeCalcsKey)
      
      let logIds: string[] = []
      if (existing) {
        try {
          const parsed = JSON.parse(existing)
          logIds = Array.isArray(parsed)
            ? parsed.map((value) => String(value)).filter(Boolean)
            : []
        } catch { logIds = [] }
      }
      
      if (!logIds || logIds.length === 0) return []

      // Take most recent entries (first in list)
      const recentIds = logIds.slice(0, Math.min(limit, logIds.length))
      
      const history = []
      for (const logId of recentIds) {
        const data = await client.get(`volume_calc:${connectionId}:${logId}`)
        if (data) {
          const parsed = typeof data === "string" ? JSON.parse(data) : data
          if (!_symbol || parsed.symbol === _symbol) {
            history.push(parsed)
          }
        }
      }

      return history.slice(0, limit)
    } catch (error) {
      console.error("[v0] Failed to get volume history:", error)
      return []
    }
  }

  /**
   * Calculate risk metrics for a position (pure math, no DB)
   */
  static calculateRiskMetrics(params: {
    entryPrice: number
    currentPrice: number
    volume: number
    leverage: number
    side: "long" | "short"
    stopLossPrice?: number
    takeProfitPrice?: number
  }) {
    const { entryPrice, currentPrice, volume, leverage, side, stopLossPrice, takeProfitPrice } = params

    const positionValue = volume * currentPrice
    const entryNotional = entryPrice * volume
    const safeLeverage = Math.max(1, Number(leverage) || 1)
    const marginUsd = entryNotional > 0 ? entryNotional / safeLeverage : 0

    // Leverage changes required margin and ROI; it never multiplies the
    // quote-currency PnL of a fixed contract quantity.
    const signedPriceMove = side === "long"
      ? currentPrice - entryPrice
      : entryPrice - currentPrice
    const unrealizedPnL = signedPriceMove * volume

    const unrealizedPnLPercent = entryNotional > 0 ? (unrealizedPnL / entryNotional) * 100 : 0
    const unrealizedRoiPercent = marginUsd > 0 ? (unrealizedPnL / marginUsd) * 100 : 0

    let potentialLoss = 0
    if (stopLossPrice) {
      if (side === "long") {
        potentialLoss = (stopLossPrice - entryPrice) * volume
      } else {
        potentialLoss = (entryPrice - stopLossPrice) * volume
      }
    }

    let potentialProfit = 0
    if (takeProfitPrice) {
      if (side === "long") {
        potentialProfit = (takeProfitPrice - entryPrice) * volume
      } else {
        potentialProfit = (entryPrice - takeProfitPrice) * volume
      }
    }

    let riskRewardRatio = 0
    if (potentialLoss !== 0) {
      riskRewardRatio = Math.abs(potentialProfit / potentialLoss)
    }

    return {
      positionValue,
      entryNotional,
      marginUsd,
      unrealizedPnL,
      unrealizedPnLPercent,
      unrealizedRoiPercent,
      potentialLoss,
      potentialProfit,
      riskRewardRatio,
    }
  }
}
