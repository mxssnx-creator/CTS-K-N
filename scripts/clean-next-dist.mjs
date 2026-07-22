#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

const projectRoot = resolve(process.cwd())
const configured = process.env.NEXT_DIST_DIR || ".next"
const target = resolve(projectRoot, configured)
const targetName = basename(target)

if (dirname(target) !== projectRoot || !targetName.startsWith(".next")) {
  throw new Error(`Refusing to clean unsafe Next dist directory: ${configured}`)
}

const sleepArray = new Int32Array(new SharedArrayBuffer(4))
for (let attempt = 1; attempt <= 12; attempt += 1) {
  rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  if (!existsSync(target)) process.exit(0)
  if (attempt < 12) Atomics.wait(sleepArray, 0, 0, attempt * 100)
}

throw new Error(`Could not clean Next dist directory after bounded retries: ${configured}`)
