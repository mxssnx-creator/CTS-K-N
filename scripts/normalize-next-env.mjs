#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'

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

// Next automatically appends the active custom dist directory to
// tsconfig.include. Keeping both `.next/types` and `.next-prod/types` makes a
// later standalone `tsc --noEmit` merge two incompatible generated Route
// unions even though each build passed Next's own type validation. The custom
// build has already validated its generated types, so restore the repository's
// canonical single `.next` type universe after that build completes.
const distDir = process.env.NEXT_DIST_DIR || '.next'
if (resolve(distDir) !== resolve('.next') && existsSync('tsconfig.json')) {
  try {
    const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8'))
    const customTypesInclude = `${distDir.replace(/\/+$/, '')}/types/**/*.ts`
    if (Array.isArray(tsconfig.include) && tsconfig.include.includes(customTypesInclude)) {
      tsconfig.include = tsconfig.include.filter((entry) => entry !== customTypesInclude)
      writeFileSync('tsconfig.json', `${JSON.stringify(tsconfig, null, 2)}\n`)
      console.log(`[next-env] removed isolated ${customTypesInclude} from canonical TypeScript includes`)
    }
  } catch (error) {
    throw new Error(`[next-env] could not normalize custom dist TypeScript includes: ${error.message}`)
  }
}

// ── routes-manifest.json cross-copy ────────────────────────────────────────
// When NEXT_DIST_DIR=.next-prod the production build writes the full manifest
// to .next-prod/routes-manifest.json.  The dev server (Turbopack) only writes
// a stub manifest to .next/ which lacks real route entries.  Several compiled
// route bundles (stats, generate-indications, _error fallback) call into
// Next.js internals that read the manifest from .next/ at request time — if
// they see the stub they throw ENOENT and crash.  Copying the real manifest
// into .next/ after each production build prevents the crash.
const src = join(distDir, 'routes-manifest.json')
const dest = join('.next', 'routes-manifest.json')

// Compare canonical paths, not the raw NEXT_DIST_DIR text. Build controllers
// may express the default directory as `.next/` or an absolute path; copying a
// file onto itself truncates it to zero bytes on some filesystems and leaves
// OpenNext with an unreadable manifest.
if (resolve(src) !== resolve(dest) && existsSync(src)) {
  try {
    mkdirSync('.next', { recursive: true })
    copyFileSync(src, dest)
    console.log(`[next-env] copied routes-manifest.json from ${distDir}/ to .next/`)
  } catch (err) {
    // Non-fatal: dev server will regenerate on first request.
    console.warn('[next-env] could not copy routes-manifest.json:', err.message)
  }
}

function isValidJson(filePath) {
  if (!existsSync(filePath)) return false
  try {
    JSON.parse(readFileSync(filePath, 'utf8'))
    return true
  } catch {
    return false
  }
}

function writeJsonAtomically(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, filePath)
}

function collectFiles(rootPath, suffix) {
  if (!existsSync(rootPath)) return []
  const files = []
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = join(rootPath, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(entryPath, suffix))
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(entryPath)
  }
  return files
}

// A successful Next 15 build can occasionally leave both prerender-manifest
// copies at zero bytes on overlay filesystems. The rendered HTML/RSC output is
// already complete at this point, so reconstruct the small routing index from
// those build-owned files. This is safer than retrying or copying a manifest
// from a different build ID.
function reconstructPrerenderManifest(serverAppRoot) {
  const bypass = [
    { type: 'header', key: 'next-action' },
    { type: 'header', key: 'content-type', value: 'multipart/form-data;.*' },
  ]
  const allowHeader = [
    'host',
    'x-matched-path',
    'x-prerender-revalidate',
    'x-prerender-revalidate-if-generated',
    'x-next-revalidated-tags',
    'x-next-revalidate-tag-token',
  ]
  const routes = {}
  for (const htmlPath of collectFiles(serverAppRoot, '.html').sort()) {
    const relativeHtml = relative(serverAppRoot, htmlPath).split(sep).join('/')
    const withoutExtension = relativeHtml.slice(0, -'.html'.length)
    if (withoutExtension.includes('[')) continue
    const route = withoutExtension === 'index' ? '/' : `/${withoutExtension}`
    const relativeRsc = `${withoutExtension}.rsc`
    if (!existsSync(join(serverAppRoot, relativeRsc))) continue
    routes[route] = {
      ...(route === '/_not-found' ? { initialStatus: 404 } : {}),
      experimentalBypassFor: bypass,
      initialRevalidateSeconds: false,
      srcRoute: route,
      dataRoute: `/${relativeRsc}`,
      allowHeader,
    }
  }
  if (Object.keys(routes).length === 0) {
    throw new Error(`[next-env] cannot reconstruct prerender-manifest.json: no rendered app routes in ${serverAppRoot}`)
  }
  return {
    version: 4,
    routes,
    dynamicRoutes: {},
    notFoundRoutes: [],
    preview: {
      previewModeId: randomBytes(16).toString('hex'),
      previewModeSigningKey: randomBytes(32).toString('hex'),
      previewModeEncryptionKey: randomBytes(32).toString('hex'),
    },
  }
}

