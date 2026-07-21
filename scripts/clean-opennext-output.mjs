#!/usr/bin/env node

import { rm } from "node:fs/promises"
import path from "node:path"

const root = process.cwd()
const output = path.resolve(root, ".open-next")
if (path.dirname(output) !== root || path.basename(output) !== ".open-next") {
  throw new Error(`Refusing to clean unexpected OpenNext output path: ${output}`)
}

await rm(output, { recursive: true, force: true })
console.log("[OpenNext] cleaned generated .open-next output")
