// Migration 028 — high-perf: axis 800×, real 5000×, rssHard 82%, BingX 5 concurrent, stopSem 6

import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

class EnsurePagesManifestPlugin {
  constructor(distDir) {
    this.distDir = distDir
  }

  apply(compiler) {
    compiler.hooks.afterEmit.tapPromise("CTS-K-N Ensure Pages Manifest", async () => {
      const manifestPath = resolve(this.distDir, "server", "pages-manifest.json")
      const builtInPages = {
        "/_app": "pages/_app.js",
        "/_error": "pages/_error.js",
        "/_document": "pages/_document.js",
      }
      try {
        const parsed = JSON.parse(await readFile(manifestPath, "utf8"))
        if (parsed && typeof parsed === "object") {
          await Promise.all(Object.keys(builtInPages).map((route) =>
            access(resolve(this.distDir, "server", parsed[route] || builtInPages[route])),
          ))
          return
        }
      } catch {
        // The Next 15 multi-compiler can briefly omit this file on overlay
        // filesystems. Reconstruct the built-in Pages Router entries below.
      }

      const existingEntries = []
      for (const [route, relativeFile] of Object.entries(builtInPages)) {
        try {
          await access(resolve(this.distDir, "server", relativeFile))
          existingEntries.push([route, relativeFile])
        } catch {
          // A non-Node compiler does not emit these files. The plugin is only
          // registered for the normal Node server compiler below.
        }
      }
      if (existingEntries.length !== Object.keys(builtInPages).length) return

      await mkdir(resolve(this.distDir, "server"), { recursive: true })
      await writeFile(manifestPath, `${JSON.stringify(Object.fromEntries(existingEntries), null, 2)}\n`)
      console.warn(`[next-build] restored missing ${manifestPath} after server emit`)
    })
  }
}