const prerenderManifest = join(distDir, 'prerender-manifest.json')
const standalonePrerenderManifest = join(distDir, 'standalone', '.next', 'prerender-manifest.json')
if (!isValidJson(prerenderManifest)) {
  if (isValidJson(standalonePrerenderManifest)) {
    copyFileSync(standalonePrerenderManifest, prerenderManifest)
    console.warn(`[next-env] restored invalid ${prerenderManifest} from standalone build output`)
  } else {
    const reconstructed = reconstructPrerenderManifest(join(distDir, 'server', 'app'))
    writeJsonAtomically(prerenderManifest, reconstructed)
    console.warn(`[next-env] reconstructed invalid ${prerenderManifest} from rendered app routes`)
  }
}
if (!isValidJson(prerenderManifest)) {
  throw new Error(`[next-env] ${prerenderManifest} is missing or is not valid JSON`)
}
if (existsSync(join(distDir, 'standalone')) && !isValidJson(standalonePrerenderManifest)) {
  mkdirSync(dirname(standalonePrerenderManifest), { recursive: true })
  copyFileSync(prerenderManifest, standalonePrerenderManifest)
  console.warn(`[next-env] synchronized invalid ${standalonePrerenderManifest}`)
}

// Next 15 can leave export-marker.json as a zero-byte file after an otherwise
// successful provider build. @vercel/next parses this build-owned marker before
// packaging functions and fails with `Unexpected end of JSON input`. CTS-K-N
// does not define exportPathMap/static export; rebuild only an absent/invalid
// marker from the serialized Next config and validate the result immediately.
const exportMarker = join(distDir, 'export-marker.json')
const requiredServerFiles = join(distDir, 'required-server-files.json')
const serializedNextConfig = isValidJson(requiredServerFiles)
  ? JSON.parse(readFileSync(requiredServerFiles, 'utf8'))?.config ?? {}
  : {}

// OpenNext reads this file immediately after the Next lifecycle finishes.
// Next 15 can leave it as a zero-byte file on overlay filesystems even though
// required-server-files.json contains the complete image configuration. Repair
// that exact build-owned contract before provider packaging begins.
const imagesManifest = join(distDir, 'images-manifest.json')
if (!isValidJson(imagesManifest)) {
  const images = serializedNextConfig.images && typeof serializedNextConfig.images === 'object'
    ? serializedNextConfig.images
    : {}
  writeFileSync(imagesManifest, `${JSON.stringify({ version: 1, images }, null, 2)}\n`)
  console.warn(`[next-env] restored invalid ${imagesManifest} from serialized Next config`)
}
if (!isValidJson(imagesManifest)) {
  throw new Error(`[next-env] ${imagesManifest} is missing or is not valid JSON`)
}

const isStaticExport = serializedNextConfig.output === 'export'
if (!isValidJson(exportMarker)) {
  if (isStaticExport) {
    throw new Error(`[next-env] ${exportMarker} is invalid for an output: export build`)
  }
  writeFileSync(exportMarker, `${JSON.stringify({
    version: 1,
    hasExportPathMap: false,
    exportTrailingSlash: serializedNextConfig.trailingSlash === true,
    isNextImageImported: false,
  }, null, 2)}\n`)
  console.warn(`[next-env] restored invalid ${exportMarker} for provider packaging`)
}

if (!isValidJson(exportMarker)) {
  throw new Error(`[next-env] ${exportMarker} is missing or is not valid JSON`)
}

// A late Next 15 export worker can also recreate export-detail.json after the
// normal server build has already unlinked it. @vercel/next interprets any
// successful export detail as an intentional static-only deployment and drops
// every API/server function. Preserve it only for an explicit output: export.
const exportDetail = join(distDir, 'export-detail.json')
if (!isStaticExport && existsSync(exportDetail)) {
  unlinkSync(exportDetail)
  console.warn(`[next-env] removed stale ${exportDetail} from non-static build`)
}

// Standalone builds keep a second complete manifest. Recover only from that
// build-owned copy and then validate again; never let a successful Next build
// hand an empty/partial routing contract to OpenNext or a production preview.
if (!isValidJson(src)) {
  const standaloneManifest = join(distDir, 'standalone', '.next', 'routes-manifest.json')
  if (resolve(standaloneManifest) !== resolve(src) && isValidJson(standaloneManifest)) {
    copyFileSync(standaloneManifest, src)
    console.warn(`[next-env] restored invalid routes-manifest.json from ${standaloneManifest}`)
  }
}

if (!isValidJson(src)) {
  throw new Error(`[next-env] ${src} is missing or is not valid JSON`)
}
