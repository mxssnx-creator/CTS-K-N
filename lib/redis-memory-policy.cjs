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
  // noeviction preserves existing accounting/ownership keys even above the
  // cap. A used-memory floor must not grow without a host-relative ceiling:
  // that feedback loop previously allowed a 16 GiB host to admit >18 GiB.
  // Over-budget datasets require retention/recovery, not another limit raise.
  const safeUsedFloor = used * 1.20 + 64 * MIB
  // Shared Redis may use at most half the host; the other half remains
  // reserved for application workers, the OS and recovery headroom. Preferred
  // steady-state allocation stays at 15–25%, with the existing 32% soft budget.
  const hardMaximum = Math.max(minimum, Math.floor(total * 0.50 * share))
  const target = Math.min(hardMaximum, Math.ceil(Math.max(preferred, safeUsedFloor) / (64 * MIB)) * 64 * MIB)
  return {
    state,
    availableRatio,
    targetBytes: Math.floor(target),
    preferredBytes: Math.floor(preferred),
    hardMaximumBytes: Math.floor(hardMaximum),
    overBudget: safeUsedFloor > hardMaximum,
    instanceShare: share,
  }
}

function calculateRedisMaintenanceAdmission({ policy, availableBytes, usedBytes, rssBytes = 0, persistence = {}, now, lastPurgeAt = 0, lastAofAttemptAt = 0 }) {
  const loading = persistence.loading === "1" || persistence.async_loading === "1"
  const busy = persistence.rdb_bgsave_in_progress === "1"
    || persistence.aof_rewrite_in_progress === "1"
    || persistence.aof_rewrite_scheduled === "1"
  // Reserve the entire dataset for worst-case CoW plus allocator/OS headroom.
  const forkReserveBytes = Math.max(Number(usedBytes) || 0, Number(rssBytes) || 0) + 512 * MIB
  const forkAllowed = !loading && !busy && policy.state === "normal"
    && !policy.overBudget && Number(availableBytes) >= forkReserveBytes
  return {
    loading,
    busy,
    forkReserveBytes,
    forkAllowed,
    // Purging on every critical-pressure timer tick can itself stall Redis.
    purgeAllowed: !loading && !busy && now - lastPurgeAt >= 15 * 60 * 1000,
    // Throttle unsuccessful attempts too, instead of retrying each timer tick.
    aofRewriteAllowed: forkAllowed && now - lastAofAttemptAt >= 6 * 60 * 60 * 1000,
  }
}

module.exports = {
  MIB,
  calculateRedisMemoryPolicy,
  calculateRedisMaintenanceAdmission,
  pressureState,
}
