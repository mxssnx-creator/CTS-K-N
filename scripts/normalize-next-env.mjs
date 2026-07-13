#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const file = 'next-env.d.ts'
if (!existsSync(file)) process.exit(0)

const desired = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
/// <reference path="./.next/types/routes.d.ts" />

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`

const current = readFileSync(file, 'utf8')
if (current !== desired) {
  writeFileSync(file, desired)
  console.log('[next-env] normalized next-env.d.ts route types reference to .next')
}

// ── routes-manifest.json cross-copy ────────────────────────────────────────
// When NEXT_DIST_DIR=.next-prod the production build writes the full manifest
// to .next-prod/routes-manifest.json.  The dev server (Turbopack) only writes
// a stub manifest to .next/ which lacks real route entries.  Several compiled
// route bundles (stats, generate-indications, _error fallback) call into
// Next.js internals that read the manifest from .next/ at request time — if
// they see the stub they throw ENOENT and crash.  Copying the real manifest
// into .next/ after each production build prevents the crash.
const distDir = process.env.NEXT_DIST_DIR || '.next'
const src = join(distDir, 'routes-manifest.json')
const dest = join('.next', 'routes-manifest.json')

if (distDir !== '.next' && existsSync(src)) {
  try {
    mkdirSync('.next', { recursive: true })
    copyFileSync(src, dest)
    console.log(`[next-env] copied routes-manifest.json from ${distDir}/ to .next/`)
  } catch (err) {
    // Non-fatal: dev server will regenerate on first request.
    console.warn('[next-env] could not copy routes-manifest.json:', err.message)
  }
}
