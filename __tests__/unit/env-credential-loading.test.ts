import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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

test("env var takes precedence over hardcoded default for bingx-x01", async () => {
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

test("hardcoded default is used when no env var is present (production out-of-the-box)", async () => {
  process.env.NODE_ENV = "production"
  delete process.env.BINGX_API_KEY
  delete process.env.BINGX_API_SECRET
  const { getBaseConnectionCredentials } = await import("@/lib/base-connection-credentials")
  const creds = getBaseConnectionCredentials("bingx-x01")
  expect(creds.apiKey.length).toBeGreaterThan(10)
  expect(creds.apiSecret.length).toBeGreaterThan(10)
  expect(creds.apiKey.startsWith("test")).toBe(false)
  restoreEnv()
})
