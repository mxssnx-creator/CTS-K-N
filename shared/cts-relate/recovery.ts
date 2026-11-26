/** One completed trial with the loss step and proposed size captured before entry. */
export type RelateTrial = [closedAt: number, step: number, netReturn: number | null, size: number]

export const DEFAULT_RELATE_RECOVERY_TRADES = 12
export const DEFAULT_RELATE_RECOVERY_DRAWDOWN = .5

export function consecutiveLosses(newestFirst: readonly (number | undefined)[], maxStep: number): number {
  let losses = 0
  while (losses < maxStep) {
    const value = newestFirst[losses]
    if (value === undefined || !Number.isFinite(value) || value >= 0) break
    losses++
  }
  return losses
}

interface RelateTotals {
  gain: number
  loss: number
  sizedGain: number
  sizedLoss: number
  peak: number
  drawdown: number
  net: number
}

/** Both chronological cohorts must support the exact step at positive net PF. */
export function recoveryQualified(trials: readonly RelateTrial[], step: number, before: number, since: number,
  minTrades: number, minPF: number, maxDrawdownRatio: number): boolean {
  if (!Number.isFinite(before) || step < 1 || trials.length < minTrades) return false
  let count = 0
  for (const [at, trialStep] of trials) {
    if (!Number.isFinite(at) || at >= before || at < since || trialStep !== step) continue
    count++
  }
  if (count < minTrades) return false

  const totals = (): RelateTotals => ({gain: 0, loss: 0, sizedGain: 0, sizedLoss: 0, peak: 0, drawdown: 0, net: 0})
  const earlier = totals()
  const later = totals()
  const split = Math.floor(count / 2)
  let index = 0
  for (let row = trials.length - 1; row >= 0; row--) {
    const [at, trialStep, value, size] = trials[row]
    if (!Number.isFinite(at) || at >= before || at < since || trialStep !== step) continue
    if (value === null || !Number.isFinite(value) || !Number.isFinite(size) || size < 1) return false
    const cohort = index++ < split ? earlier : later
    const sized = value * size
    if (!Number.isFinite(sized)) return false
    cohort.gain += Math.max(0, value)
    cohort.loss += Math.max(0, -value)
    cohort.sizedGain += Math.max(0, sized)
    cohort.sizedLoss += Math.max(0, -sized)
    cohort.net += sized
    cohort.peak = Math.max(cohort.peak, cohort.net)
    cohort.drawdown = Math.max(cohort.drawdown, cohort.peak - cohort.net)
  }
  return [earlier, later].every(cohort => Number.isFinite(cohort.gain + cohort.loss + cohort.sizedGain + cohort.sizedLoss) &&
    cohort.gain > cohort.loss && cohort.gain >= cohort.loss * minPF &&
    cohort.sizedGain > cohort.sizedLoss && cohort.sizedGain >= cohort.sizedLoss * minPF &&
    cohort.drawdown <= cohort.sizedGain * maxDrawdownRatio)
}
