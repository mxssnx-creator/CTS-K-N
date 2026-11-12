import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vstSoakRequestEvidence, writeVstSoakCheckpoint } from "@/lib/bingx-vst-soak-checkpoint"

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "vst-soak-checkpoint-")) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

test("an interrupted venue call leaves the exact pending identity and exposure recoverable without a final report", async () => {
  const path = join(directory, "run.json")
  const checkpoint = { success: false, cleanupComplete: false, recovery: { ownedExposure: [{ symbol: "COTIUSDT", direction: "long", quantity: 243 }], writes: [{ clientOrderId: "owned-close", state: "dispatch-recorded" }] } }
  writeVstSoakCheckpoint(path, checkpoint)
  await expect(Promise.reject(new Error("executor disappeared"))).rejects.toThrow("executor disappeared")
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(checkpoint)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readdirSync(directory)).toEqual(["run.json"])
})

test("atomic replacement leaves a complete shorter report and no temporary recovery files", () => {
  const path = join(directory, "run.json")
  writeVstSoakCheckpoint(path, { cycles: Array(100).fill({ flatAfter: false }) })
  writeVstSoakCheckpoint(path, { success: false, cleanupComplete: true, cycles: [] })
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ success: false, cleanupComplete: true, cycles: [] })
  expect(readdirSync(directory)).toEqual(["run.json"])
})

test("credential redaction failure retains the last valid snapshot and does not expose the credential in the error", () => {
  const path = join(directory, "run.json")
  writeVstSoakCheckpoint(path, { progress: "safe" })
  expect(() => writeVstSoakCheckpoint(path, { accidental: "private-example-secret" }, ["private-example-secret"])).toThrow("Credential redaction invariant")
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ progress: "safe" })
  expect(readdirSync(directory)).toEqual(["run.json"])
})

test("write evidence excludes authentication and preserves conflicting query/body identities for reconciliation", () => {
  const url = new URL("https://open-api-vst.bingx.com/openApi/swap/v2/trade/order?clientOrderID=query-id&quantity=243&signature=private-signature&apiKey=private-key&timestamp=1")
  expect(vstSoakRequestEvidence(url, JSON.stringify({ clientOrderID: "body-id", quantity: 244, reduceOnly: true, apiSecret: "private-secret", extra: { signature: "nested-secret" } }))).toEqual({
    query: { clientOrderID: "query-id", quantity: "243" }, body: { clientOrderID: "body-id", quantity: 244, reduceOnly: true },
  })
})

test("form bodies retain only exact order fields; non-text bodies cannot leak arbitrary bytes", () => {
  const url = new URL("https://open-api-vst.bingx.com/openApi/swap/v2/trade/order")
  expect(vstSoakRequestEvidence(url, "symbol=COTI-USDT&orderId=2120749610172420096&signature=secret")).toEqual({ query: {}, body: { symbol: "COTI-USDT", orderId: "2120749610172420096" } })
  expect(vstSoakRequestEvidence(url, new Uint8Array([1, 2]))).toEqual({ query: {}, body: {} })
})
