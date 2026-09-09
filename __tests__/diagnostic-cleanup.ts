// Route tests reset Redis mocks while production diagnostic modules deliberately
// keep their timers on globalThis. Close that fixture lifecycle before Jest
// disposes its console; do not hide late logs or change production log severity.
afterEach(async () => {
  const state = (globalThis as any).__v0_progression
  if (!state) return
  if (state.flushTimer) clearInterval(state.flushTimer)
  state.flushTimer = null
  state.flushTimerStarted = false
  state.logBuffer?.clear()
  state.coalesced?.clear()
  await Promise.allSettled([
    ...(state.flushes?.values() || []),
    ...(state.flushAllPromise ? [state.flushAllPromise] : []),
  ])
})
