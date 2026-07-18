#!/usr/bin/env node

/**
 * Generate deterministic, machine-readable inventories for the recreation kit.
 *
 * The human documentation explains system intent. These manifests make the
 * inventory auditable against the checked-in source without relying on a stale
 * hand-maintained list.
 */

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const root = process.cwd()
const outputDir = path.join(root, "docs", "recreation", "manifests")
const outputPrefix = "docs/recreation/manifests/"

if (!existsSync(path.join(root, "package.json")) || !existsSync(path.join(root, "app"))) {
  throw new Error("Run this command from the CTS-K-N repository root")
}

mkdirSync(outputDir, { recursive: true })

function walk(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(absolute) : [absolute]
  })
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/")
}

function cleanCell(value) {
  return String(value ?? "").replaceAll("\t", " ").replaceAll("\r", " ").replaceAll("\n", " ")
}

function toTsv(headers, rows) {
  return `${headers.join("\t")}\n${rows
    .map((row) => headers.map((header) => cleanCell(row[header])).join("\t"))
    .join("\n")}\n`
}

function write(name, contents) {
  writeFileSync(path.join(outputDir, name), contents.endsWith("\n") ? contents : `${contents}\n`, "utf8")
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

const apiRows = walk(path.join(root, "app", "api"))
  .filter((file) => file.endsWith(`${path.sep}route.ts`))
  .map((file) => {
    const source = relative(file)
    const body = readFileSync(file, "utf8")
    const route = `/${source.replace(/^app\//, "").replace(/\/route\.ts$/, "")}`
    const methods = [...new Set(
      [...body.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1]),
    )].sort()
    const maxDuration = body.match(/export\s+const\s+maxDuration\s*=\s*([0-9]+)/)?.[1] || ""
    const dynamic = body.match(/export\s+const\s+dynamic\s*=\s*["']([^"']+)["']/)?.[1] || ""
    const authSignals = []
    if (/ADMIN_SECRET|requireAdmin|verifyAdmin|admin-auth/.test(body)) authSignals.push("admin")
    if (/CRON_SECRET|cron-auth|verifyCron|authorizeCron/.test(body)) authSignals.push("cron")
    if (/requireAuth|auth\/me|verifyToken|getCurrentUser|session/i.test(body)) authSignals.push("session")
    return {
      route,
      methods: methods.join(","),
      group: route.split("/")[2] || "root",
      dynamic,
      max_duration_seconds: maxDuration,
      auth_signals: authSignals.join(",") || "none-detected",
      source,
    }
  })
  .sort((a, b) => a.route.localeCompare(b.route))

write(
  "api-routes.tsv",
  toTsv(
    ["route", "methods", "group", "dynamic", "max_duration_seconds", "auth_signals", "source"],
    apiRows,
  ),
)

const pageRows = walk(path.join(root, "app"))
  .filter((file) => file.endsWith(`${path.sep}page.tsx`))
  .map((file) => {
    const source = relative(file)
    const body = readFileSync(file, "utf8")
    const pagePath = source
      .replace(/^app/, "")
      .replace(/\/page\.tsx$/, "")
      .replace(/\/\([^/]+\)/g, "") || "/"
    const components = [...body.matchAll(/from\s+["']@\/components\/([^"']+)["']/g)]
      .map((match) => match[1])
      .sort()
    return {
      route: pagePath,
      dynamic_segments: (pagePath.match(/\[[^\]]+\]/g) || []).join(","),
      imported_components: components.join(","),
      source,
    }
  })
  .sort((a, b) => a.route.localeCompare(b.route))

write(
  "ui-pages.tsv",
  toTsv(["route", "dynamic_segments", "imported_components", "source"], pageRows),
)

const trackedFiles = git(["ls-files", "-z"])
  .split("\0")
  .filter(Boolean)
  .sort()

const environmentUses = new Map()
function addEnvironmentUse(name, source, kind) {
  if (!environmentUses.has(name)) environmentUses.set(name, { sources: new Set(), kinds: new Set() })
  environmentUses.get(name).sources.add(source)
  environmentUses.get(name).kinds.add(kind)
}

for (const source of trackedFiles) {
  const file = path.join(root, source)
  if (!existsSync(file) || statSync(file).size > 5_000_000) continue
  let body
  try {
    body = readFileSync(file, "utf8")
  } catch {
    continue
  }
  for (const pattern of [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  ]) {
    for (const match of body.matchAll(pattern)) addEnvironmentUse(match[1], source, "direct-reference")
  }
}

const envExample = readFileSync(path.join(root, ".env.example"), "utf8")
for (const match of envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
  addEnvironmentUse(match[1], ".env.example", "documented")
}

const platformVariables = new Set([
  "AWS_LAMBDA_FUNCTION_NAME", "CI", "JEST_WORKER_ID", "NEXT_PHASE", "NEXT_RUNTIME", "NODE_ENV",
  "VERCEL", "VERCEL_ENV", "VERCEL_GIT_COMMIT_SHA", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL",
])

