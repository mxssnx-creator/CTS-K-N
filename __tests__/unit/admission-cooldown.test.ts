import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  ADMISSION_COOLDOWN_FALLBACK_MS, ADMISSION_COOLDOWN_MAX_MS, ADMISSION_COOLDOWN_MIN_MS, admissionCooldownKey,
  deferredAdmissionResult, isRateLimitedSnapshotError, parseRetryAfterMs, readAdmissionCooldownUntil, setAdmissionCooldown,
} from "@/lib/trade-engine/admission-cooldown"
import { classifyLiveDispatchResult } from "@/lib/live-dispatch-outcome"
import { AuthoritativeSnapshotUnavailableError, readAuthoritativeProtectionOrdersUncached } from "@/lib/trade-engine/stages/live-stage"

const NOW = 1_790_870_000_000
const BINGX_100410 = "100410:code:100410:The endpoint trigger frequency limit rule is currently in the disabled period and will be unblocked after 1790870392472"

function fakeRedis() {
  const kv = new Map<string, { v: string; px?: number }>()
  return { kv, set: async (k: string, v: string, o?: { PX?: number }) => { kv.set(k, { v, px: o?.PX }); return "OK" }, get: async (k: string) => kv.get(k)?.v ?? null }
}

describe("a rate-limited venue defers entries instead of rejecting them", () => {
  test("which refusals count as rate limits", () => {
    for (const e of [BINGX_100410, "rate_limit_cooldown", "109429 rolling order limit", "HTTP 429", "Rate limit exceeded", "disabled period"]) expect(isRateLimitedSnapshotError(e)).toBe(true)
    for (const e of ["", "request_in_progress", "101204 Insufficient margin", "timeout", undefined]) expect(isRateLimitedSnapshotError(e)).toBe(false)
  })
  test("the wait is read from the end the venue names, kept within 1-120 s, 30 s otherwise", () => {
    expect(parseRetryAfterMs(BINGX_100410, 1790870392472 - 23_000)).toBe(23_000)
    expect(parseRetryAfterMs(BINGX_100410, 1790870392472 - 900_000)).toBe(ADMISSION_COOLDOWN_MAX_MS)
    expect(parseRetryAfterMs(BINGX_100410, 1790870392472 + 5_000)).toBe(ADMISSION_COOLDOWN_MIN_MS)
    expect(parseRetryAfterMs("unblocked after 1790870392", 1790870392000 - 10_000)).toBe(10_000) // seconds
    expect(parseRetryAfterMs("rate limited, no time given", NOW)).toBe(ADMISSION_COOLDOWN_FALLBACK_MS)
  })
  test("the cooldown is kept per connection until its end and read back", async () => {
    const r = fakeRedis()
    expect(await readAdmissionCooldownUntil(r, "bingx-x02")).toBe(0)
    const until = await setAdmissionCooldown(r, "bingx-x02", 23_000, NOW)
    expect(until).toBe(NOW + 23_000)
    expect(r.kv.get(admissionCooldownKey("bingx-x02"))).toEqual({ v: String(NOW + 23_000), px: 23_000 })
    expect(await readAdmissionCooldownUntil(r, "bingx-x02")).toBe(NOW + 23_000)
    expect(await readAdmissionCooldownUntil(r, "bingx-x01")).toBe(0)
    expect((await setAdmissionCooldown(r, "c", 9_999_999, NOW)) - NOW).toBe(ADMISSION_COOLDOWN_MAX_MS)
    expect((await setAdmissionCooldown(r, "c", 5, NOW)) - NOW).toBe(ADMISSION_COOLDOWN_MIN_MS)
  })
  test("a broken Redis never breaks the entry: no cooldown is set or read", async () => {
    const broken = { set: async () => { throw new Error("down") }, get: async () => { throw new Error("down") } }
    await expect(setAdmissionCooldown(broken, "c", 1000, NOW)).resolves.toBe(NOW + 1000)
    await expect(readAdmissionCooldownUntil(broken, "c")).resolves.toBe(0)
  })
  test("the deferred result is classified deferred, never blocked, and is not a saved row", () => {
    const result = deferredAdmissionResult({ id: "real:x", symbol: "BTCUSDT", direction: "long", status: "pending" }, "bingx-x02", NOW + 20_000, NOW)
    expect(result).toMatchObject({ status: "rejected", persisted: false, deferredUntil: NOW + 20_000, connectionId: "bingx-x02" })
    expect(result.statusReason).toContain("will retry in 20s")
    expect(result.executionBlockCode).toBeUndefined(); expect(result.executionMode).toBeUndefined()
    expect(classifyLiveDispatchResult(result as any)).toBe("deferred")
    // the previous behaviour, for comparison: a blocked rejection
    expect(classifyLiveDispatchResult({ status: "rejected", executionMode: "blocked", executionBlockCode: "entry_protection_admission_failed", statusReason: "Exchange order blocked before any venue mutation: protection admission failed (authoritative_admission_snapshot_unavailable)" })).toBe("blocked")
  })
})

