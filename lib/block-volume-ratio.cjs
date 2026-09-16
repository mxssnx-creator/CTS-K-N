// Shared by TypeScript stages and the plain-Node Direct-Trade worker.
const BLOCK_INCREMENT_STEPS_DEFAULT = 3
// Operator-selectable additive recovery levels: 1..6, default 3, step 1.
// Each level multiplies the per-count add-on, so level L on block count C with
// ratio R yields base x (1 + C x R x L). Levels are clamped, never wrapped.
const BLOCK_INCREMENT_STEPS_MIN = 1
const BLOCK_INCREMENT_STEPS_MAX = 6
function normalizeBlockIncrementSteps(value, fallback = BLOCK_INCREMENT_STEPS_DEFAULT) {
  const n = Number(value)
  const f = Number(fallback)
  return Math.max(
    BLOCK_INCREMENT_STEPS_MIN,
    Math.min(
      BLOCK_INCREMENT_STEPS_MAX,
      Math.floor(Number.isFinite(n) ? n : Number.isFinite(f) ? f : BLOCK_INCREMENT_STEPS_DEFAULT),
    ),
  )
}
function blockEffectiveIncrementStep(count, steps = BLOCK_INCREMENT_STEPS_DEFAULT, requestedStep = 1) {
  if (!Number.isFinite(count) || count <= 0) return 0
  return Math.min(Math.max(1, Math.floor(Number(requestedStep) || 1)), normalizeBlockIncrementSteps(steps))
}
function blockVolumeMultiplier(count, ratio, steps = BLOCK_INCREMENT_STEPS_DEFAULT, requestedStep = 1) {
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
module.exports = { BLOCK_INCREMENT_STEPS_DEFAULT, BLOCK_INCREMENT_STEPS_MIN, BLOCK_INCREMENT_STEPS_MAX, normalizeBlockIncrementSteps, blockEffectiveIncrementStep, blockVolumeMultiplier, advanceBlockCountLifecycle }
