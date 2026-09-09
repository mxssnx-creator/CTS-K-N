import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

class LogProbe extends BingXConnector {
  constructor() {
    super({ apiKey: "test-log-key", apiSecret: "test-log-secret", isTestnet: true, apiType: "perpetual_futures" })
  }
  info(message: string) { this.log(message) }
  error(message: string) { this.logError(message) }
  summary(message: string) { this.appendLog(message) }
  get records() { return this.logs }
}

describe("long-lived exchange connector diagnostics", () => {
  test("retains only the newest 200 mixed log records without replacing the response array", () => {
    const stderr = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const connector = new LogProbe()
      const responseLogs = connector.records
      for (let i = 0; i < 1_200; i++) {
        if (i % 3 === 0) connector.error(`line-${i}`)
        else if (i % 3 === 1) connector.summary(`line-${i}`)
        else connector.info(`line-${i}`)
      }
      expect(connector.records).toBe(responseLogs)
      expect(connector.records).toHaveLength(200)
      expect(connector.records[0]).toContain("line-1000")
      expect(connector.records.at(-1)).toContain("line-1199")
    } finally { stderr.mockRestore() }
  })

  test("bounds oversized test summaries and emitted errors before retaining or printing them", () => {
    const stderr = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      const connector = new LogProbe()
      connector.summary("x".repeat(1_000_000))
      connector.error("y".repeat(1_000_000))
      expect(connector.records).toHaveLength(2)
      expect(connector.records.every(line => line.length === 2_000 && line.endsWith("…"))).toBe(true)
      expect(String(stderr.mock.calls[0][0]).length).toBeLessThanOrEqual(2_005)
      expect(connector.records[1]).toContain("ERROR:")
    } finally { stderr.mockRestore() }
  })
})
