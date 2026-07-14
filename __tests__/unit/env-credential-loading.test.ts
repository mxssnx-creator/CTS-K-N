import { readFileSync } from "node:fs"
import { join } from "node:path"

const originalCwd = process.cwd()
const originalNodeEnv = process.env.NODE_ENV
const originalKey = process.env.BINGX_API_KEY
const originalSecret = process.env.BINGX_API_SECRET

function restoreEnv(): void {
  process.chdir(originalCwd)
  process.env.NODE_ENV = originalNodeEnv
  if (originalKey === undefined) delete process.env.BINGX_API_KEY
  else process.env.BINGX_API_KEY = originalKey
  if (originalSecret === undefined) delete process.env.BINGX_API_SECRET
  else process.env.BINGX_API_SECRET = originalSecret
}

test("loads bingx-x01 credentials from server environment variables", async () => {
  process.env.NODE_ENV = "production"
  delete process.env.BINGX_API_KEY
  delete process.env.BINGX_API_SECRET
  process.env.BINGX_API_KEY = "env-key-override-1234567890"
  process.env.BINGX_API_SECRET = "env-secret-override-1234567890"
  const { getBaseConnectionCredentials } = await import("@/lib/base-connection-credentials")
  expect(getBaseConnectionCredentials("bingx-x01")).toEqual({
    apiKey: "env-key-override-1234567890",
    apiSecret: "env-secret-override-1234567890",
  })
  restoreEnv()
})

test("does not expose a source fallback when no environment credential is present", async () => {
  process.env.NODE_ENV = "production"
  delete process.env.BINGX_API_KEY
  delete process.env.BINGX_API_SECRET
  const { getBaseConnectionCredentials } = await import("@/lib/base-connection-credentials")
  const creds = getBaseConnectionCredentials("bingx-x01")
  expect(creds).toEqual({ apiKey: "", apiSecret: "" })
  restoreEnv()
})

test("client-imported connection templates never load private or NEXT_PUBLIC exchange credentials", () => {
  const predefinitions = readFileSync(join(process.cwd(), "lib/connection-predefinitions.ts"), "utf8")
  const baseCredentials = readFileSync(join(process.cwd(), "lib/base-connection-credentials.ts"), "utf8")
  const envCredentials = readFileSync(join(process.cwd(), "lib/env-credentials.ts"), "utf8")
  const fileStorage = readFileSync(join(process.cwd(), "lib/file-storage.ts"), "utf8")
  const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf8")

  expect(predefinitions).not.toContain("base-connection-credentials")
  expect(predefinitions).not.toContain('getBaseConnectionCredentials("bingx-x01")')
  expect(baseCredentials).not.toContain("NEXT_PUBLIC_BINGX")
  expect(baseCredentials).not.toContain("NEXT_PUBLIC_BYBIT")
  expect(envCredentials).not.toContain("NEXT_PUBLIC_BINGX")
  expect(fileStorage).not.toMatch(/api_(?:key|secret):\s*"[^"$]{12,}"/)

  for (const line of envExample.split(/\r?\n/)) {
    if (!/^(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*)=/.test(line)) continue
    expect(line.slice(line.indexOf("=") + 1)).toMatch(/^replace_me_/)
  }
})
