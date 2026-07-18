#!/usr/bin/env node

import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const root = process.cwd()
const manifestDir = path.join(root, "docs", "recreation", "manifests")
const failures = []

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function fail(message) {
  failures.push(message)
  console.error(`[Recreation Verify] FAIL ${message}`)
}

function requireFile(name) {
  const file = path.join(manifestDir, name)
  if (!existsSync(file)) throw new Error(`Missing recreation manifest: ${name}`)
  return file
}

const projectFileManifest = requireFile("project-files.tsv")
const lines = readFileSync(projectFileManifest, "utf8").trimEnd().split("\n")
if (lines.shift() !== "sha256\tbytes\tsource") {
  throw new Error("project-files.tsv has an unexpected header")
}

const expectedSources = []
for (const line of lines) {
  const firstTab = line.indexOf("\t")
  const secondTab = line.indexOf("\t", firstTab + 1)
  if (firstTab <= 0 || secondTab <= firstTab) {
    fail(`Malformed project-files.tsv row: ${line.slice(0, 120)}`)
    continue
  }
  const expectedHash = line.slice(0, firstTab)
  const expectedBytes = Number(line.slice(firstTab + 1, secondTab))
  const source = line.slice(secondTab + 1)
  expectedSources.push(source)
  const absolute = path.join(root, source)
  if (!existsSync(absolute)) {
    fail(`Missing project file: ${source}`)
    continue
  }
  const actualBytes = statSync(absolute).size
  if (actualBytes !== expectedBytes) fail(`${source}: expected ${expectedBytes} bytes, found ${actualBytes}`)
  const actualHash = sha256(absolute)
  if (actualHash !== expectedHash) fail(`${source}: SHA-256 mismatch`)
}

const sourceTree = readFileSync(requireFile("source-tree.txt"), "utf8")
  .trimEnd()
  .split("\n")
  .filter(Boolean)
if (JSON.stringify(sourceTree) !== JSON.stringify(expectedSources)) {
  fail("source-tree.txt and project-files.tsv contain different ordered inventories")
}

const summary = JSON.parse(readFileSync(requireFile("summary.json"), "utf8"))
if (summary?.counts?.projectFilesExcludingGeneratedManifests !== expectedSources.length) {
  fail("summary.json project-file count does not match project-files.tsv")
}

if (failures.length > 0) {
  throw new Error(`${failures.length} recreation verification failure(s)`)
}

console.log(JSON.stringify({
  success: true,
  verifiedProjectFiles: expectedSources.length,
  manifestDirectory: "docs/recreation/manifests",
}))
