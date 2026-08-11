import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const originalCwd = process.cwd()
const originalNodeEnv = process.env.NODE_ENV
const bingxCredentialEnvNames = [
  "BINGX_API_KEY",
  "BINGX_APIKEY",
  "NEXT_BINGX_API_KEY",
  "BINGX_API_SECRET",
  "BINGX_SECRET_KEY",
  "BINGX_SECRET",
  "NEXT_BINGX_API_SECRET",
] as const
const originalBingxEnvironment = Object.fromEntries(
  bingxCredentialEnvNames.map((name) => [name, process.env[name]]),
) as Record<(typeof bingxCredentialEnvNames)[number], string | undefined>

function clearBingxCredentialEnvironment(): void {
  for (const name of bingxCredentialEnvNames) delete process.env[name]
}

function restoreEnv(): void {
  process.chdir(originalCwd)
  process.env.NODE_ENV = originalNodeEnv
  for (const name of bingxCredentialEnvNames) {
    const value = originalBingxEnvironment[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

afterEach(restoreEnv)

async function importCredentialLoaderWithoutServerDotenv() {
  const isolatedCwd = mkdtempSync(join(tmpdir(), "cts-env-credentials-"))
  const previousCwd = process.cwd()
  try {
    process.chdir(isolatedCwd)
    jest.resetModules()
    return await import("@/lib/base-connection-credentials")
  } finally {
    process.chdir(previousCwd)
    rmSync(isolatedCwd, { recursive: true, force: true })
  }
}

test("loads bingx-x01 credentials from server environment variables", async () => {
  process.env.NODE_ENV = "production"
  clearBingxCredentialEnvironment()
  process.env.BINGX_API_KEY = "env-key-override-1234567890"
  process.env.BINGX_API_SECRET = "env-secret-override-1234567890"
  const { getBaseConnectionCredentials } = await importCredentialLoaderWithoutServerDotenv()
  expect(getBaseConnectionCredentials("bingx-x01")).toEqual({
    apiKey: "env-key-override-1234567890",
    apiSecret: "env-secret-override-1234567890",
  })
})

test("returns empty credentials when no server environment credential is present", async () => {
  process.env.NODE_ENV = "production"
  clearBingxCredentialEnvironment()
  const { getBaseConnectionCredentials } = await importCredentialLoaderWithoutServerDotenv()
  const creds = getBaseConnectionCredentials("bingx-x01")
  expect(creds.apiKey).toBe("")
  expect(creds.apiSecret).toBe("")
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
