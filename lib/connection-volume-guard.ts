/**
 * An operator's channel volume factor must not be reset by anything but the
 * operator's own volume control.
 *
 * X01 live_volume_factor was set to 10 and found at 0.1 twice, the second time
 * 51 minutes into a run with no deploy: a single updateConnection from an API
 * request wrote selected_symbols, active_symbols and live_volume_factor 10 -> 0.1
 * (the change audit named the write, not the route). Dialogs and quick-start
 * echo the 0.1 MINIMUM as a default for a factor they did not load, and the
 * write layer took it for an operator decision.
 *
 * The rule is applied where the connection is written, so it holds whichever
 * route sends the value: a patch that sets a channel factor to exactly the
 * minimum while the stored value is higher is DROPPED unless it runs inside
 * runAsOperatorVolumeEdit (the volume endpoint, where the operator moves the
 * slider). Everything else — raising, keeping, or setting a factor that was
 * never set — is untouched.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { MIN_VOLUME_FACTOR } from "@/lib/constants"

export const CHANNEL_VOLUME_FACTOR_FIELDS: ReadonlySet<string> = new Set([
  "live_volume_factor", "volume_factor_live",
  "preset_volume_factor", "volume_factor_preset",
  "signal_volume_factor", "volume_factor_signal",
])

const operatorVolumeEdit = new AsyncLocalStorage<true>()

/** Marks the callback as the operator's explicit volume edit: it may lower a factor to the minimum. */
export function runAsOperatorVolumeEdit<T>(fn: () => Promise<T>): Promise<T> {
  return operatorVolumeEdit.run(true, fn)
}
export function isOperatorVolumeEdit(): boolean {
  return operatorVolumeEdit.getStore() === true
}

export interface BlockedVolumeReset { field: string; stored: string; attempted: string }

/**
 * Returns the patch without implicit resets, and the resets it removed.
 * `existing` is the stored connection hash.
 */
export function withoutImplicitVolumeReset<T extends Record<string, any>>(
  existing: Record<string, any> | null | undefined,
  patch: T,
  operatorEdit: boolean = isOperatorVolumeEdit(),
): { patch: T; blocked: BlockedVolumeReset[] } {
  if (operatorEdit || !existing) return { patch, blocked: [] }
  const blocked: BlockedVolumeReset[] = []
  const out: Record<string, any> = { ...patch }
  for (const field of CHANNEL_VOLUME_FACTOR_FIELDS) {
    if (!(field in out)) continue
    const attempted = Number(out[field])
    const stored = Number(existing[field])
    if (!Number.isFinite(attempted) || !Number.isFinite(stored)) continue
    if (attempted <= MIN_VOLUME_FACTOR + 1e-9 && stored > MIN_VOLUME_FACTOR + 1e-9) {
      blocked.push({ field, stored: String(existing[field]), attempted: String(out[field]) })
      delete out[field]
    }
  }
  return { patch: out as T, blocked }
}
