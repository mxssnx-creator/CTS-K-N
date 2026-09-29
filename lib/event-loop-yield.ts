/**
 * Lets pending I/O and timers run. CPU-bound loops (the Historic Test replay, the
 * accounting sweep) call this between units of work so the HTTP server keeps
 * answering while they run: a cron route that has answered "pending" is no help if
 * the process then stands still for a minute.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}
