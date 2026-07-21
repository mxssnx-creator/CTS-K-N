import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { POST } from "@/app/api/install/remote-postgres/route"

const ADMIN_SECRET = "install-test-admin-secret-000000000000"

function remoteRequest(body: Record<string, unknown>, secret = ADMIN_SECRET) {
  return new Request("http://localhost/api/install/remote-postgres", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  })
}

describe("production installation and Kilo deployment contract", () => {
  const previousAdminSecret = process.env.ADMIN_SECRET
  const previousRuntime = process.env.CTS_DEPLOYMENT_RUNTIME
  const previousOwnerUrl = process.env.REMOTE_INSTALL_OWNER_URL
  const previousOwnerSecret = process.env.REMOTE_INSTALL_OWNER_SECRET

  beforeEach(() => {
    process.env.ADMIN_SECRET = ADMIN_SECRET
    process.env.CTS_DEPLOYMENT_RUNTIME = "systemd"
  })

  afterAll(() => {
    if (previousAdminSecret === undefined) delete process.env.ADMIN_SECRET
    else process.env.ADMIN_SECRET = previousAdminSecret
    if (previousRuntime === undefined) delete process.env.CTS_DEPLOYMENT_RUNTIME
    else process.env.CTS_DEPLOYMENT_RUNTIME = previousRuntime
    if (previousOwnerUrl === undefined) delete process.env.REMOTE_INSTALL_OWNER_URL
    else process.env.REMOTE_INSTALL_OWNER_URL = previousOwnerUrl
    if (previousOwnerSecret === undefined) delete process.env.REMOTE_INSTALL_OWNER_SECRET
    else process.env.REMOTE_INSTALL_OWNER_SECRET = previousOwnerSecret
  })

  it("keeps the canonical host installer fail-closed and complete", async () => {
    const [installer, envExample, remoteRoute, vercelConfig] = await Promise.all([
      readFile(path.join(process.cwd(), "scripts/install.sh"), "utf8"),
      readFile(path.join(process.cwd(), ".env.example"), "utf8"),
      readFile(path.join(process.cwd(), "app/api/install/remote-postgres/route.ts"), "utf8"),
      readFile(path.join(process.cwd(), "vercel.json"), "utf8"),
    ])
    expect(installer).toContain('PNPM_VERSION="10.28.1"')
    expect(installer).toContain("--preflight-only")
    expect(installer).toContain("ALLOW_PROD_INLINE_REDIS 0")
    expect(installer).toContain("ALLOW_INLINE_REDIS_LIVE_TRADING 0")
    expect(installer).toContain('upsert_env ENCRYPTION_KEY "$(openssl rand -hex 32)"')
    expect(installer).toContain('upsert_env JWT_SECRET "$(openssl rand -hex 32)"')
    expect(installer).toContain("$APP_NAME-scheduler.service")
    expect(installer).toContain("scripts/run-minute-scheduler.mjs")
    expect(installer).toContain('for runtime_path in node_modules .next scripts package.json')
    expect(installer).toContain('scripts/run-with-env.mjs" "$ENV_FILE" --')
    expect(installer).toContain("REQUIRE_SHARED_PERSISTENCE=1 REQUIRE_FRESH_CONTINUITY=1")
    expect(installer).toContain("site identity did not survive restart")
    expect(installer).not.toContain("FORCE_LIVE=1")
    expect(installer).toContain("ADMIN_SECRET,\nCRON_SECRET, ENCRYPTION_KEY, and JWT_SECRET")
    expect(remoteRoute).toContain('command -v base64 >/dev/null 2>&1 || fatal "base64 is required')
    expect(remoteRoute).toContain('`UserKnownHostsFile=${knownHostsPath}`')
    expect(envExample).not.toMatch(/^[A-Z_][A-Z0-9_]*=[^\r\n#]*[ \t]+#/m)
    expect(envExample).toContain("ENCRYPTION_KEY=replace_me_encryption_key")
    expect(envExample).toContain("NEXT_PUBLIC_APP_URL=http://localhost:3002\n")
    const vercel = JSON.parse(vercelConfig)
    expect(vercel.installCommand).toBe("corepack pnpm@10.28.1 install --frozen-lockfile")
    expect(vercel.buildCommand).toBe("corepack pnpm@10.28.1 run vercel-build")
    expect(vercel.installCommand).not.toContain("corepack enable")
    expect(vercel.buildCommand).not.toContain("vercel-build-setup")
    execFileSync("bash", ["-n", "scripts/install.sh"], { cwd: process.cwd() })
    expect(await readFile(path.join(process.cwd(), "pnpm-workspace.yaml"), "utf8"))
      .toContain("onlyBuiltDependencies:")
  })

  it("passes the executable Kilo/Cloudflare static preflight", () => {
    const output = execFileSync(process.execPath, ["scripts/kilo-deploy-preflight.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
    expect(output).toContain('"success":true')
    expect(output).toContain('"schemaVersion":82')
  })

  it("passes the complete Kilo runtime, owner, and deploy-credential preflight", () => {
    const output = execFileSync(process.execPath, ["scripts/kilo-deploy-preflight.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        KILO_REQUIRE_RUNTIME_ENV: "1",
        KILO_REQUIRE_REMOTE_INSTALL_OWNER: "1",
        KILO_REQUIRE_DEPLOY_CREDENTIALS: "1",
        REDIS_URL: "redis://shared.example.test:6379",
        ADMIN_SECRET: "runtime-admin-secret-0000000000000000",
        CRON_SECRET: "runtime-cron-secret-00000000000000000",
        ENCRYPTION_KEY: "runtime-encryption-key-0000000000000",
        JWT_SECRET: "runtime-jwt-secret-000000000000000000",
        NEXT_PUBLIC_APP_URL: "https://app.example.test",
        REMOTE_INSTALL_OWNER_URL: "https://owner.example.test",
        REMOTE_INSTALL_OWNER_SECRET: "owner-admin-secret-00000000000000000",
        CLOUDFLARE_API_TOKEN: "cloudflare-token-000000000000000000000000",
        CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      },
    })
    expect(output).toContain("a distinct HTTPS long-lived remote-install owner is configured")
    expect(output).toContain("CLOUDFLARE_ACCOUNT_ID is configured")
    expect(output).toContain('"success":true')
  })

  it("uses the fail-closed Kilo deploy owner and required Worker secrets", async () => {
    const [pkg, wrangler, deployScript, buildNormalizer] = await Promise.all([
      readFile(path.join(process.cwd(), "package.json"), "utf8"),
      readFile(path.join(process.cwd(), "wrangler.jsonc"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/kilo-deploy.mjs"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/normalize-next-env.mjs"), "utf8"),
    ])
    expect(pkg).toContain('"kilo:deploy": "node scripts/kilo-deploy.mjs"')
    expect(pkg).toContain("node scripts/clean-opennext-output.mjs && opennextjs-cloudflare build")
    expect(wrangler).toContain('"required": ["ADMIN_SECRET", "CRON_SECRET", "ENCRYPTION_KEY", "JWT_SECRET"]')
    expect(deployScript).toContain('"--secrets-file", secretsFile')
    expect(deployScript).toContain("KILO_REQUIRE_REMOTE_INSTALL_OWNER: \"1\"")
    expect(deployScript).toContain('REQUIRE_SHARED_PERSISTENCE: "1"')
    expect(deployScript).toContain('["scripts/clean-opennext-output.mjs"]')
    expect(deployScript).not.toContain('"CLOUDFLARE_API_TOKEN",')
    expect(await readFile(path.join(process.cwd(), "scripts/verify-deployment-contract.mjs"), "utf8"))
      .toContain('["cloudflare-workers", "kilo-deploy"]')
    const runtimeTest = await readFile(path.join(process.cwd(), "scripts/test-kilo-runtime.mjs"), "utf8")
    expect(runtimeTest).toContain('/api/install/remote-postgres')
    expect(runtimeTest).toContain('remoteInstallRouteFailClosed: true')
    expect(buildNormalizer).toContain("resolve(src) !== resolve(dest)")
    expect(buildNormalizer).toContain("isValidJson(src)")
    expect(buildNormalizer).toContain("standaloneManifest")
    expect(buildNormalizer).toContain("export-marker.json")
    expect(buildNormalizer).toContain("hasExportPathMap: false")
    expect(buildNormalizer).toContain("serializedNextConfig.output === 'export'")
    expect(buildNormalizer).toContain("removed stale ${exportDetail}")
    execFileSync(process.execPath, ["--check", "scripts/kilo-deploy.mjs"], { cwd: process.cwd() })
  })

  it("repairs invalid Next provider markers without false static-export packaging", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cts-vercel-manifests-"))
    const dist = path.join(root, ".next")
    const normalizer = path.join(process.cwd(), "scripts/normalize-next-env.mjs")
    try {
      await mkdir(dist, { recursive: true })
      await Promise.all([
        writeFile(path.join(root, "next-env.d.ts"), ""),
        writeFile(path.join(dist, "routes-manifest.json"), "{}\n"),
        writeFile(path.join(dist, "required-server-files.json"), '{"config":{"trailingSlash":false,"images":{"unoptimized":true,"deviceSizes":[640,1080]}}}\n'),
        writeFile(path.join(dist, "images-manifest.json"), ""),
        writeFile(path.join(dist, "export-marker.json"), ""),
        writeFile(path.join(dist, "export-detail.json"), '{"version":1,"success":true,"outDirectory":"out"}\n'),
      ])

      execFileSync(process.execPath, [normalizer], { cwd: root })
      expect(JSON.parse(await readFile(path.join(dist, "export-marker.json"), "utf8"))).toMatchObject({
        version: 1,
        hasExportPathMap: false,
        exportTrailingSlash: false,
      })
      expect(JSON.parse(await readFile(path.join(dist, "images-manifest.json"), "utf8"))).toMatchObject({
        version: 1,
        images: { unoptimized: true, deviceSizes: [640, 1080] },
      })
      await expect(readFile(path.join(dist, "export-detail.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps custom-dist generated route types out of the canonical tsc universe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cts-next-custom-types-"))
    const dist = path.join(root, ".next-prod")
    const normalizer = path.join(process.cwd(), "scripts/normalize-next-env.mjs")
    try {
      await mkdir(dist, { recursive: true })
      await Promise.all([
        writeFile(path.join(root, "next-env.d.ts"), ""),
        writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
          include: ["**/*.ts", ".next/types/**/*.ts", ".next-prod/types/**/*.ts"],
        })),
        writeFile(path.join(dist, "routes-manifest.json"), "{}\n"),
        writeFile(path.join(dist, "required-server-files.json"), '{"config":{"images":{}}}\n'),
        writeFile(path.join(dist, "images-manifest.json"), "{}\n"),
        writeFile(path.join(dist, "export-marker.json"), "{}\n"),
      ])

      execFileSync(process.execPath, [normalizer], {
        cwd: root,
        env: { ...process.env, NEXT_DIST_DIR: ".next-prod" },
      })
      const tsconfig = JSON.parse(await readFile(path.join(root, "tsconfig.json"), "utf8"))
      expect(tsconfig.include).toEqual(["**/*.ts", ".next/types/**/*.ts"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("generates a byte-verifiable recreation inventory without hashing gitlink directories", async () => {
    const generator = await readFile(
      path.join(process.cwd(), "scripts/generate-recreation-manifests.mjs"),
      "utf8",
    )
    expect(generator).toContain("const projectSourceFiles = trackedFiles.filter")
    expect(generator).toContain("statSync(path.join(root, source)).isFile()")
    expect(generator).toContain("const fileRows = projectSourceFiles")
  })

  it("deduplicates Kilo and independent-server schedulers by durable minute bucket", async () => {
    const continuity = await readFile(path.join(process.cwd(), "app/api/cron/server-continuity/route.ts"), "utf8")
    const recovery = await readFile(path.join(process.cwd(), "app/api/cron/sync-live-positions/route.ts"), "utf8")
    for (const source of [continuity, recovery]) {
      expect(source).toContain("MINUTE_DEDUP_PREFIX")
      expect(source).toContain("Math.floor(")
      expect(source).toContain("{ NX: true, EX: 180 }")
    }
  })

  it("rejects remote installation before parsing or executing without admin authorization", async () => {
    const response = await POST(remoteRequest({ host: "localhost", username: "root" }, "wrong-secret-wrong-secret"))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ success: false, error: "Unauthorized" })
  })

  it("rejects an unsupported remote process runtime before SSH", async () => {
    const response = await POST(remoteRequest({
      mode: "preflight",
      host: "localhost",
      username: "root",
      runtime: "docker",
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Runtime must be auto, systemd, or pm2",
    })
  })

  it("fails closed on Kilo when no long-lived remote-install owner is configured", async () => {
    process.env.CTS_DEPLOYMENT_RUNTIME = "kilo-deploy"
    delete process.env.REMOTE_INSTALL_OWNER_URL
    delete process.env.REMOTE_INSTALL_OWNER_SECRET
    const response = await POST(remoteRequest({ mode: "preflight", host: "localhost", username: "root" }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ success: false })
  })

  it("proxies Kilo remote installs only to an explicitly secured long-lived owner", async () => {
    process.env.CTS_DEPLOYMENT_RUNTIME = "kilo-deploy"
    process.env.REMOTE_INSTALL_OWNER_URL = "https://owner.example.test/control"
    process.env.REMOTE_INSTALL_OWNER_SECRET = "owner-proxy-secret-000000000000"
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ success: true, mode: "preflight" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ))

    try {
      const body = { mode: "preflight", host: "server.example.test", username: "deploy" }
      const response = await POST(remoteRequest(body))
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ success: true, mode: "preflight" })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [target, init] = fetchMock.mock.calls[0]
      expect(String(target)).toBe("https://owner.example.test/api/install/remote-postgres")
      expect(init).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify(body) })
      expect(new Headers(init?.headers).get("authorization"))
        .toBe("Bearer owner-proxy-secret-000000000000")
      expect(new Headers(init?.headers).get("x-cts-install-proxy")).toBe("kilo")
    } finally {
      fetchMock.mockRestore()
    }
  })

  it("runs preflight and install through the SSH/bootstrap boundary with the canonical installer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cts-remote-route-e2e-"))
    const binDir = path.join(root, "bin")
    const installerFixture = path.join(root, "canonical-installer.sh")
    const capture = path.join(root, "installer-args.txt")
    const installDir = path.join(root, "target")
    const previousPath = process.env.PATH
    const previousFixture = process.env.CTS_TEST_INSTALLER
    const previousCapture = process.env.CTS_TEST_CAPTURE
    const previousMode = process.env.CTS_TEST_EXPECT_MODE

    try {
      await execFileSync("mkdir", ["-p", binDir])
      await writeFile(path.join(binDir, "ssh"), "#!/usr/bin/env bash\nexec /bin/bash -s\n")
      await writeFile(
        path.join(binDir, "git"),
        `#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\${1:-}" == "clone" ]]; then
  destination="\${@: -1}"
  mkdir -p "$destination/scripts" "$destination/.git"
  cp "$CTS_TEST_INSTALLER" "$destination/scripts/install.sh"
  chmod 755 "$destination/scripts/install.sh"
  exit 0
fi
exit 0
`,
      )
      await writeFile(
        installerFixture,
        `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$*" > "$CTS_TEST_CAPTURE"
if [[ "$CTS_TEST_EXPECT_MODE" == "preflight" ]]; then
  [[ " $* " == *" --preflight-only "* ]]
  [[ " $* " == *" --skip-system-packages "* ]]
  [[ " $* " == *" --create-service-user "* ]]
else
  seed=""
  while (($#)); do
    if [[ "$1" == "--seed-env-file" ]]; then seed="$2"; break; fi
    shift
  done
  [[ -n "$seed" && -r "$seed" ]]
  grep -q '^REDIS_URL=redis://127.0.0.1:6379$' "$seed"
  [[ " $* " != *" --preflight-only "* ]]
fi
printf '[fixture-installer] canonical contract passed\\n'
`,
      )
      await Promise.all([
        chmod(path.join(binDir, "ssh"), 0o755),
        chmod(path.join(binDir, "git"), 0o755),
        chmod(installerFixture, 0o755),
      ])
      process.env.PATH = `${binDir}:${previousPath || ""}`
      process.env.CTS_TEST_INSTALLER = installerFixture
      process.env.CTS_TEST_CAPTURE = capture

      process.env.CTS_TEST_EXPECT_MODE = "preflight"
      const preflightResponse = await POST(remoteRequest({
        mode: "preflight",
        host: "localhost",
        username: "root",
        serviceUser: "root",
        installDir,
        repoUrl: "https://github.com/mxssnx-creator/CTS-K-N.git",
      }))
      expect(preflightResponse.status).toBe(200)
      await expect(preflightResponse.json()).resolves.toMatchObject({
        success: true,
        mode: "preflight",
        preflightPassed: true,
      })
      expect(await readFile(capture, "utf8")).toContain("--preflight-only")

      process.env.CTS_TEST_EXPECT_MODE = "install"
      const installResponse = await POST(remoteRequest({
        mode: "install",
        host: "localhost",
        username: "root",
        serviceUser: "root",
        installDir,
        repoUrl: "https://github.com/mxssnx-creator/CTS-K-N.git",
        redisUrl: "redis://127.0.0.1:6379",
      }))
      expect(installResponse.status).toBe(200)
      await expect(installResponse.json()).resolves.toMatchObject({
        success: true,
        mode: "install",
        service: "cts-k-n",
        schedulerService: "cts-k-n-scheduler",
      })
      const installArgs = await readFile(capture, "utf8")
      expect(installArgs).toContain("--runtime auto")
      expect(installArgs).toContain("--seed-env-file")
      expect(installArgs).not.toContain("--preflight-only")
    } finally {
      process.env.PATH = previousPath
      if (previousFixture === undefined) delete process.env.CTS_TEST_INSTALLER
      else process.env.CTS_TEST_INSTALLER = previousFixture
      if (previousCapture === undefined) delete process.env.CTS_TEST_CAPTURE
      else process.env.CTS_TEST_CAPTURE = previousCapture
      if (previousMode === undefined) delete process.env.CTS_TEST_EXPECT_MODE
      else process.env.CTS_TEST_EXPECT_MODE = previousMode
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
