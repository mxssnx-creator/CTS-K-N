# Common indicators

Common is the family of technical-indicator Sets: every **type × parameter tuple × timeframe × direction**
is one independent Set (`indication_set:{conn}:{symbol}:common:{dir}:{type}:tf{n}:p{params}`).

## One rule per type, shared by every engine

Every type is one causal per-bar rule in `lib/common-indicators/registry.ts`:

- **Live Common Sets** (`lib/indication-sets-processor.ts` → `lib/step-based-indicators.ts` →
  `lib/technical-indicators.ts`) read the rule at the last bar of each configured timeframe.
- **Auto** reads the per-timeframe step summaries, one vote per category (see below).
- **Preset optimizer** (`lib/preset-optimizer.ts`) reads the same rule per bar; every directional bar is a
  candidate entry, because live creates the Set on every cycle while the state holds.
- **Preset runtime** (`lib/indicators.ts`, `lib/preset-coordination-engine.ts`) reads the same rule on real OHLCV.

Before October 2026 these were separate implementations that disagreed. CCI and VWAP were momentum live but
reversion in the optimizer. Fibonacci, the ATR threshold and the RSI mid-zone also differed. The preset runtime
used `price × 1.01 / 0.99` as highs and lows. Live semantics now hold everywhere.

**The 17 original types** (`lib/common-indicators/legacy-rules.ts`) keep their exact arithmetic.
`__tests__/unit/common-indicators-legacy-equivalence.test.ts` pins every default tuple against a frozen copy of the
pre-registry implementation (`__tests__/fixtures/legacy-technical-indicators.ts`). The single intended difference is
**ATR**: its breakout baseline is the SMA of the configured period. It used to be fixed to the 14-bar fallback,
whatever period was configured.

**The 112 types ported from CTS-A-O** come from:

- **Math and series cache:** `lib/common-indicators/ao/{math,series-cache}.ts`;
- **Classic registry families:** `ao/classic.ts`;
- **Research batches:** `ao/research{,2,3}.ts`;
- **Single-symbol Micro events:** `ao/micro.ts`, `ao/micro-rules.ts`.

The math, cache and rule bodies are ported verbatim from CTS-A-O `src/core/{math,indications}`. One deliberate
difference: RSI is the system-wide Wilder RSI (`lib/wilder-rsi.ts`), which is numerically identical.

How the A-O variants map onto K-N:

- **Variants collapse into ranges.** A-O's short / "-m" medium / numeric-suffix variants of one rule are one K-N
  type. Its parameter ranges cover the A-O values (`lib/common-indicators/catalog.ts`, pure data for the
  Settings page; `lib/common-indicators/new-rules.ts` maps each type to its A-O rule).
- **Event rules are held.** Research and Micro event rules are kept for `keep` bars (default 2), so the last-bar
  read still sees an event once its bar has closed. Classic held events (Donchian break, MACD cross, …) apply A-O's
  own `keep`.

**Not ported:**

- **Stable-02:** it belongs to the CTS-G project.
- **Micro market relations** (mc-lag, mc-rsrev, mc-mturn, mc-act-*, mc-irsi2, mc-mrsi2, mc-iz, mc-ivwapd): they
  need the multi-symbol universe.
- **A-O's `@x4` / `@m<tf>c` higher-timeframe lanes:** K-N evaluates every type on each configured timeframe and
  Auto coordinates across them.
- **A-O ids that duplicate an original K-N type**, which map to it:
  - trend-adx → `adx`
  - sar-* → `psar`
  - dir-emax / ema-f-s → `ema`
  - dir-vwap → `vwap`
  - dir-macd → `macd`
  - willr-* → `williamsR`
  - bb-bounce → `bollinger`

  A-O's CCI reversion is its own type, `cciReversion`, because the original `cci` reads CCI as momentum.

**Defaults.** New types are **enabled by default**. This is an operator decision of 2026-10-14 and overrides the
AGENTS.md rule that defaults change only after validated positive results. Every category can be switched off in
Settings → Common.

## Auto: one vote per category

Types belong to six categories: trend, momentum, oscillator (reversion), volatility & breaks, volume & flow,
structure & price action.

- Each category's enabled types give a majority direction. A tie is neutral, and a neutral type abstains. That
  majority is one vote (`lib/common-indicators/categories.ts`).
