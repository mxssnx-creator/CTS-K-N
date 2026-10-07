/**
 * Stage funnel contract — one definition of every Set population a stage
 * reports, plus the invariants that tie them together.
 *
 *   emitted         every Set the stage produced this pass
 *   awaitingHistory emitted, but fewer measured closes than prevPosMinCount
 *   rejected        measured, but failed the stage's PF/DDT contract
 *   valid           passed the stage gate (Base: status valid_base)
 *   processing      valid Sets that carry entries (the dashboard's
 *                   "Processing" / "Progressing" count)
 *   running         valid Sets that hold an open pseudo/live position
 *
 * Processing, progressing and running count gate-validated Sets ONLY. Base
 * once reported every emitted Set as progressing (327 progressing with 0
 * passed in the 2026-10-07 24 h run); every counter now derives from this
 * object so that cannot recur unnoticed. Shared by the coordinator (runtime
 * guard), the stats verifier and the tests.
 */

const STAGES = ["base", "main", "real", "live"]

function count(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

/** Violations of one stage's populations (empty array = consistent). */
function checkStageFunnel(funnel) {
  const out = []
  if (!funnel || typeof funnel !== "object") return ["funnel missing"]
  const stage = String(funnel.stage || "?")
  const fields = ["emitted", "awaitingHistory", "rejected", "valid", "processing", "running"]
  const v = {}
  for (const field of fields) {
    if (funnel[field] === undefined || funnel[field] === null) continue
    v[field] = count(funnel[field])
    if (!Number.isFinite(v[field])) out.push(`${stage}.${field} is not a number`)
    else if (v[field] < 0) out.push(`${stage}.${field} is negative (${v[field]})`)
  }
  const le = (a, b) => {
    if (Number.isFinite(v[a]) && Number.isFinite(v[b]) && v[a] > v[b]) {
      out.push(`${stage}.${a} (${v[a]}) > ${stage}.${b} (${v[b]})`)
    }
  }
  le("running", "valid")
  le("processing", "valid")
  le("valid", "emitted")
  if (["emitted", "awaitingHistory", "rejected", "valid"].every((f) => Number.isFinite(v[f]))) {
    const sum = v.awaitingHistory + v.rejected + v.valid
    if (sum !== v.emitted) {
      out.push(`${stage}: awaitingHistory + rejected + valid (${sum}) != emitted (${v.emitted})`)
    }
  }
  return out
}

/** Violations across stages of one pass: each stage's input is the previous stage's valid. */
function checkPipelineFunnel(pipeline) {
  const out = []
  if (!pipeline) return out
  for (const stage of STAGES) {
    if (pipeline[stage]) out.push(...checkStageFunnel({ stage, ...pipeline[stage] }))
  }
  const base = pipeline.base
  const main = pipeline.main
  if (base && main && main.input !== undefined && base.valid !== undefined && count(main.input) !== count(base.valid)) {
    out.push(`main.input (${count(main.input)}) != base.valid (${count(base.valid)})`)
  }
  return out
}

/**
 * Violations visible in the stats API payload
 * (`/api/connections/progression/{id}/stats` → `strategyDetail`).
 * Base processing/running must never exceed Base passed (= Base-valid), and
 * no stage may pass more than it evaluated.
 */
function stageFunnelViolationsFromStats(stats) {
  const out = []
  const detail = stats && (stats.strategyDetail || stats)
  if (!detail || typeof detail !== "object") return out
  const base = detail.base
  if (base) {
    const passed = count(base.passed)
    for (const field of ["setsProgressing", "setsRunningNow"]) {
      const value = count(base[field])
      if (Number.isFinite(passed) && Number.isFinite(value) && value > passed) {
        out.push(`base.${field} (${value}) > base.passed (${passed}): processing must count Base-valid Sets only`)
      }
    }
  }
  for (const stage of STAGES) {
    const row = detail[stage]
    if (!row) continue
    const passed = count(row.passed)
    const evaluated = count(row.evaluated)
    if (Number.isFinite(passed) && Number.isFinite(evaluated) && evaluated > 0 && passed > evaluated) {
      out.push(`${stage}.passed (${passed}) > ${stage}.evaluated (${evaluated})`)
    }
  }
  return out
}

/**
 * The Base funnel of one pass, from the Main-side gate outcome. `processing`
 * and `running` are computed over the valid Sets only.
 */
function baseStageFunnel(input) {
  let processing = 0
  let running = 0
  for (const set of input.sets || []) {
    if (!input.validSetKeys.has(set.setKey)) continue
    if ((set.entryCount || 0) > 0) processing++
    if (input.openSetKeys.has(set.setKey)) running++
  }
  return {
    stage: "base",
    emitted: input.emitted,
    awaitingHistory: input.awaitingHistory,
    rejected: input.rejected,
    valid: input.validSetKeys.size,
    processing,
    running,
  }
}

module.exports = { STAGE_FUNNEL_STAGES: STAGES, checkStageFunnel, checkPipelineFunnel, stageFunnelViolationsFromStats, baseStageFunnel }
