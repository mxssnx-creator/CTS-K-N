#!/usr/bin/env node

/**
 * Release-tree secret guard.
 *
 * The scanner intentionally reports only file/line/key metadata, never the
 * matched value. It covers tracked files plus new non-ignored handoff files so
 * the pre-commit archive cannot silently include a credential omitted from
 * `git grep` or a scan limited to HEAD.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import process from "node:process"

const root = process.cwd()
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
).split("\0").filter(Boolean)

const findings = []
const ignoredLiteralSource = /^(?:__tests__\/|docs\/|scripts\/(?:test-|run-(?:dev|prod)-preview|regression\/))|(?:^|\/)fixtures?\/|(?:^|\/)__mocks__\//
const exampleSource = /(?:^|\/)(?:\.env\.example|\.dev\.vars\.example)$/
const sensitiveName = /(?:api_?(?:key|secret)|(?:admin|cron|jwt|encryption|auth|access|refresh|client|cloudflare|github|database)_?(?:secret|token|password|key)|password|passwd)$/i
const literalAssignment = /\b([A-Za-z_][A-Za-z0-9_]*)\b\s*[:=]\s*(["'`])([^"'`\r\n]{8,})\2/g
const providerToken = /\b(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,})\b/g
const privateKey = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]{32,}-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g
const credentialUrl = /\b(?:redis|rediss):\/\/[^\s/:]+:[^\s/@]+@/gi

function lineAt(body, index) {
  return body.slice(0, index).split("\n").length
}

function add(file, body, index, category, key = "") {
  findings.push({ file, line: lineAt(body, index), category, ...(key ? { key } : {}) })
}

function placeholder(value, key) {
  const normalized = value.trim()
  return (
    normalized === key ||
    normalized.length < 8 ||
    /(?:replace|placeholder|example|development|dummy|sample|redacted|masked|changeme|your[_-]|(?:^|[-_])test(?:[-_]|$)|preview|debug|is required|is invalid|is missing)/i.test(normalized) ||
    /(?:process\.env|import\.meta\.env|undefined|null|true|false|\*+|<.*>|\$\{|\$\()/.test(normalized)
  )
}

for (const file of files) {
  if (file === "scripts/scan-release-secrets.mjs") continue
  const absolute = `${root}/${file}`
  if (!existsSync(absolute)) continue
  const stat = statSync(absolute)
  if (!stat.isFile() || stat.size > 5_000_000) continue
  let body
  try {
    body = readFileSync(absolute, "utf8")
  } catch {
    continue
  }

  for (const match of body.matchAll(privateKey)) add(file, body, match.index, "private-key")
  for (const match of body.matchAll(providerToken)) add(file, body, match.index, "provider-token")

  if (!ignoredLiteralSource.test(file) && !exampleSource.test(file)) {
    for (const match of body.matchAll(literalAssignment)) {
      const [, key, , value] = match
      if (sensitiveName.test(key) && !placeholder(value, key)) {
        add(file, body, match.index, "literal-sensitive-assignment", key)
      }
    }
    for (const match of body.matchAll(credentialUrl)) add(file, body, match.index, "credential-url")
  }
}

if (findings.length > 0) {
  console.error(JSON.stringify({ success: false, filesScanned: files.length, findings }, null, 2))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({ success: true, filesScanned: files.length, findings: 0 }))
}
