import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"

describe("indication history writes under pressure", () => {
  test.each([
    "OOM command not allowed when used memory > 'maxmemory'.",
    "Socket closed unexpectedly",
    "READONLY You can't write against a read only replica.",
  ])("preserves existing history after %s", async (message) => {
    const processor = Object.create(IndicationSetsProcessor.prototype) as any
    processor.readIndicationSetEntries = jest.fn()
    const error = new Error(message)
    const client = { rpush: jest.fn().mockRejectedValue(error), del: jest.fn() }
    await expect(processor.appendIndicationEntries(client, "indication_set:test", ['{"id":1}'], { floor: 250, thresholdPct: 20 }))
      .rejects.toBe(error)
    expect(processor.readIndicationSetEntries).not.toHaveBeenCalled()
    expect(client.del).not.toHaveBeenCalled()
    expect(client.rpush).toHaveBeenCalledTimes(1)
  })
})
