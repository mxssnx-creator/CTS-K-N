#!/usr/bin/env bash
# Reproducible serverless build for Vercel-compatible builders.

set -Eeuo pipefail

PNPM_VERSION="10.28.1"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

log() { printf '[Serverless Build] %s\n' "$*"; }
fatal() { printf '[Serverless Build] ERROR: %s\n' "$*" >&2; exit 1; }

log "Running reproducible CTS-K-N build prechecks"
command -v node >/dev/null 2>&1 || fatal "Node.js is missing"
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 20 )) || fatal "Node.js 20 or newer is required"

if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null 2>&1 || true
fi
command -v pnpm >/dev/null 2>&1 || fatal "pnpm is missing"
[[ "$(pnpm --version)" == "$PNPM_VERSION" ]] || fatal "pnpm $PNPM_VERSION is required"

if [[ ! -d node_modules ]]; then
  log "node_modules is absent; installing exactly the lockfile"
  pnpm install --frozen-lockfile
fi

mkdir -p data/redis .next/cache
node scripts/verify-source-syntax.mjs
pnpm run typecheck
pnpm run lint

MIGRATION_REPORT="$(node --input-type=module <<'NODE'
import { readFileSync } from "node:fs"
const source = readFileSync("lib/redis-migrations.ts", "utf8")
const versions = Array.from(source.matchAll(/\bversion:\s*(\d+)\s*,/g), match => Number(match[1]))
const latest = Math.max(0, ...versions)
const sequential = versions.every((version, index) => index === 0 || version === versions[index - 1] + 1)
process.stdout.write(JSON.stringify({ latest, total: versions.length, sequential }))
NODE
)"
LATEST_MIGRATION="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).latest))' "$MIGRATION_REPORT")"
SEQUENTIAL="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).sequential))' "$MIGRATION_REPORT")"
[[ "$LATEST_MIGRATION" == "81" && "$SEQUENTIAL" == "true" ]] \
  || fatal "Migration bundle is not the expected sequential schema v81: $MIGRATION_REPORT"
log "Sequential schema v81 migration bundle verified"

pnpm run vercel-build
[[ -f .next/BUILD_ID ]] || fatal "Next.js production build did not create .next/BUILD_ID"
date -u +'%Y-%m-%dT%H:%M:%SZ' > .next/deployment-timestamp.txt
log "Production build completed; runtime startup/migrations remain fail-closed behind shared Redis"