const environmentRows = [...environmentUses.entries()]
  .map(([name, usage]) => {
    const sources = [...usage.sources].sort()
    const runtimeSources = sources.filter((source) =>
      !source.startsWith("__tests__/") &&
      !source.startsWith("scripts/") &&
      !source.endsWith(".md") &&
      source !== ".env.example",
    )
    const sensitive = /(?:SECRET|TOKEN|PASSWORD|ENCRYPTION_KEY|API_?KEY|DATABASE_URL|REDIS_URL|KV_URL)$/.test(name)
    let scope = runtimeSources.length > 0 ? "application-runtime" : "test-or-operator-tool"
    if (platformVariables.has(name)) scope = "platform-provided"
    return {
      variable: name,
      scope,
      sensitive: sensitive ? "yes" : "no",
      in_env_example: usage.sources.has(".env.example") ? "yes" : "no",
      source_count: sources.length,
      sources: sources.join(","),
    }
  })
  .sort((a, b) => a.variable.localeCompare(b.variable))

write(
  "environment-variables.tsv",
  toTsv(["variable", "scope", "sensitive", "in_env_example", "source_count", "sources"], environmentRows),
)

const migrationBody = readFileSync(path.join(root, "lib", "redis-migrations.ts"), "utf8")
const migrationRows = []
const migrationPattern = /name:\s*["']([^"']+)["']\s*,\s*\n\s*version:\s*(\d+)|version:\s*(\d+)\s*,\s*\n\s*name:\s*["']([^"']+)["']/g
for (const match of migrationBody.matchAll(migrationPattern)) {
  migrationRows.push({
    version: Number(match[2] || match[3]),
    name: match[1] || match[4],
    source: "lib/redis-migrations.ts",
  })
}
migrationRows.sort((a, b) => a.version - b.version)
write("redis-migrations.tsv", toTsv(["version", "name", "source"], migrationRows))

const testRows = trackedFiles
  .filter((source) =>
    source.startsWith("__tests__/") ||
    source.startsWith("scripts/regression/") ||
    /(?:^|\/)(?:test|verify|validate|stress|diagnose|autotest)[^/]*\.(?:[cm]?js|tsx?)$/.test(source),
  )
  .map((source) => {
    let category = "operator-tool"
    if (source.includes("/__tests__/unit/") || source.startsWith("__tests__/unit/")) category = "unit"
    else if (source.includes("/__tests__/integration/") || source.startsWith("__tests__/integration/")) category = "integration"
    else if (source.includes("/__tests__/e2e/") || source.startsWith("__tests__/e2e/")) category = "e2e"
    else if (source.startsWith("scripts/regression/")) category = "regression"
    else if (/stress|soak/.test(source)) category = "performance"
    else if (/deploy|prod-preview|prod-ui/.test(source)) category = "deployment"
    return { category, source }
  })
  .sort((a, b) => a.category.localeCompare(b.category) || a.source.localeCompare(b.source))

write("tests-and-verifiers.tsv", toTsv(["category", "source"], testRows))

const fileRows = trackedFiles
  .filter((source) => !source.startsWith(outputPrefix))
  .map((source) => {
    const file = path.join(root, source)
    const stat = statSync(file)
    return {
      sha256: sha256(file),
      bytes: stat.size,
      source,
    }
  })

write("project-files.tsv", toTsv(["sha256", "bytes", "source"], fileRows))
write("source-tree.txt", `${trackedFiles.filter((source) => !source.startsWith(outputPrefix)).join("\n")}\n`)

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
const apiGroupSummary = Object.fromEntries(
  [...new Set(apiRows.map((row) => row.group))].sort().map((group) => {
    const routes = apiRows.filter((row) => row.group === group)
    return [group, {
      routes: routes.length,
      methods: routes.reduce((sum, row) => sum + (row.methods ? row.methods.split(",").length : 0), 0),
    }]
  }),
)

const summary = {
  project: "CTS-K-N",
  baselineCommit: git(["rev-parse", "HEAD"]),
  baselineTree: git(["rev-parse", "HEAD^{tree}"]),
  commitTimestamp: git(["show", "-s", "--format=%cI", "HEAD"]),
  nodeRequirement: packageJson.engines?.node || null,
  packageManager: packageJson.packageManager || null,
  framework: {
    next: packageJson.dependencies?.next || null,
    react: packageJson.dependencies?.react || null,
    typescript: packageJson.devDependencies?.typescript || null,
  },
  counts: {
    trackedFilesExcludingGeneratedManifests: fileRows.length,
    apiRoutes: apiRows.length,
    apiMethods: apiRows.reduce((sum, row) => sum + (row.methods ? row.methods.split(",").length : 0), 0),
    uiPages: pageRows.length,
    environmentVariables: environmentRows.length,
    redisMigrations: migrationRows.length,
    testsAndVerifiers: testRows.length,
  },
  apiGroups: apiGroupSummary,
  generatedManifestDirectoryExcludedFromProjectFileChecksums: "docs/recreation/manifests/",
}

write("summary.json", `${JSON.stringify(summary, null, 2)}\n`)

console.log(JSON.stringify(summary, null, 2))
