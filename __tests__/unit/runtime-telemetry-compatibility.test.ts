describe("runtime telemetry compatibility", () => {
  afterEach(() => {
    jest.resetModules()
    jest.dontMock("node:perf_hooks")
  })

  test("does not make Workerd's unimplemented perf hooks a startup dependency", async () => {
    jest.resetModules()
    jest.doMock("node:perf_hooks", () => ({
      monitorEventLoopDelay: jest.fn(() => {
        throw new Error("The monitorEventLoopDelay method is not implemented")
      }),
      performance: {
        eventLoopUtilization: jest.fn(() => {
          throw new Error("The eventLoopUtilization method is not implemented")
        }),
      },
    }))

    const { getRuntimeTelemetry } = await import("@/lib/runtime-telemetry")

    expect(() => getRuntimeTelemetry(16)).not.toThrow()
    expect(getRuntimeTelemetry(16)).toMatchObject({
      concurrency: expect.any(Object),
      memory: {
        rssMB: expect.any(Number),
        heapUsedMB: expect.any(Number),
      },
      eventLoop: {
        utilizationPct: 0,
        delayP50Ms: 0,
        delayP95Ms: 0,
        delayMaxMs: 0,
      },
    })
  })
})
