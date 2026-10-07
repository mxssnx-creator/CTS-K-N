/**
 * Same-page sync between settings controls that save on their own (for
 * example the Auto indication card) and the Settings page, which saves its
 * whole snapshot. Without it a later page save writes the page's stale copy
 * of a value another control has just saved.
 */
export const APP_SETTING_SAVED_EVENT = "cts:app-setting-saved"

export interface AppSettingSavedDetail {
  key: string
  value: unknown
}

export function publishAppSettingSaved(key: string, value: unknown): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<AppSettingSavedDetail>(APP_SETTING_SAVED_EVENT, { detail: { key, value } }))
}

export function subscribeAppSettingSaved(handler: (detail: AppSettingSavedDetail) => void): () => void {
  if (typeof window === "undefined") return () => undefined
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<AppSettingSavedDetail>).detail
    if (detail && typeof detail.key === "string") handler(detail)
  }
  window.addEventListener(APP_SETTING_SAVED_EVENT, listener)
  return () => window.removeEventListener(APP_SETTING_SAVED_EVENT, listener)
}
