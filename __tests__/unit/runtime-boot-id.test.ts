describe("runtime boot identity", () => {
  const originalBootId = process.env.CTS_RUNTIME_BOOT_ID
  const originalStartedAt = process.env.CTS_RUNTIME_STARTED_AT

  beforeEach(() => {
    jest.resetModules()
    delete (globalThis as any).__cts_runtime_boot_id
    delete (globalThis as any).__cts_runtime_started_at
  })

  afterEach(() => {
    if (originalBootId === undefined) delete process.env.CTS_RUNTIME_BOOT_ID
    else process.env.CTS_RUNTIME_BOOT_ID = originalBootId
    if (originalStartedAt === undefined) delete process.env.CTS_RUNTIME_STARTED_AT
    else process.env.CTS_RUNTIME_STARTED_AT = originalStartedAt
  })

  test("uses the launcher identity across independently loaded modules", async () => {
    process.env.CTS_RUNTIME_BOOT_ID = " shared boot/id "
    process.env.CTS_RUNTIME_STARTED_AT = "2026-08-15T02:00:00.000Z"
    const first = await import("@/lib/runtime-boot-id")
    jest.resetModules()
    const second = await import("@/lib/runtime-boot-id")

    expect(first.getRuntimeBootId()).toBe("shared_boot_id")
    expect(second.getRuntimeBootId()).toBe("shared_boot_id")
    expect(second.getRuntimeStartedAt()).toBe("2026-08-15T02:00:00.000Z")
  })

  test("keeps one process-local fallback when a custom launcher omits the env", async () => {
    delete process.env.CTS_RUNTIME_BOOT_ID
    delete process.env.CTS_RUNTIME_STARTED_AT
    const runtime = await import("@/lib/runtime-boot-id")

    expect(runtime.getRuntimeBootId()).toMatch(/^boot_\d+_\d+_/)
    expect(runtime.getRuntimeBootId()).toBe(runtime.getRuntimeBootId())
    expect(Number.isFinite(Date.parse(runtime.getRuntimeStartedAt()))).toBe(true)
  })
})