const localServerActionAllowedOrigins = ["localhost:3002", "127.0.0.1:3002"]
function normalizeAllowedOrigin(value) {
  const trimmed = value?.trim()
  if (!trimmed) return []

  try {
    return [new URL(trimmed).host]
  } catch {
    return [trimmed.replace(/^https?:\/\//, "").replace(/\/.*$/, "")]
  }
}

function getServerActionAllowedOrigins() {
  const configuredOrigins = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.SERVER_ACTION_ALLOWED_ORIGINS,
  ]
    .flatMap((value) => value?.split(",") ?? [])
    .flatMap(normalizeAllowedOrigin)
    .filter(Boolean)

  const origins =
    process.env.NODE_ENV === "production"
      ? configuredOrigins
      : [...configuredOrigins, ...localServerActionAllowedOrigins]

  return [...new Set(origins)]
}
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow a separate build output directory (e.g. for running a production
  // `next start` alongside a `next dev` on the same project). Defaults to
  // ".next". Set NEXT_DIST_DIR only when building/starting production so the
  // dev server keeps using the default ".next".
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Production prebuild removes the exact selected dist directory itself; a
  // second multi-compiler cleanup can race provider manifests on overlay
  // filesystems. Development is different: its on-demand compiler must own
  // initialization/cleanup of webpack-runtime and font manifests.
  cleanDistDir: process.env.NODE_ENV !== "production",
  reactStrictMode: false,
  typescript: {
    // Production deployments must fail on type or syntax drift instead of
    // shipping a partially-compiled bundle.
    ignoreBuildErrors: false,
  },
  eslint: {
    // Keep lint validation enabled during builds so deployment catches the
    // same issues local checks catch before runtime.
    ignoreDuringBuilds: false,
  },
  images: {
    unoptimized: true,
  },
  turbopack: {},
  // Keep Node-only / native / optionally-peered modules external so webpack
  // does not try to bundle them (which breaks the build) and Node resolves
  // them at runtime instead. In particular bingx-api ships a NestJS module
  // tree (@nestjs/common) whose optional peers (class-validator /
  // class-transformer) break webpack bundling when inlined.
  //
  // NOTE: there must be exactly ONE `serverExternalPackages` key. A duplicate
  // key silently drops the first declaration, which previously left
  // @nestjs/common / class-validator / class-transformer un-externalized and
  // broke production bundling. This single list is the complete set.
  serverExternalPackages: [
    "redis",
    "@redis/client",
    "bingx-api",
    "@nestjs/common",
    "class-validator",
    "class-transformer",
  ],
  // ── Tier-3 perf: prod-only console removal ───────────────────────
  // Strips `console.log` / `console.debug` / `console.info` from
  // production client + server bundles, keeping `console.error` and
  // `console.warn` for crash diagnostics. Dev mode is untouched, so
  // local debugging still sees `[v0]` traces, hot-reload logs, etc.
  // The volume of strategy/coordination logs in this codebase is
  // substantial — each call is a serialisation + I/O cost on the
  // hot path that we don't want shipping to production users.
  compiler: {
    removeConsole:
      process.env.NODE_ENV === "production"
        ? { exclude: ["error", "warn"] }
        : false,
  },
  experimental: {
    serverActions: {
      allowedOrigins: getServerActionAllowedOrigins(),
    },
    // Next 15 races final manifest/export writes on this overlay filesystem.
    // It was first visible in the side-by-side `.next-prod` build and is also
    // reproducible in OpenNext's normal `.next` build as a zero-byte
    // routes-manifest.json after all 40 pages rendered. Serial generation is a
    // build-time setting only; it makes every provider artifact deterministic
    // without reducing request/runtime processing concurrency.
    ...(process.env.NODE_ENV === "production"
      ? {
          cpus: 1,
          staticGenerationMaxConcurrency: 1,
          staticGenerationMinPagesPerWorker: 1,
        }
      : {}),
    // instrumentation.ts is auto-discovered by Next.js and remains the
    // deterministic server-side boot sequence entry point.
  },
  // Production-specific headers for performance
  async headers() {
    return process.env.NODE_ENV === "production" ? [
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
      {
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ] : []
  },
  // Production-specific redirects for health checks and monitoring
  async redirects() {
    return process.env.NODE_ENV === "production" ? [
      {
        source: "/health",
        destination: "/api/system/status",
        permanent: false,
      },
    ] : []
  },
  webpack: (config, { isServer, nextRuntime, webpack, dev }) => {
    config.resolve = config.resolve || {}
    config.plugins = config.plugins || []

    // Strip the `node:` URI scheme so Webpack 5 can resolve Node built-ins
    // on both server and edge targets without UnhandledSchemeError.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
        resource.request = resource.request.replace(/^node:/, "")
      }),
    )

    // Next 15 occasionally reaches page-data collection without the small
    // built-in Pages Router manifest in either the normal or isolated dist
    // directory on overlay filesystems. Validate the three built-in chunks and
    // repair only the missing manifest after the Node server emit.
    if (
      !dev &&
      isServer &&
      nextRuntime !== "edge"
    ) {
      config.plugins.push(new EnsurePagesManifestPlugin(process.env.NEXT_DIST_DIR || ".next"))
    }

    // Redis v6 optionally imports native @node-rs/xxhash for faster client-side
    // hashing. The package marks it optional, but Next dev still warns loudly
    // when it cannot resolve it from pnpm's optional dependency layout. Stub the
    // optional native helper in all bundles; Redis falls back to its JS path.
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@node-rs/xxhash": false,
    }

    // Browser bundle: alias Node built-ins to empty stubs.
    if (!isServer) {
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        diagnostics_channel: false,
        "node:diagnostics_channel": false,
        net: false,
        "node:net": false,
        tls: false,
        "node:tls": false,
        dns: false,
        "dns/promises": false,
        "node:dns": false,
        "node:dns/promises": false,
        assert: false,
        "node:assert": false,
        perf_hooks: false,
        "node:perf_hooks": false,
        events: false,
        "node:events": false,
      }
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        crypto: false,
        stream: false,
        buffer: false,
        diagnostics_channel: false,
      }
    }

    // Edge runtime: stub every Node built-in that server-side libs import.
    // IMPORTANT: do not apply these aliases to the normal Node server bundle.
    // Production webpack compilation is the only mode that bundles route code;
    // aliasing `net`/`tls`/`dns`/`events` to `false` there makes Redis,
    // exchange SDKs, and Node HTTP clients resolve to empty modules. Dev mode
    // does not hit that bundled path, which is why production alone saw
    // stalls/crashes. Keep the stubs scoped to browser/edge only.
    if (nextRuntime === "edge") {
      const nodeBuiltinsToStub = [
        "diagnostics_channel",
        "net",
        "tls",
        "dns",
        "dns/promises",
        "assert",
        "perf_hooks",
        "crypto",
        "fs",
        "fs/promises",
        "path",
        "stream",
        "buffer",
        "events",
        "timers",
        "timers/promises",
        "os",
        "url",
        "util",
        "zlib",
      ]
      const stubAliases = {}
      for (const name of nodeBuiltinsToStub) {
        stubAliases[name] = false
        stubAliases[`node:${name}`] = false
      }
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        ...stubAliases,
      }
    }

    return config
  },
}

export default nextConfig
