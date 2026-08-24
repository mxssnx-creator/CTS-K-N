"use strict"

function normalizeDirectTradeControlId(value, fallback = "dt-control") {
  const raw = String(value || fallback)
  const normalized = raw.replace(/[^A-Za-z0-9_-]+/g, "_")
  if (normalized.length < 3) return fallback
  if (normalized === raw && normalized.length <= 48) return normalized

  let hash = 0x811c9dc5
  for (let index = 0; index < raw.length; index++) {
    hash ^= raw.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  const suffix = `_${(hash >>> 0).toString(36).padStart(7, "0")}`
  return `${normalized.slice(0, Math.max(3, 48 - suffix.length))}${suffix}`.slice(0, 48)
}

function positiveInteger(value) {
  const number = Math.floor(Number(value) || 0)
  return number > 0 ? number : 0
}

function legacyControlIdForLeg(position, leg) {
  if (!leg || typeof leg !== "object") return null
  // An exchange order id is the minimum evidence required before a legacy
  // ledger row may be associated with a durable control. The order gateway
  // still verifies that this exact control already exists and reconcileOnly
  // therefore cannot submit a new venue order.
  const orderId = String(leg.orderId || leg.exchangeOrderId || "").trim()
  if (!orderId) return null
  if (leg.controlId) return normalizeDirectTradeControlId(leg.controlId)

  const positionId = String(position?.id || "").trim()
  if (!positionId) return null

  const dcaStep = positiveInteger(leg.step)
  if (dcaStep > 0) {
    const generation = Math.max(0, Math.floor(Number(leg.controlGeneration) || 0))
    return normalizeDirectTradeControlId(
      `dtdca_${positionId.slice(-24)}_${dcaStep}_${generation}`,
    )
  }

  const blockCount = positiveInteger(leg.blockCount)
  if (blockCount > 0) {
    const generation = Math.max(0, Math.floor(Number(leg.controlGeneration) || 0))
    return normalizeDirectTradeControlId(
      `dtblk_${positionId.slice(-25)}_${blockCount}_${generation}`,
    )
  }

  const openControlId = String(position?.openControlId || "").trim()
  if (!openControlId) return null
  const initialOrderIds = new Set([
    position?.openOrderId,
    position?.orderId,
    position?.exchangeOrderId,
  ].map((value) => String(value || "").trim()).filter(Boolean))
  return initialOrderIds.has(orderId)
    ? normalizeDirectTradeControlId(openControlId)
    : null
}

function normalizeLegCollection(position, collection) {
  if (!Array.isArray(collection)) return { collection, changed: false }
  let changed = false
  const normalized = collection.map((leg) => {
    const controlId = legacyControlIdForLeg(position, leg)
    if (!controlId || controlId === leg?.controlId) return leg
    changed = true
    return { ...leg, controlId }
  })
  return { collection: changed ? normalized : collection, changed }
}

function backfillLegacyDirectTradeLegControlIds(position) {
  if (!position || typeof position !== "object" || position.mode !== "live") return position

  let next = position
  const canonicalLegs = Array.isArray(position.positionLegs) && position.positionLegs.length > 0
    ? position.positionLegs
    : Array.isArray(position.blockLegs) && position.blockLegs.length > 0
      ? position.blockLegs
      : []
  if ((!Array.isArray(position.positionLegs) || position.positionLegs.length === 0) && canonicalLegs.length > 0) {
    next = { ...next, positionLegs: canonicalLegs.map((leg) => ({ ...leg })) }
  }

  for (const key of ["positionLegs", "blockLegs", "dcaLegs"]) {
    const result = normalizeLegCollection(next, next[key])
    if (!result.changed) continue
    if (next === position) next = { ...position }
    next[key] = result.collection
  }
  return next
}

module.exports = {
  backfillLegacyDirectTradeLegControlIds,
  legacyControlIdForLeg,
  normalizeDirectTradeControlId,
}