- `minimumSignals` (default 3, at most 6) and `minAgreement` count agreeing categories, so one family of many
  variants cannot carry Auto alone.

## Tests

All of these iterate the whole catalogue (`__tests__/unit/common-indicators-catalog.test.ts`):

- **Catalogue and registry stay in sync.**
- **Causality:** a bar's state never changes when later bars arrive.
- **Live equals series:** the live last-bar result equals the state series at that bar.
- **Both directions:** every type fires long and short on synthetic markets.
- **Mirror symmetry:** long/short symmetry on the price mirror (K / price). The documented exceptions are the
  original `fibonacci` and the asymmetric first `williamsR` tuple.
- **Warm-up:** no result before the warm-up.

Also:

- `__tests__/unit/preset-optimizer.test.ts`: optimizer entries equal the live last-bar direction for every type.
- `__tests__/unit/common-category-vote.test.ts`: category vote, storage-key cooldown, preset type inference.

## Catalogue (129 types, 2,325 default tuples per timeframe)

### Trend (26 types)

| Type | Kind | Default tuples | Source | Parameters (from–to/step) |
|---|---|---:|---|---|
| `ma` | state | 49 | K-N original | shortPeriod 3–15/2, longPeriod 20–80/10 |
| `sma` | state | 36 | K-N original | shortPeriod 5–15/2, longPeriod 25–75/10 |
| `ema` | state | 25 | K-N original | shortPeriod 5–13/2, longPeriod 18–34/4 |
| `adx` | state | 40 | K-N original | period 7–21/2, threshold 15–35/5 |
| `psar` | state | 25 | K-N original | acceleration 0.01–0.03/0.005, maximum 0.1–0.3/0.05 |
| `emaTrend` | state | 3 | CTS-A-O `trend-ema` (trend-ema) | fast 9–21/12, slow 21–55/34 |
| `supertrend` | state | 9 | CTS-A-O `trend-st` (trend-st, dir-st) | period 7–21/7, multiplier 2–4/1 |
| `emaRibbon` | state | 2 | CTS-A-O `trend-ribbon` (trend-ribbon) | fast 9, mid 21, slow 55–89/34 |
| `emaSlope` | state | 9 | CTS-A-O `ema-slope` (ema-slope) | period 10–50/20, lookback 3–9/3 |
| `emaReclaim` | event | 2 | CTS-A-O `dir-reclaim` (dir-reclaim) | period 21–50/29, keep 4 |
| `emaPullback` | state | 4 | CTS-A-O `ema-pullback` (ema-pullback) | fast 21–50/29, slow 55–100/45 |
| `ichimokuTk` | state | 6 | CTS-A-O `ichi-tk` (ichi-tk) | tenkan 9–20/11, kijun 26–60/34, senkou 52–120/68 |
| `ichimokuCloud` | state | 6 | CTS-A-O `ichi-cloud` (ichi-cloud) | tenkan 9–20/11, kijun 26–60/34, senkou 52–120/68 |
| `aroon` | state | 2 | CTS-A-O `aroon` (aroon) | period 14–25/11, level 70 |
| `vortex` | event | 4 | CTS-A-O `r-vortex` (r-vortex) | p 14–21/7, gap 0.1–0.15/0.05, keep 2 |
| `chandelier` | event | 4 | CTS-A-O `r-chand` (r-chand) | p 22–44/22, m 3–3.5/0.5, keep 2 |
| `hma` | state | 3 | CTS-A-O `hma` (hma) | period 16–56/20 |
| `kama` | state | 2 | CTS-A-O `kama` (kama) | period 10–20/10 |
| `trix` | state | 2 | CTS-A-O `trix` (trix) | period 9–15/6 |
| `heikinAshi` | state | 2 | CTS-A-O `ha` (ha) | bars 1–3/2 |
| `roofingFilter` | event | 8 | CTS-A-O `r-roofing` (r-roofing) | hp 48–96/48, ss 10–20/10, min 0.5–0.7/0.2, keep 2 |
| `elderRay` | event | 4 | CTS-A-O `r-elder` (r-elder) | ema 13–26/13, fi 2–5/3, keep 2 |
| `linearRegression` | event | 4 | CTS-A-O `r-linreg` (r-linreg) | n 50–100/50, t 2–2.5/0.5, keep 2 |
| `htfTrendResume` | event | 2 | CTS-A-O `mc-tmom` (mc-tmom) | bars 3–5/2, keep 2 |
| `htfEmaPullback` | event | 2 | CTS-A-O `mc-tpull` (mc-tpull) | period 8–13/5, keep 2 |
| `htfEmaCross` | event | 4 | CTS-A-O `mc-tcross` (mc-tcross) | fast 5–8/3, slow 13–21/8, keep 2 |