describe("the open-order snapshot for the admission", () => {
  const connector = (statuses: Array<{ ok: boolean; error?: string }>, orders: any[] = []) => {
    let call = 0
    return { calls: () => call, getOpenOrders: async () => { call++; return orders }, getLastOpenOrdersSnapshotStatus: () => statuses[Math.min(call - 1, statuses.length - 1)] }
  }
  test("a good snapshot is returned as before", async () => {
    const c = connector([{ ok: true }], [{ orderId: "1" }])
    await expect(readAuthoritativeProtectionOrdersUncached(c, "BTCUSDT")).resolves.toEqual([{ orderId: "1" }])
    expect(c.calls()).toBe(1)
  })
  test("request_in_progress (another caller overwrote the shared status) is looked at again, not rejected", async () => {
    const c = connector([{ ok: false, error: "request_in_progress" }, { ok: true }], [{ orderId: "2" }])
    await expect(readAuthoritativeProtectionOrdersUncached(c, "ETHUSDT")).resolves.toEqual([{ orderId: "2" }])
    expect(c.calls()).toBe(2)
  })
  test("a 100410 is not retried at once: it throws a typed error that carries the wait", async () => {
    const c = connector([{ ok: false, error: BINGX_100410 }])
    const error = await readAuthoritativeProtectionOrdersUncached(c, "BTCUSDT").catch((e) => e)
    expect(error).toBeInstanceOf(AuthoritativeSnapshotUnavailableError)
    expect(error.message).toBe("Exact-slot reconciliation requires an authoritative venue open-order snapshot")
    expect(error.rateLimited).toBe(true)
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(ADMISSION_COOLDOWN_MIN_MS)
    expect(error.retryAfterMs).toBeLessThanOrEqual(ADMISSION_COOLDOWN_MAX_MS)
    expect(c.calls()).toBe(1)
  })
  test("any other refusal stays an authoritative 'unavailable', not a rate limit", async () => {
    const c = connector([{ ok: false, error: "network down" }])
    const error = await readAuthoritativeProtectionOrdersUncached(c).catch((e) => e)
    expect(error.rateLimited).toBe(false)
  })
  test("request_in_progress that never clears gives up after three looks", async () => {
    const c = connector([{ ok: false, error: "request_in_progress" }])
    await expect(readAuthoritativeProtectionOrdersUncached(c)).rejects.toThrow("authoritative venue open-order snapshot")
    expect(c.calls()).toBe(3)
  })
})

describe("wiring", () => {
  const stage = readFileSync(resolve(process.cwd(), "lib/trade-engine/stages/live-stage.ts"), "utf8")
  test("executeLivePosition returns a deferred result without a row while the cooldown runs", () => {
    const start = stage.indexOf("export async function executeLivePosition(")
    const cooldown = stage.indexOf("const admissionCooldownUntil = await readAdmissionCooldownUntil(client, connectionId)")
    const rowCreated = stage.indexOf("const livePosition: LivePosition", start)
    expect(cooldown).toBeGreaterThan(start); expect(cooldown - start).toBeLessThan(900)
    if (rowCreated > 0) expect(cooldown).toBeLessThan(rowCreated)
    expect(stage).toContain("deferredAdmissionResult(sourceRealPosition as unknown as Record<string, any>, connectionId, admissionCooldownUntil)")
  })
  test("a rate-limited admission stores one deferred row, sets the cooldown and leaves the other rejections as they were", () => {
    expect(stage).toContain("if (!entryAdmission.safe && admissionSnapshotError?.rateLimited) {")
    expect(stage).toContain("await setAdmissionCooldown(client, connectionId, admissionSnapshotError.retryAfterMs)")
    const deferral = stage.indexOf("if (!entryAdmission.safe && admissionSnapshotError?.rateLimited) {")
    const rejection = stage.indexOf("if (!entryAdmission.safe) {", deferral)
    expect(rejection).toBeGreaterThan(deferral)
    expect(stage.slice(deferral, rejection)).not.toContain('executionMode = "blocked"')
    expect(stage.slice(deferral, rejection)).not.toContain("executionBlockCode")
  })
})
