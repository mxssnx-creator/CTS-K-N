import fs from "fs"
import path from "path"

const ROOT = path.resolve(__dirname, "../..")
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")

describe("engine refresh request TTL", () => {
  test("both queued refresh consumers use the shared TTL constant", () => {
    const queue = read("lib/engine-refresh-queue.ts")
    const coordinator = read("lib/trade-engine.ts")
    const autoStart = read("lib/trade-engine-auto-start.ts")

    expect(queue).toContain("export const ENGINE_REFRESH_REQUEST_TTL_MS")
    expect(queue).toContain("process.env.ENGINE_REFRESH_REQUEST_TTL_MS")
    expect(queue).toContain("return 10 * 60 * 1000")

    expect(coordinator).toContain("ENGINE_REFRESH_REQUEST_TTL_MS")
    expect(coordinator).toContain("requestAgeMs >= ENGINE_REFRESH_REQUEST_TTL_MS")
    expect(coordinator).toContain("ttlMs=${ENGINE_REFRESH_REQUEST_TTL_MS}")
    expect(coordinator).not.toContain("now - requestTime >= 30000")

    expect(autoStart).toContain("ENGINE_REFRESH_REQUEST_TTL_MS")
    expect(autoStart).toContain("requestAgeMs >= ENGINE_REFRESH_REQUEST_TTL_MS")
    expect(autoStart).toContain("ttlMs=${ENGINE_REFRESH_REQUEST_TTL_MS}")
    expect(autoStart).not.toContain("Date.now() - requestTime >= 120_000")
  })
})