### Momentum (16 types)

| Type | Kind | Default tuples | Source | Parameters (from–to/step) |
|---|---|---:|---|---|
| `macd` | state | 48 | K-N original | fastPeriod 8–14/2, slowPeriod 21–30/3, signalPeriod 7–11/2 |
| `roc` | state | 180 | K-N original | period 3–20/1, thresholdPct 0.1–1/0.1 |
| `rsiMomentum` | state | 9 | CTS-A-O `rsi-mom` (rsi-mom, rsi-mid) | period 7–21/7, level 20–40/10 |
| `macdCross` | event | 8 | CTS-A-O `macd-cross` (macd-cross) | fast 8–12/4, slow 21–26/5, signal 5–9/4, keep 6 |
| `macdHistogramTrend` | state | 1 | CTS-A-O `macd-hist` (macd-hist) | fast 12, slow 26, signal 9 |
| `macdZeroLine` | state | 1 | CTS-A-O `macd-zero` (macd-zero) | fast 12, slow 26 |
| `macdHistogramTurn` | event | 1 | CTS-A-O `mc-macdh` (mc-macdh) | keep 2 |
| `tsi` | event | 6 | CTS-A-O `r-tsi` (r-tsi) | a 13–25/12, b 7–13/6, sig 5–7/2, keep 2 |
| `awesomeOscillator` | event | 4 | CTS-A-O `r-awesome` (r-awesome) | f 5–8/3, s 34–55/21, keep 2 |
| `schaffTrendCycle` | event | 8 | CTS-A-O `r-stc` (r-stc) | f 23–34/11, s 50–75/25, cyc 10–14/4, keep 2 |
| `impulse` | event | 6 | CTS-A-O `move-impulse` (move-impulse) | bars 4–20/8, multiplier 1.5–2.5/1, keep 4 |
| `continuation` | state | 2 | CTS-A-O `move-cont` (move-cont) | longRoc 12, shortRoc 3, thresholdPct 0.4–0.6/0.2 |
| `thrust` | event | 2 | CTS-A-O `dir-thrust` (dir-thrust) | bars 3–4/1, keep 3 |
| `hfMomentum` | state | 3 | CTS-A-O `act-hf` (act-hf) | bars 3–9/3 |
| `sessionTrend` (UTC) | event | 8 | CTS-A-O `r-session-trend` (r-session-trend) | bars 12–24/12, mul 1.5–2/0.5, ema 50–100/50, keep 2 |
| `htfRsiMid` | event | 2 | CTS-A-O `mc-rsimid` (mc-rsimid) | period 14–21/7, keep 2 |

### Oscillator (reversion) (29 types)

