#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const packageRoot = process.argv[2]
if (!packageRoot) throw new Error("redis-memory-server package path is required")
const target = path.join(packageRoot, "lib", "util", "RedisBinaryDownload.js")
const source = await readFile(target, "utf8")
if (!source.includes("const makeArgs = [")) throw new Error("Unsupported redis-memory-server compiler")
const patched = source.includes('"MALLOC=libc"')
  ? source
  : source.replace("const makeArgs = [", 'const makeArgs = [\n                "MALLOC=libc",')
await writeFile(target, patched)
console.log(`[cts-local-redis] compiler prepared: ${target}`)
