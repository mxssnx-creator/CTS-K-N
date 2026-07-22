#!/usr/bin/env node

/**
 * Next's standalone server intentionally excludes public files and the static
 * client bundle. Copy both into the standalone root after every production
 * build so `node .next/standalone/server.js` is a complete self-hosted
 * artifact. This also supports isolated `NEXT_DIST_DIR` production builds.
 */

import { cp, access } from "node:fs/promises"
import { constants } from "node:fs"
import { basename, dirname, resolve } from "node:path"

const projectRoot = resolve(process.cwd())
const configuredDistDir = process.env.NEXT_DIST_DIR || ".next"
const distDir = resolve(projectRoot, configuredDistDir)
const distName = basename(distDir)

if (dirname(distDir) !== projectRoot || !distName.startsWith(".next")) {
  throw new Error(`Refusing to prepare an unsafe standalone directory: ${configuredDistDir}`)
}

const standaloneRoot = resolve(distDir, "standalone")
const serverPath = resolve(standaloneRoot, "server.js")

try {
  await access(serverPath, constants.R_OK)
} catch {
  console.log("[standalone-assets] no standalone server emitted; nothing to prepare")
  process.exit(0)
}

const staticSource = resolve(distDir, "static")
const staticTarget = resolve(standaloneRoot, distName, "static")
const publicSource = resolve(projectRoot, "public")
const publicTarget = resolve(standaloneRoot, "public")

await cp(staticSource, staticTarget, { recursive: true, force: true })
await cp(publicSource, publicTarget, { recursive: true, force: true })

console.log(`[standalone-assets] prepared ${distName}/static and public for standalone startup`)
