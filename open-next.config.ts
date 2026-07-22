import { defineCloudflareConfig } from "@opennextjs/cloudflare"

export default {
  ...defineCloudflareConfig(),
  // Pin the builder command as well as the packageManager field. OpenNext
  // otherwise selects the first lockfile it finds, which made a stale Bun
  // lock silently override the canonical pnpm build.
  buildCommand: "node scripts/build-next-with-trace-retry.mjs",
}
