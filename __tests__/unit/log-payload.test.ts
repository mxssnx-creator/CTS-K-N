import { boundedLogLimit, compactLogValue, serializeLogValue } from "@/lib/log-payload"

describe("bounded diagnostic payloads", () => {
  it("detaches large arrays and cyclic object graphs before buffering", () => {
    const source: any = { symbol: "BTCUSDT", candles: Array.from({ length: 50_000 }, (_, i) => ({ price: i })) }
    source.self = source
    const snapshot = compactLogValue(source)
    source.candles[0].price = -1
    expect(snapshot.candles[0].price).toBe(0)
    expect(snapshot.candles.length).toBeLessThanOrEqual(13)
    expect(snapshot.self).toBe("[circular]")
    expect(serializeLogValue(source).length).toBeLessThanOrEqual(8192)
  })
  it("preserves valid JSON when control characters expand during encoding", () => {
    const encoded = serializeLogValue(Object.fromEntries(Array.from({ length: 24 }, (_, i) => [i, "\u0000".repeat(5000)])))
    expect(encoded.length).toBeLessThanOrEqual(8192)
    expect(() => JSON.parse(encoded)).not.toThrow()
  })
  it("omits credentials and does not run diagnostic getters", () => {
    const value = { apiKey: "test-secret", secret: "test-secret", get expensive() { throw new Error("getter must not run") }, zero: 0, disabled: false }
    expect(compactLogValue(value)).toMatchObject({ apiKey: "[redacted]", secret: "[redacted]", expensive: "[accessor omitted]", zero: 0, disabled: false })
  })
  it("retains the actionable error and accepts bigint metadata", () => {
    expect(compactLogValue(new Error("Redis unavailable"))).toMatchObject({ message: "Redis unavailable", name: "Error" })
    expect(JSON.parse(serializeLogValue({ size: 10n }))).toEqual({ size: "10" })
  })
  it.each([[undefined, 100], [Infinity, 100], [NaN, 100], [-1, 1], [0, 1], [1e9, 500], [20.9, 20]])("clamps unsafe log read limit %s", (input, expected) => {
    expect(boundedLogLimit(input)).toBe(expected)
  })
})