| Type | Kind | Default tuples | Source | Parameters (from–to/step) |
|---|---|---:|---|---|
| `rsi` | state | 200 | K-N original | period 7–21/2, oversold 20–40/5, overbought 60–80/5 |
| `stochastic` | state | 800 | K-N original | kPeriod 7–21/2, dPeriod 2–5/1, oversold 15–35/5, overbought 65–85/5 |
| `cci` | state | 25 | K-N original | period 10–30/5, threshold 80–160/20 |
| `williamsR` | state | 200 | K-N original | period 7–21/2, oversold -90–-70/5, overbought -30–-10/5 |
| `rsiReversion` | state | 12 | CTS-A-O `rsi-extreme` (rsi-extreme, rsi-fast, rsi-P-L-H, mc-rsi) | period 2–14/4, level 10–30/10 |
| `rsiTurn` | event | 9 | CTS-A-O `mc-rsit` (mc-rsit) | period 2–8/3, level 10–30/10, keep 2 |
| `rsiTrendFilter` | event | 8 | CTS-A-O `r-rsi2` (r-rsi2) | p 2–3/1, lo 5–10/5, ema 100–200/100, keep 2 |
| `rsiDivergence` | event | 2 | CTS-A-O `rsi-div` (rsi-div) | period 14, lookback 10–20/10, keep 4 |
| `rsiWindowDivergence` | event | 2 | CTS-A-O `mc-rsidiv` (mc-rsidiv) | period 14, lookback 20–30/10, keep 2 |
| `quietRsi2` | event | 2 | CTS-A-O `mc-qrsi2` (mc-qrsi2) | level 5–10/5, keep 2 |
| `connorsRsi` | event | 4 | CTS-A-O `r-connors` (r-connors) | lo 10–15/5, ema 100–200/100, keep 2 |
| `laguerreRsi` | event | 4 | CTS-A-O `r-laguerre` (r-laguerre) | g 0.5–0.7/0.2, level 0.1–0.15/0.05, keep 2 |
| `stochRsi` | state | 2 | CTS-A-O `srsi` (srsi) | period 14, level 10–20/10 |
| `ultimateOscillator` | event | 4 | CTS-A-O `r-ultimate` (r-ultimate) | a 7–14/7, level 25–30/5, keep 2 |
| `fisherTransform` | event | 4 | CTS-A-O `r-fisher` (r-fisher) | n 10–20/10, ext 1.5–1.8/0.3, keep 2 |
| `zScore` | state | 8 | CTS-A-O `z` (z, mc-z) | period 20–50/10, threshold 2–2.5/0.5 |
| `zDistance` | event | 4 | CTS-A-O `r-zdist` (r-zdist) | z 2.5–3/0.5, look 100–200/100, keep 2 |
| `cciReversion` | state | 6 | CTS-A-O `cci-revert` (cci) | period 14–40/13, level 100–200/100 |
| `tdSetup` | event | 2 | CTS-A-O `r-td` (r-td) | n 9–13/4, keep 2 |
| `emaStochastic` | state | 2 | CTS-A-O `ema-stoch` (ema-stoch) | fast 21, slow 55, kPeriod 14, level 20–25/5 |
| `chopFade` | state | 4 | CTS-A-O `act-chop` (act-chop) | adxMax 15–18/3, rsiPeriod 7, level 25–30/5 |
| `streakFade` | event | 2 | CTS-A-O `mc-streak` (mc-streak) | bars 4–6/2, keep 2 |
| `exhaustionStreak` | event | 4 | CTS-A-O `r-streak` (r-streak) | n 5–6/1, mul 2.5–3/0.5, keep 2 |
| `spikeReversal` | event | 2 | CTS-A-O `mc-spike` (mc-spike) | multiplier 2–2.5/0.5, keep 2 |
| `vwapDistance` | event | 2 | CTS-A-O `mc-vwapd` (mc-vwapd) | distance 2–3/1, keep 2 |
| `bandReentry` | event | 2 | CTS-A-O `mc-bbx` (mc-bbx) | stdDev 2–2.5/0.5, keep 2 |
| `bandAdxReversion` | event | 4 | CTS-A-O `r-bb-adx` (r-bb-adx) | adx 20–25/5, rsi 10–15/5, keep 2 |
| `htfTrendStretch` | event | 4 | CTS-A-O `mc-tstretch` (mc-trsi2, mc-tbbx, mc-tvwapd, mc-tz) | stretch 1–4/1, keep 2 |
| `htfTrendTurn` | event | 2 | CTS-A-O `mc-tturn` (mc-turn, mc-tstreak) | stretch 1–2/1, keep 2 |

### Volatility & breaks (25 types)

