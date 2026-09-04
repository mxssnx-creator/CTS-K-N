"use strict"

const MIB = 1024 * 1024

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function pressureState(previousState, availableRatio) {
  const previous = ["normal", "pressure", "critical"].includes(previousState)
    ? previousState
    : "normal"
  if (availableRatio <= 0.12) return "critical"
  if (previous === "critical" && availableRatio <= 0.17) return "critical"
  if (availableRatio <= 0.22) return "pressure"
  if (previous === "pressure" && availableRatio <= 0.28) return "pressure"
  return "normal"
}

function calculateRedisMemoryPolicy({
  totalBytes,
  availableBytes,
  usedBytes = 0,
  previousState = "normal",
  buildMode = false,
  instanceShare = 1,
}) {
  const total = Math.max(512 * MIB, Number(totalBytes) || 0)
  const available = clamp(Number(availableBytes) || 0, 0, total)
  const used = Math.max(0, Number(usedBytes) || 0)
  const availableRatio = total > 0 ? available / total : 0
  const state = pressureState(previousState, availableRatio)
  const share = clamp(Number(instanceShare) || 1, 0.10, 1)
  const ratio = state === "critical"
    ? 0.15
    : state === "pressure"
      ? 0.20
      : buildMode
        ? 0.18
        : 0.25
  const unsharedMinimum = Math.min(768 * MIB, Math.max(256 * MIB, total * 0.10))
  const minimum = Math.max(128 * MIB, unsharedMinimum * share)
  const preferredMaximum = total * 0.32 * share
  const preferred = clamp(total * ratio * share, minimum, preferredMaximum)
  // noeviction protects lock and accounting keys. Never lower maxmemory below
  // the live data set; report over-budget so retention can shrink it instead.
  const safeUsedFloor = used * 1.20 + 64 * MIB
  const target = Math.ceil(Math.max(preferred, safeUsedFloor) / (64 * MIB)) * 64 * MIB
  return {
    state,
    availableRatio,
    targetBytes: Math.floor(target),
    preferredBytes: Math.floor(preferred),
    overBudget: safeUsedFloor > preferredMaximum,
    instanceShare: share,
  }
}

module.exports = {
  MIB,
  calculateRedisMemoryPolicy,
  pressureState,
}
