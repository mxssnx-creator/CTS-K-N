#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startPreviewRedisHarness } from "./preview-redis-harness.mjs"

const state = await mkdtemp(join(tmpdir(), "cts-native-coordination-"))
const redis = await startPreviewRedisHarness({ required: true, label: "native-coordination" })
try {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/verify-native-redis-coordination.ts"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8",
      ...redis.environment, CTS_STATE_DIR: state, CTS_NATIVE_REDIS_VERIFY: "1",
      FORCE_SIMULATED: "1", FORCE_LIVE: "0", ALLOW_LIVE_ORDER_PLACEMENT: "0",
      DISABLE_TRADE_ENGINE_AUTOSTART: "1",
    },
    stdio: "inherit",
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
} finally {
  await redis.stop()
  await rm(state, { recursive: true, force: true })
}
