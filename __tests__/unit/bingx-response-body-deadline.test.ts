import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

function connector() {
  const value = new BingXConnector({ apiKey: "", apiSecret: "", isTestnet: true }) as any
  value.timeout = 25
  return value
}

describe("BingX complete response-body deadline", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test("headers without a complete body time out and cancel the stream", async () => {
    const cancel = jest.fn()
    const response = new Response(new ReadableStream({ cancel }))
    const result = expect(connector().safeJson(response)).rejects.toThrow(/BingX response body/)
    await jest.advanceTimersByTimeAsync(25)
    await result
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
  })

  test("small chunks cannot keep extending the whole-body deadline", async () => {
    const cancel = jest.fn()
    let controller: ReadableStreamDefaultController<Uint8Array>
    const response = new Response(new ReadableStream({
      start(value) { controller = value }, cancel,
    }))
    const result = expect(connector().safeJson(response)).rejects.toThrow(/BingX response body/)
    controller!.enqueue(new TextEncoder().encode('{"code":'))
    await jest.advanceTimersByTimeAsync(15)
    controller!.enqueue(new TextEncoder().encode('0,"data":'))
    await jest.advanceTimersByTimeAsync(10)
    await result
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test("complete chunked UTF-8 JSON retains exact large order identifiers", async () => {
    const bytes = new TextEncoder().encode('{"code":0,"data":{"orderId":2120501982661271553,"note":"€"}}')
    const response = new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1))
        controller.close()
      },
    }))
    await expect(connector().safeJson(response)).resolves.toMatchObject({
      code: 0, data: { orderId: "2120501982661271553", note: "€" },
    })
    expect(response.body?.locked).toBe(false)
  })
})