| Type | Kind | Default tuples | Source | Parameters (from–to/step) |
|---|---|---:|---|---|
| `bollinger` | state | 40 | K-N original | period 14–28/2, stdDev 1.5–2.5/0.25 |
| `atr` | state | 40 | K-N original | period 7–21/2, multiplier 1–3/0.5 |
| `donchianBreak` | event | 4 | CTS-A-O `break-don` (break-don) | period 10–55/15, keep 6 |
| `volumeBreak` | event | 3 | CTS-A-O `break-vol` (break-vol) | period 20, volumeRatio 1.3–2/0.35, keep 6 |
| `donchianVolumeThrust` | event | 8 | CTS-A-O `r-donch-vol` (r-donch-vol) | p 20–40/20, vz 2–2.5/0.5, rng 1.5–1.8/0.3, keep 2 |
| `atrExpansion` | event | 3 | CTS-A-O `break-atr` (break-atr) | multiplier 0.9–2.1/0.6, keep 4 |
| `bollingerSqueeze` | event | 6 | CTS-A-O `break-squeeze` (break-squeeze) | lookback 30–120/45, tightness 1.1–1.25/0.15, keep 8 |
| `keltnerBreak` | event | 3 | CTS-A-O `kelt` (kelt) | period 20, multiplier 1.5–2.5/0.5, keep 4 |
| `squeezeRelease` | event | 2 | CTS-A-O `squeeze` (squeeze) | period 20–30/10, kcMultiplier 1.5, keep 6 |
| `squeezeRun` | event | 2 | CTS-A-O `r-squeeze` (r-squeeze) | bars 4–8/4, kc 1.5, keep 2 |
| `breakRetest` | event | 1 | CTS-A-O `break-retest` (break-retest) | period 20, window 8, keep 5 |
| `failedBreak` | event | 2 | CTS-A-O `break-fail` (break-fail) | period 20–40/20, keep 5 |
| `fakeout` | event | 4 | CTS-A-O `r-fakeout` (r-fakeout) | p 20–40/20, back 0.1–0.15/0.05, keep 2 |
| `rangeBurst` | event | 3 | CTS-A-O `act-burst` (act-burst) | multiplier 1.5–2.5/0.5, keep 4 |
| `rangeShift` | state | 2 | CTS-A-O `act-shift` (act-shift) | short 20, long 60, ratio 1.2–1.4/0.2 |
| `volatilityRegime` | event | 4 | CTS-A-O `r-vol-regime` (r-vol-regime) | p 20–40/20, ratio 1.1–1.25/0.15, keep 2 |
| `bandWidthExpansion` | event | 4 | CTS-A-O `r-bbw-expand` (r-bbw-expand) | look 500–800/300, from 0.15–0.2/0.05, to 0.4, keep 2 |
| `bandWalk` | state | 2 | CTS-A-O `bb-walk` (bb-walk) | period 20–50/30, stdDev 2 |
| `bollingerMidReclaim` | event | 1 | CTS-A-O `bb-mid` (bb-mid) | period 20, keep 4 |
| `bollingerWick` | event | 1 | CTS-A-O `bb-wick` (bb-wick) | period 20, keep 3 |
| `bandBreakout` | event | 1 | CTS-A-O `mc-bbrk` (mc-bbrk) | keep 2 |
| `narrowRangeBreak` | event | 2 | CTS-A-O `r-nr-break` (r-nr-break) | n 4–7/3, keep 2 |
| `choppinessBreak` | event | 4 | CTS-A-O `r-chop` (r-chop) | p 14–28/14, lo 38.2, hi 61.8, m 20–40/20, keep 2 |
| `expansionBreak` | event | 2 | CTS-A-O `mc-brk` (mc-brk) | period 10–20/10, keep 2 |
| `insideBarBreak` | event | 1 | CTS-A-O `mc-ibrk` (mc-ibrk) | keep 2 |

### Volume & flow (15 types)

| Type | Kind | Default tuples | Source | Parameters (from–to/step) |
|---|---|---:|---|---|
| `adl` | state | 48 | K-N original | shortPeriod 3–10/1, longPeriod 15–40/5 |
| `obv` | state | 48 | K-N original | shortPeriod 3–10/1, longPeriod 15–40/5 |
| `vwap` | state | 60 | K-N original | period 5–30/5, deviationPct 0.1–1/0.1 |
| `mfi` | state | 2 | CTS-A-O `mfi` (mfi) | period 14, level 10–20/10 |
| `cmf` | state | 2 | CTS-A-O `cmf` (cmf) | period 20, threshold 0.05–0.1/0.05 |
| `obvEma` | state | 2 | CTS-A-O `obv-ema` (obv) | period 20–50/30 |
| `klinger` | event | 6 | CTS-A-O `r-klinger` (r-klinger) | f 34–55/21, s 55–89/34, sig 13–21/8, keep 2 |
| `clvThrust` | event | 8 | CTS-A-O `r-clv-thrust` (r-clv-thrust) | clv 0.8–0.9/0.1, vz 1.5–2/0.5, rng 1–1.3/0.3, keep 2 |
| `cvdDivergence` | event | 2 | CTS-A-O `r-cvd-div` (r-cvd-div) | p 20–40/20, keep 2 |
| `vwapReclaim` (UTC) | event | 4 | CTS-A-O `r-vwap-reclaim` (r-vwap-reclaim) | vz 1–1.5/0.5, hold 1–2/1, keep 2 |
| `vwapVolumeCross` | event | 2 | CTS-A-O `mc-vwapx` (mc-vwapx) | volumeRatio 1.5–2/0.5, keep 2 |
| `volumeBurst` | event | 4 | CTS-A-O `mc-burst` (mc-burst, mc-qburst) | multiplier 2–3/1, quiet 0–1/1, keep 2 |
| `valueArea` | event | 2 | CTS-A-O `r-valuearea` (r-valuearea) | look 96–192/96, va 0.7, keep 2 |
| `quarterHourFlow` (UTC) | event | 4 | CTS-A-O `r-qh-flow` (r-qh-flow) | n 4–8/4, thr 0.3–0.35/0.05, keep 2 |
| `quarterHourReversal` (UTC) | event | 4 | CTS-A-O `r-qh-rev` (r-qh-rev) | z 2.5–3/0.5, vx 1.5–2/0.5, keep 2 |

