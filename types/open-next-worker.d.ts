// @opennextjs/cloudflare generates this module during the Kilo build.
// Keep its contract available to the repository typecheck, which intentionally
// runs before the generated `.open-next` directory exists.
declare module "*worker.js" {
  type OpenNextWorkerHandler = {
    fetch(
      request: Request,
      env?: Record<string, unknown>,
      ctx?: {
        waitUntil?: (promise: Promise<unknown>) => void
        passThroughOnException?: () => void
      },
    ): Promise<Response>
  }

  const handler: OpenNextWorkerHandler
  export default handler

  // These are emitted only when the corresponding OpenNext features are used;
  // the runtime re-export remains compatible with both generated variants.
  export const DOQueueHandler: unknown
  export const DOShardedTagCache: unknown
}
