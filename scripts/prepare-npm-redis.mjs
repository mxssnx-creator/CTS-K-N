#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const packageRoot = process.argv[2]
if (!packageRoot) throw new Error("redis-memory-server package path is required")
const target = path.join(packageRoot, "lib", "util", "RedisBinaryDownload.js")
const source = await readFile(target, "utf8")
if (!source.includes("const makeArgs = [")) throw new Error("Unsupported redis-memory-server compiler")
let patched = source.includes('"MALLOC=libc"')
  ? source
  : source.replace("const makeArgs = [", 'const makeArgs = [\n                "MALLOC=libc",')

// Redis stable source releases can include optional modules whose top-level
// build requires cmake, Rust, autotools, and other toolchains that are not
// needed by redis-server. Build the core target only. The upstream package
// still copies extracted/src/redis-server to its normal cache location.
const legacyMake = "`make${makeArgs.map((arg) => ` ${arg}`).join('')}`"
const coreMake = "`make -C src redis-server${makeArgs.map((arg) => ` ${arg}`).join('')}`"
if (patched.includes(legacyMake)) patched = patched.replace(legacyMake, coreMake)
if (!patched.includes(coreMake)) throw new Error("Unsupported redis-memory-server make invocation")
await writeFile(target, patched)
console.log(`[cts-local-redis] compiler prepared: ${target}`)