### Structure & price action (18 types)

| Type | Kind | Default tuples | Source | Parameters (from–to/step) |
|---|---|---:|---|---|
| `fibonacci` | state | 35 | K-N original | lookback 13–55/7, tolerancePct 0.1–0.5/0.1 |
| `swingPosition` | state | 3 | CTS-A-O `move-swing` (move-swing) | period 8–32/12 |
| `stopSweep` | event | 4 | CTS-A-O `r-sweep` (r-sweep) | p 20–40/20, wick 0.6, vz 1.5–2/0.5, keep 2 |
| `capitulation` | event | 4 | CTS-A-O `r-capit` (r-capit) | mul 3–3.5/0.5, vz 3–3.5/0.5, keep 2 |
| `fractalBreak` | event | 4 | CTS-A-O `r-fractal` (r-fractal) | w 2–3/1, ema 50–100/50, keep 2 |
| `camarillaPivots` (UTC) | event | 2 | CTS-A-O `r-camarilla` (r-camarilla) | rej 0.5–0.7/0.2, keep 2 |
| `spring` | event | 8 | CTS-A-O `r-spring` (r-spring) | p 40–60/20, width 4–5/1, pierce 0.5–0.7/0.2, keep 2 |
| `openingRangeBreak` (UTC) | event | 4 | CTS-A-O `r-orb` (r-orb) | bars 4–8/4, minW 0.5–0.7/0.2, keep 2 |
| `previousDayBreak` (UTC) | event | 4 | CTS-A-O `r-pdhl` (r-pdhl) | brk 0.15–0.3/0.15, ret 0.05–0.1/0.05, keep 2 |
| `breakOfStructure` | event | 4 | CTS-A-O `r-bos` (r-bos) | w 3–5/2, buf 0.3–0.4/0.1, keep 2 |
| `changeOfCharacter` | event | 4 | CTS-A-O `r-choch` (r-choch) | w 3–5/2, buf 0.2–0.3/0.1, keep 2 |
| `fairValueGap` | event | 8 | CTS-A-O `r-fvg` (r-fvg) | disp 1.5–2/0.5, gap 0.3–0.5/0.2, ttl 12–20/8, keep 2 |
| `insideBarTrend` | event | 4 | CTS-A-O `r-inside` (r-inside) | mother 1–1.3/0.3, ema 50–100/50, keep 2 |
| `engulfingVolume` | event | 8 | CTS-A-O `r-engulf` (r-engulf) | mult 1.5–2/0.5, atr 0.8–1/0.2, look 10–20/10, keep 2 |
| `engulfingExtreme` | event | 2 | CTS-A-O `mc-engulf` (mc-engulf) | period 20–40/20, keep 2 |
| `pinBar` | event | 4 | CTS-A-O `r-pin` (r-pin) | wick 2–2.5/0.5, rng 1.2–1.5/0.3, keep 2 |
| `rejectionWick` | event | 2 | CTS-A-O `mc-wick` (mc-wick) | multiplier 2–3/1, keep 2 |
| `starPattern` | event | 4 | CTS-A-O `r-star` (r-star) | small 0.25–0.3/0.05, big 0.8–1/0.2, keep 2 |

