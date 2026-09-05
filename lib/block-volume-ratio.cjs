// Shared by TypeScript stages and the plain-Node Direct-Trade worker.
const BLOCK_INCREMENT_STEPS_DEFAULT = 2
function normalizeBlockIncrementSteps(value, fallback = 2) {
  const n = Number(value)
  const f = Number(fallback)
  return Math.max(1, Math.min(2, Math.floor(Number.isFinite(n) ? n : Number.isFinite(f) ? f : 2)))
}
function blockEffectiveIncrementStep(count, steps = 2, requestedStep = 1) {
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.min(Math.max(1, Math.floor(Number(requestedStep) || 1)), normalizeBlockIncrementSteps(steps))
}
function blockVolumeMultiplier(count, ratio, steps = 2, requestedStep = 1) {
  if (![count, ratio].every(n => Number.isFinite(n) && n > 0)) return 0
  return Number((1 + Math.floor(count) * ratio * blockEffectiveIncrementStep(count, steps, requestedStep)).toFixed(12))
}
function advanceBlockCountLifecycle(previous, input) {
  const steps = normalizeBlockIncrementSteps(input.incrementSteps)
  const count = Math.max(1, Math.floor(input.blockCount))
  const current = blockEffectiveIncrementStep(count, steps, Math.max(Number(previous?.incrementStep || 1), Number(input.executedIncrementStep || 1)))
  const positive = Number(input.netPnl) > 0
  const nonPositive = positive ? 0 : Number(previous?.nonPositiveCount || 0) + 1
  const advance = !positive && nonPositive >= count && current < steps
  return { setKey: input.setKey, symbol: input.symbol, direction: input.direction, sourceKey: input.sourceKey,
    blockCount: count, incrementSteps: steps, incrementStep: positive ? 1 : Math.min(steps, current + Number(advance)),
    nonPositiveCount: positive || advance ? 0 : Math.min(count, nonPositive), recovering: !positive,
    remaining: positive ? Math.max(1, Math.floor(input.pauseCount)) : 0, pauseCount: input.pauseCount, updatedAt: input.updatedAt }
}
module.exports = { BLOCK_INCREMENT_STEPS_DEFAULT, normalizeBlockIncrementSteps, blockEffectiveIncrementStep, blockVolumeMultiplier, advanceBlockCountLifecycle }
