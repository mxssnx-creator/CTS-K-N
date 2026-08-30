import { execFileSync } from "node:child_process"
import { existsSync, lstatSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { POST } from "@/app/api/install/remote/route"

const ADMIN_SECRET = "install-test-admin-secret-000000000000"

function remoteRequest(body: Record<string, unknown>, secret = ADMIN_SECRET) {
  return new Request("http://localhost/api/install/remote", {
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
    const [installer, bootstrap, updater, serviceControl, envExample, remoteRoute, vercelConfig, credentialRoute, productionInit] = await Promise.all([
      readFile(path.join(process.cwd(), "scripts/install.sh"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/bootstrap-install.sh"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/update.sh"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/service-control.sh"), "utf8"),
      readFile(path.join(process.cwd(), ".env.example"), "utf8"),
      readFile(path.join(process.cwd(), "app/api/install/remote/route.ts"), "utf8"),
      readFile(path.join(process.cwd(), "vercel.json"), "utf8"),
      readFile(path.join(process.cwd(), "app/api/system/inject-credentials/route.ts"), "utf8"),
      readFile(path.join(process.cwd(), "scripts/production-deploy-init.mjs"), "utf8"),
    ])
    expect(installer).toContain('PNPM_VERSION="10.28.1"')
    expect(installer).toContain('DEFAULT_PROJECT_NAME="cts-kn"')
    expect(installer).toContain("--reinstall")
    expect(installer).toContain("--safe-simulation")
    expect(installer).toContain("SAFE_SIMULATION=0")
    expect(installer).toContain("ensure_python_pip_and_bun")
    expect(installer).toContain('local pnpm_version=""')
    expect(installer).toContain('pnpm_version="$(pnpm --version 2>/dev/null || true)"')
    expect(installer).toContain("--reinstall must remain idempotent")
    expect(installer).not.toContain('if (( REINSTALL == 1 )) || ! command -v pnpm')
    expect(installer).toContain("node_modules/next/package.json")
    expect(installer).toContain("node_modules/react/package.json")
    expect(installer).toContain("public_access_url")
    expect(installer).toContain("--preflight-only")
    expect(installer).toContain("ALLOW_PROD_INLINE_REDIS 0")
    expect(installer).toContain("ALLOW_INLINE_REDIS_LIVE_TRADING 1")
    expect(installer).toContain("effective_memory_limits_kb")
    expect(installer).toContain("configure_memory_watchdog")
    expect(installer).toContain("CTS_RUNTIME_MEMORY_HIGH_MB")
    expect(installer).toContain("MemoryHigh=${runtime_high_mb}M")
    expect(installer).toContain("MemoryMax=${runtime_max_mb}M")
    expect(installer).toContain("--max-memory-restart \"${runtime_max_mb}M\"")
    expect(installer).toContain('upsert_env ENCRYPTION_KEY "$(openssl rand -hex 32)"')
    expect(installer).toContain('upsert_env JWT_SECRET "$(openssl rand -hex 32)"')
    expect(installer).toContain("$APP_NAME-scheduler.service")
    expect(installer).toContain("scripts/run-minute-scheduler.mjs")
    expect(installer).toContain("OnActiveSec=2min")
    expect(installer).toContain("OnUnitActiveSec=60s")
    expect(installer).not.toContain("OnBootSec=2min")
    expect(installer).toContain("CTS_INSTALLED_ENV_FILE=$ENV_FILE")
    expect(installer).toContain("CTS_INSTALLED_ENV_MANAGED=$ENV_FILE_MANAGED")
    expect(installer).toContain("use bootstrap-install.sh to relocate it safely")
    expect(installer).toContain('rm -f -- "$RUNTIME_DIR/managed-service-user"')
    expect(installer).not.toContain("DEFAULT_PASSWORD")
    expect(installer).not.toContain("chpasswd")
    expect(installer).toContain("CTS_INSTALLED_REPOSITORY=$repository")
    expect(installer).toContain("CTS_INSTALLED_BRANCH=$branch")
    expect(installer).toContain('for runtime_path in node_modules .next scripts lib package.json tsconfig.json')
    expect(installer).toContain('run_root chmod -R g+rX "$PROJECT_ROOT/$runtime_path"')
    expect(installer).toContain('run_as_service test -r "$PROJECT_ROOT/tsconfig.json"')
    expect(installer).toContain('scripts/run-with-env.mjs" "$ENV_FILE" --')
    expect(installer).toContain(
      'REQUIRE_SHARED_PERSISTENCE="$([[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "inline-snapshot" ]] && echo 0 || echo 1)"',
    )
    expect(installer).toContain("REQUIRE_FRESH_CONTINUITY=1")
    expect(installer).toContain("Site identity changed after restart")
    expect(installer).toContain("upsert_env FORCE_LIVE 1")
    expect(installer).toContain("upsert_env FORCE_SIMULATED 0")
    expect(installer).toContain("upsert_env ALLOW_LIVE_ORDER_PLACEMENT 1")
    expect(installer).toContain("upsert_env CTS_REQUIRE_LIVE_TRADE_READY 1")
    expect(installer).toContain("upsert_env FORCE_SIMULATED 1")
    expect(installer).toContain("upsert_env FORCE_LIVE 0")
    expect(installer).toContain("upsert_env ALLOW_PROD_SIMULATED 1")
    expect(installer).toContain("upsert_env ALLOW_LIVE_ORDER_PLACEMENT 0")
    expect(installer).toContain("upsert_env CTS_REQUIRE_LIVE_TRADE_READY 0")
    expect(installer).toContain("Safe simulation mode is active")
    expect(installer).toContain('upsert_env BINGX_ENVIRONMENT "$bingx_environment"')
    expect(installer).toContain('[[ -n "$bingx_environment" ]] || bingx_environment="prod-vst"')
    expect(installer).toContain('upsert_env BINGX_PUBLIC_ORIGIN "https://open-api-vst.bingx.com"')
    expect(installer).toContain('upsert_env BINGX_PUBLIC_FALLBACK_ORIGIN "https://open-api-vst.bingx.pro"')
    expect(installer).toContain('upsert_env BINGX_VST_ORIGIN "$bingx_vst_origin"')
    expect(installer).toContain('BingX X02 Prod-VST (virtual funds)')
    expect(installer).toContain('upsert_env BINGX_X02_API_KEY "$bingx_vst_key"')
    expect(installer).toContain('upsert_env BINGX_X02_API_SECRET "$bingx_vst_secret"')
    expect(installer).toContain('fatal "Production server installation requires valid credentials for at least one supported exchange')
    expect(installer).not.toContain("the server will install in simulation mode until credentials are configured")
    expect(installer).toContain("ADMIN_SECRET,\nCRON_SECRET, ENCRYPTION_KEY, and JWT_SECRET")
    expect(installer).toContain("handoff_existing_install_to_bootstrap")
    expect(installer).toContain("clean stop → delete → reinstall flow")
    expect(bootstrap).toContain('INSTALL_DIR="$INSTALL_SEARCH_ROOT/$PROJECT_NAME"')
    expect(bootstrap).toContain("/opt/*/.cts-runtime/install-values.env")
    expect(bootstrap).toContain("discover_saved_install_from_name")
    expect(bootstrap).toContain('[[ "$runtime" == "systemd" || "$runtime" == "auto" ]]')
    expect(bootstrap).toContain('[[ "$runtime" == "pm2" || "$runtime" == "auto" ]]')
    expect(bootstrap).toContain('pm2 pid "$pm2_name"')
    expect(bootstrap).toContain("while PM2 process $pm2_name is still active")
    expect(bootstrap).toContain('systemctl stop "$name-recovery.timer" "$name-recovery"')
    expect(bootstrap).toContain('"$name-direct-trade" "$name-scheduler" "$name" "$name-redis"')
    expect(bootstrap).toContain('for unit in "$name-recovery.timer" "$name-recovery" "$name-direct-trade"')
    expect(bootstrap).toContain('pm2 stop "$name-recovery" "$name-direct-trade"')
    expect(bootstrap).toContain('pm2 delete "$name" "$name-scheduler" "$name-direct-trade" "$name-recovery"')
    expect(bootstrap).toContain("--resolve-only")
    expect(bootstrap).toContain("--safe-simulation")
    expect(bootstrap).toContain("cts-state")
    expect(bootstrap).toContain("Saved persistent CTS state outside the target directory")
    expect(bootstrap).toContain("resume_preserved_state_after_failed_clean_install")
    expect(bootstrap).toContain("Resuming preserved CTS state from failed clean install")
    expect(bootstrap).toContain("remove_existing_install_target")
    expect(bootstrap).toContain('as_root rm -rf -- "$INSTALL_DIR"')
    expect(bootstrap).toContain("prepare_clean_install_workspace")
    expect(bootstrap).toContain("Using safe bootstrap workspace outside target directory")
    expect(bootstrap).toMatch(/prepare_clean_install_workspace\nremove_existing_install_target[\s\S]*git clone --branch/)
    expect(bootstrap).toContain("preserved state remains at $PRESERVED_STATE")
    expect(bootstrap).toContain('[[ "$ENV_FILE" == "$INSTALL_DIR"/*')
    expect(bootstrap).toContain('"$INSTALL_DIR/.cts-runtime/managed-service-user"')
    expect(bootstrap).toMatch(/preserve_existing_install_state\(\) \{[\s\S]*stop_existing_installation\n/)
    expect(bootstrap).toMatch(/preserve_existing_install_state\nprepare_clean_install_workspace\nremove_existing_install_target[\s\S]*git clone --branch/)
    expect(bootstrap).toMatch(/resume_preserved_state_after_failed_clean_install\npreserve_existing_install_state\nprepare_clean_install_workspace/)
    expect(updater).toContain("Tracked local changes exist; refusing to overwrite them")
    expect(updater).toContain("discover_saved_install_from_name")
    expect(updater).toContain("Delegating to clean stop → delete → install lifecycle")
    expect(updater).toContain('bash "$PROJECT_ROOT/scripts/bootstrap-install.sh"')
    expect(updater).not.toContain('git -C "$PROJECT_ROOT" reset --hard')
    expect(serviceControl).toContain("Requested service '$APP_NAME' does not match installed service '$SAVED_APP_NAME'")
    expect(serviceControl).toContain("Missing authoritative install metadata")
    expect(serviceControl).toContain('runuser -u "$SERVICE_USER"')
    expect(serviceControl).toContain('run_root awk -v wanted="$key"')
    expect(installer).toContain('run_root install -m 0600 -- "$tmp" "$ENV_FILE"')
    expect(installer).toContain('run_root systemctl disable --now "$APP_NAME-redis"')
    // install.sh persists the npm fallback as its node_modules directory;
    // the service must resolve that layout after a host restart.
    expect(installer).toContain('CTS_NPM_REDIS_ROOT "$npm_redis_root/node_modules"')
    expect(installer).toContain("scripts/direct-trade-supervisor.mjs scripts/direct-trade-processor.mjs")
    expect(installer).toContain('upsert_env CTS_DIRECT_TRADE_MAX_CONNECTION_WORKERS "$direct_trade_worker_count"')
    expect(installer).toContain('upsert_env CTS_DIRECT_TRADE_WORKER_HEAP_MB "$direct_trade_worker_heap_mb"')
    expect(installer).toContain("scripts/direct-trade-supervisor.mjs --port")
    const directSupervisor = await readFile(path.join(process.cwd(), "scripts", "direct-trade-supervisor.mjs"), "utf8")
    expect(directSupervisor).toContain("children.get(connectionId) === entry")
    expect(directSupervisor).toContain("Every scope with non-terminal positions gets a")
    expect(directSupervisor).toContain("accountingPending")
    expect(directSupervisor).toContain("entry.managedCount > 0")
    expect(directSupervisor).toContain('entry.child.kill("SIGKILL")')
    expect(directSupervisor).toContain("CTS_DIRECT_TRADE_WORKER_HEAP_MB")
    const npmRedisService = await readFile(path.join(process.cwd(), "scripts", "npm-redis-service.mjs"), "utf8")
    expect(npmRedisService).toContain('path.basename(path.resolve(packageRoot)) === "node_modules"')
    expect(npmRedisService).toContain('path.dirname(path.resolve(packageRoot))')
    expect(remoteRoute).toContain('command -v base64 >/dev/null 2>&1 || fatal "base64 is required')
    expect(remoteRoute).toContain('`UserKnownHostsFile=${knownHostsPath}`')
    expect(remoteRoute).toContain("Running clean remote lifecycle: stop services, delete target")
    expect(remoteRoute).toContain('bootstrap-install.sh')
    expect(remoteRoute).not.toContain('Fast-forwarding the existing checkout')
    expect(envExample).not.toMatch(/^[A-Z_][A-Z0-9_]*=[^\r\n#]*[ \t]+#/m)
    expect(envExample).toContain("ENCRYPTION_KEY=replace_me_encryption_key")
    expect(envExample).toContain("CTS_REQUIRE_LIVE_TRADE_READY=")
    expect(envExample).toContain("NEXT_PUBLIC_APP_URL=http://localhost:3002\n")
    expect(credentialRoute).toContain('await injectForConnection("bybit-x03")')
    expect(credentialRoute).toContain('"bybit-x03": BASE_CONNECTION_CREDENTIALS["bybit-x03"]')
    expect(productionInit).toContain("async function verifyLiveTradeReadiness()")
    expect(productionInit).toContain("async function verifyDirectTradeProcessor")
    expect(productionInit).toContain('/api/trade-engine/direct-trade/status?aggregate=1')
    expect(productionInit).toContain("last?.processorRequired === true")
    expect(productionInit).toContain("requiredConnections.every((entry) => entry?.healthy === true)")
    expect(productionInit).toContain("async function verifyProdVstMainEngine")
    expect(productionInit).toContain("BingX X02 Prod-VST Main Trade owner is running with a fresh heartbeat")
    expect(productionInit).toContain("const vstMainEngine = await verifyProdVstMainEngine(liveTrade)")
    expect(productionInit).toContain("Direct-Trade processor did not publish a fresh leased heartbeat")
    expect(productionInit).toContain("CTS_REQUIRE_LIVE_TRADE_READY === \"1\"")
    expect(productionInit).toContain("/api/connections/${encodeURIComponent(connectionId)}/engine-states")
    expect(installer).toMatch(/production-deploy-init\.mjs" \\\n\s+\|\| return 1/)
    expect(installer).toMatch(/run-minute-scheduler\.mjs" --once \\\n\s+\|\| return 1/)
    const vercel = JSON.parse(vercelConfig)
    expect(vercel.installCommand).toBe("corepack pnpm@10.28.1 install --frozen-lockfile")
    expect(vercel.buildCommand).toBe("corepack pnpm@10.28.1 run vercel-build")
    expect(vercel.installCommand).not.toContain("corepack enable")
    expect(vercel.buildCommand).not.toContain("vercel-build-setup")
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"))
    expect(packageJson.scripts["vercel-build"]).toBe("node scripts/build-next-with-trace-retry.mjs")
    expect(packageJson.scripts.build).toBe("node scripts/build-next-with-trace-retry.mjs")
    expect(packageJson.scripts["build:next"]).toContain("next/dist/bin/next build")
    expect(packageJson.scripts["build:next"]).toContain("--require=./scripts/next-fs-rm-compat.cjs")
    const nextFsRmCompat = await readFile(path.join(process.cwd(), "scripts", "next-fs-rm-compat.cjs"), "utf8")
    expect(nextFsRmCompat).toContain('path.basename(resolved) === "export"')
    expect(nextFsRmCompat).toContain('path.basename(path.dirname(resolved)).startsWith(".next")')
    expect(nextFsRmCompat).toContain("maxRetries: Math.max(20")
    expect(nextFsRmCompat).toContain('resolved.endsWith(".nft.json")')
    expect(nextFsRmCompat).toContain("isCompleteNextTrace(lastContents)")
    expect(nextFsRmCompat).toContain("fsPromises.readFile = readFileWithNextTraceReadiness")
    expect(nextFsRmCompat).toContain("isNextJsonBuildContract")
    expect(nextFsRmCompat).toContain("writeFileWithAtomicNextJsonPublish")
    expect(nextFsRmCompat).toContain("await nativeRename(temporary, resolved)")
    expect(nextFsRmCompat).toContain("fsPromises.writeFile = writeFileWithAtomicNextJsonPublish")
    const buildWrapper = await readFile(path.join(process.cwd(), "scripts", "build-next-with-trace-retry.mjs"), "utf8")
    expect(buildWrapper).toContain('process.env.CTS_USE_LOCAL_NEXT_BUILD === "1"')
    expect(buildWrapper).toContain('["node_modules/next/dist/bin/next", "build"]')
    expect(buildWrapper).toContain('"run", "build:next"')
    expect(buildWrapper).toContain("function listArchiveSourceFiles")
    expect(buildWrapper).toContain("listArchiveSourceFiles()")
    const devPreview = await readFile(path.join(process.cwd(), "scripts", "run-dev-preview-check.mjs"), "utf8")
    expect(devPreview).toContain("SOAK_PRODUCTIVE_COMPLETION_GRACE_MS")
    const gitMetadata = path.join(process.cwd(), ".git")
    if (existsSync(gitMetadata)) {
      expect(execFileSync("git", ["ls-files", "--stage"], { cwd: process.cwd(), encoding: "utf8" }))
        .not.toMatch(/^160000 /m)
    } else {
      // Credential-free Drive/release archives intentionally omit Git
      // metadata. Prove the equivalent install contract from the extracted
      // tree instead of making a valid archive checkout untestable.
      expect(packageJson.dependencies["@kilocode/app-builder-db"])
        .toBe("file:vendor/app-builder-db-marker")
      expect(lstatSync(path.join(process.cwd(), "vendor", "app-builder-db-marker")).isDirectory())
        .toBe(true)
    }
    execFileSync("bash", ["-n", "scripts/install.sh"], { cwd: process.cwd() })
    execFileSync("bash", ["-n", "scripts/bootstrap-install.sh"], { cwd: process.cwd() })
    execFileSync("bash", ["-n", "scripts/update.sh"], { cwd: process.cwd() })
    execFileSync("bash", ["-n", "scripts/service-control.sh"], { cwd: process.cwd() })
    expect(await readFile(path.join(process.cwd(), "pnpm-workspace.yaml"), "utf8"))
      .toContain("onlyBuiltDependencies:")
  })

  it("keeps the Chisel Work recovery proxy-aware and credential-free", async () => {
    const [helper, runbook] = await Promise.all([
      readFile(path.join(process.cwd(), "scripts/connect-remote-chisel.sh"), "utf8"),
      readFile(path.join(process.cwd(), "docs/REMOTE-CHISEL-WORKMODE.md"), "utf8"),
    ])

    expect(helper).toContain('PROXY="$(read_env HTTP_PROXY)"')
    expect(helper).toContain('--proxy "$PROXY"')
    expect(helper).toContain('SERVER_URL="$(read_env CTS_CHISEL_ENDPOINT)"')
    expect(helper).toContain('FINGERPRINT="$(read_env CTS_CHISEL_FINGERPRINT)"')
    expect(helper).not.toMatch(/^SERVER_URL="https?:\/\//m)
    expect(runbook).toContain("Activation and SSH must run in the same shell/tool process")
    expect(runbook).toContain("Resolved incident: process-local proxy (2026-08-27)")
    execFileSync("bash", ["-n", "scripts/connect-remote-chisel.sh"], { cwd: process.cwd() })
  })

  it("retries a missing Next BUILD_ID only after compilation reached page collection", () => {
    const classifierUrl = pathToFileURL(
      path.join(process.cwd(), "scripts", "next-build-race-classifier.mjs"),
    ).href
    const script = `
      import { isRecoverableNextFilesystemRace } from ${JSON.stringify(classifierUrl)};
      const lifecycle = "Compiled successfully\\nCollecting page data";
      const missing = "Could not find a production build in '/workspace/project/.next'. https://nextjs.org/docs/messages/next-export-no-build-id";
      const results = [
        isRecoverableNextFilesystemRace(lifecycle + "\\n" + missing),
        isRecoverableNextFilesystemRace(missing),
        isRecoverableNextFilesystemRace(lifecycle + "\\nType error\\n" + missing),
        isRecoverableNextFilesystemRace("Compiled successfully\\nCollecting page data\\nUnexpected end of JSON input"),
      ];
      process.stdout.write(JSON.stringify(results));
    `
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    })

    expect(JSON.parse(output)).toEqual([true, false, false, true])
  })

  it("moves out of an installed checkout before deletion so the replacement clone can start", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cts-bootstrap-cwd-"))
    const target = path.join(root, "opt", "cts-kn")
    const targetScripts = path.join(target, "scripts")
    const binDir = path.join(root, "bin")
    const capture = path.join(root, "clone-cwd.txt")
    const installArgs = path.join(root, "install-args.txt")
    const installerFixture = path.join(root, "install-fixture.sh")
    try {
      await Promise.all([
        mkdir(targetScripts, { recursive: true }),
        mkdir(binDir, { recursive: true }),
      ])
      await Promise.all([
        writeFile(path.join(target, "package.json"), '{"name":"cts-install-fixture"}\n'),
        writeFile(path.join(targetScripts, "install.sh"), "#!/usr/bin/env bash\nexit 0\n"),
        writeFile(path.join(targetScripts, "bootstrap-install.sh"), await readFile(path.join(process.cwd(), "scripts", "bootstrap-install.sh"), "utf8")),
        writeFile(installerFixture, [
          "#!/usr/bin/env bash",
          "set -Eeuo pipefail",
          "printf '%s\\n' \"$@\" > \"$CTS_TEST_INSTALL_ARGS\"",
          "mkdir -p .cts-runtime",
          "printf 'CTS_INSTALLED_RUNTIME=systemd\\nCTS_INSTALLED_SERVICE_USER=root\\n' > .cts-runtime/install-values.env",
          "",
        ].join("\n")),
        writeFile(path.join(binDir, "git"), [
          "#!/usr/bin/env bash",
          "set -Eeuo pipefail",
          "if [[ \"${1:-}\" == \"clone\" ]]; then",
          "  [[ \"$PWD\" != \"$CTS_TEST_TARGET\" ]] || { echo 'clone ran from deleted target' >&2; exit 42; }",
          "  printf '%s\\n' \"$PWD\" > \"$CTS_TEST_CAPTURE\"",
          "  destination=\"${@: -1}\"",
          "  mkdir -p \"$destination/scripts\"",
          "  cp \"$CTS_TEST_INSTALLER\" \"$destination/scripts/install.sh\"",
          "  chmod 755 \"$destination/scripts/install.sh\"",
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n")),
        writeFile(path.join(binDir, "systemctl"), [
          "#!/usr/bin/env bash",
          "# The fixture must never inspect or stop the host's CTS services.",
          "if [[ \"${1:-}\" == \"is-active\" ]]; then exit 3; fi",
          "exit 0",
          "",
        ].join("\n")),
      ])
      await Promise.all([
        chmod(path.join(targetScripts, "bootstrap-install.sh"), 0o755),
        chmod(installerFixture, 0o755),
        chmod(path.join(binDir, "git"), 0o755),
        chmod(path.join(binDir, "systemctl"), 0o755),
      ])
      const env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
          CTS_TEST_TARGET: target,
          CTS_TEST_CAPTURE: capture,
          CTS_TEST_INSTALL_ARGS: installArgs,
          CTS_TEST_INSTALLER: installerFixture,
      }

      execFileSync("bash", [path.join(targetScripts, "bootstrap-install.sh"),
        "--dir", target,
        "--name", "cts-kn",
        "--port", "3002",
        "--runtime", "systemd",
        "--service-user", "root",
        "--safe-simulation",
      ], { cwd: target, env, encoding: "utf8", stdio: "pipe" })

      expect(await readFile(capture, "utf8")).not.toBe(`${target}\n`)
      await expect(readFile(path.join(target, "scripts", "install.sh"), "utf8")).resolves.toContain("CTS_INSTALLED_RUNTIME")
      await expect(readFile(installArgs, "utf8")).resolves.toContain("--safe-simulation\n")

      // This is the exact recovery state left by a clone failure: the old
      // checkout is gone, but its persistent data was safely archived beside
      // it. A retry must restore it automatically rather than starting empty.
      const preservedState = path.join(root, "opt", ".cts-kn.cts-state.20260803T010921Z.1")
      await mkdir(path.join(preservedState, "data"), { recursive: true })
      await writeFile(path.join(preservedState, "data", "recovery-marker"), "preserved\n")
      await writeFile(path.join(preservedState, "install-values.env"), [
        "CTS_INSTALLED_APP_NAME=desk-alpha",
        "CTS_INSTALLED_APP_PORT=4312",
        "CTS_INSTALLED_RUNTIME=systemd",
        "CTS_INSTALLED_SERVICE_USER=root",
        `CTS_INSTALLED_PROJECT_ROOT=${target}`,
        `CTS_INSTALLED_ENV_FILE=${target}/.env.production.local`,
        "CTS_INSTALLED_ENV_MANAGED=0",
        "CTS_INSTALLED_REPOSITORY=https://example.test/cts-kn.git",
        "CTS_INSTALLED_BRANCH=release/recovery",
        "",
      ].join("\n"))
      await rm(target, { recursive: true, force: true })

      execFileSync("bash", [path.join(process.cwd(), "scripts", "bootstrap-install.sh"),
        "--dir", target,
      ], { cwd: root, env, encoding: "utf8", stdio: "pipe" })

      await expect(readFile(path.join(target, "data", "recovery-marker"), "utf8")).resolves.toBe("preserved\n")
      await expect(readFile(installArgs, "utf8")).resolves.toContain("--name\ndesk-alpha\n--port\n4312\n--runtime\nsystemd\n--service-user\nroot\n")
      await expect(readFile(path.join(preservedState, "data", "recovery-marker"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("resolves bootstrap, update, and service controls from one saved identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cts-install-resolution-"))
    const scriptsDir = path.join(root, "scripts")
    const runtimeDir = path.join(root, ".cts-runtime")
    try {
      await Promise.all([
        mkdir(scriptsDir, { recursive: true }),
        mkdir(runtimeDir, { recursive: true }),
      ])
      await Promise.all([
        writeFile(path.join(root, "package.json"), '{"name":"cts-install-fixture"}\n'),
        writeFile(path.join(scriptsDir, "install.sh"), "#!/usr/bin/env bash\nexit 0\n"),
        writeFile(
          path.join(runtimeDir, "install-values.env"),
          [
            "CTS_INSTALLED_APP_NAME=desk-alpha",
            "CTS_INSTALLED_APP_PORT=4312",
            "CTS_INSTALLED_RUNTIME=systemd",
            "CTS_INSTALLED_SERVICE_USER=desk-alpha",
            `CTS_INSTALLED_PROJECT_ROOT=${root}`,
            `CTS_INSTALLED_ENV_FILE=${root}/config/production.env`,
            "CTS_INSTALLED_ENV_MANAGED=0",
            "CTS_INSTALLED_REPOSITORY=https://github.com/mxssnx-creator/CTS-K-N.git",
            "CTS_INSTALLED_BRANCH=release/stable",
            "",
          ].join("\n"),
        ),
      ])
      for (const script of ["bootstrap-install.sh", "update.sh", "service-control.sh"]) {
        await writeFile(
          path.join(scriptsDir, script),
          await readFile(path.join(process.cwd(), "scripts", script), "utf8"),
        )
        await chmod(path.join(scriptsDir, script), 0o755)
      }
      execFileSync("git", ["init", "-q"], { cwd: root })
      execFileSync("git", ["remote", "add", "origin", "https://github.com/mxssnx-creator/CTS-K-N.git"], { cwd: root })

      const bootstrap = execFileSync("bash", [
        path.join(scriptsDir, "bootstrap-install.sh"),
        "--dir",
        root,
        "--resolve-only",
      ], { encoding: "utf8" })
      expect(bootstrap).toContain(`CTS_INSTALL_DIR=${root}`)
      expect(bootstrap).toContain("CTS_PROJECT_NAME=desk-alpha")
      expect(bootstrap).toContain("CTS_PORT=4312")
      expect(bootstrap).toContain(`CTS_ENV_FILE=${root}/config/production.env`)

      const update = execFileSync("bash", [
        path.join(scriptsDir, "update.sh"),
        "--resolve-only",
      ], { encoding: "utf8" })
      expect(update).toContain(`CTS_INSTALL_DIR=${root}`)
      expect(update).toContain("CTS_PROJECT_NAME=desk-alpha")
      expect(update).toContain("CTS_BRANCH=release/stable")

      const control = execFileSync("bash", [
        path.join(scriptsDir, "service-control.sh"),
        "resolve",
      ], { encoding: "utf8" })
      expect(control).toContain("CTS_INSTALLED_APP_NAME=desk-alpha")
      expect(control).toContain("CTS_INSTALLED_APP_PORT=4312")
      expect(control).toContain(`CTS_INSTALLED_ENV_FILE=${root}/config/production.env`)
      expect(control).toContain("CTS_INSTALLED_ENV_MANAGED=0")

      expect(() => execFileSync("bash", [
        path.join(scriptsDir, "service-control.sh"),
        "start",
        "--name",
        "wrong-service",
      ], { encoding: "utf8", stdio: "pipe" })).toThrow()
      expect(() => execFileSync("bash", [
        path.join(scriptsDir, "service-control.sh"),
        "resolve",
        "--port",
        "9999",
      ], { encoding: "utf8", stdio: "pipe" })).toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("resolves name-only PM2 installs whose directory differs from the service name", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cts-install-name-resolution-"))
    const searchRoot = path.join(root, "opt")
    const installRoot = path.join(searchRoot, "custom-checkout")
    const launcherScripts = path.join(root, "launcher", "scripts")
    const installScripts = path.join(installRoot, "scripts")
    const runtimeDir = path.join(installRoot, ".cts-runtime")
    try {
      await Promise.all([
        mkdir(launcherScripts, { recursive: true }),
        mkdir(installScripts, { recursive: true }),
        mkdir(runtimeDir, { recursive: true }),
      ])
      await Promise.all([
        writeFile(path.join(installRoot, "package.json"), '{"name":"cts-install-fixture"}\n'),
        writeFile(path.join(installScripts, "install.sh"), "#!/usr/bin/env bash\nexit 0\n"),
        writeFile(
          path.join(runtimeDir, "install-values.env"),
          [
            "CTS_INSTALLED_APP_NAME=desk-pm2",
            "CTS_INSTALLED_APP_PORT=4512",
            "CTS_INSTALLED_RUNTIME=pm2",
            "CTS_INSTALLED_SERVICE_USER=desk-pm2",
            `CTS_INSTALLED_PROJECT_ROOT=${installRoot}`,
            `CTS_INSTALLED_ENV_FILE=${installRoot}/config/production.env`,
            "CTS_INSTALLED_ENV_MANAGED=1",
            "CTS_INSTALLED_REPOSITORY=https://github.com/mxssnx-creator/CTS-K-N.git",
            "CTS_INSTALLED_BRANCH=main",
            "",
          ].join("\n"),
        ),
      ])
      for (const script of ["bootstrap-install.sh", "update.sh"]) {
        await writeFile(
          path.join(launcherScripts, script),
          await readFile(path.join(process.cwd(), "scripts", script), "utf8"),
        )
        await chmod(path.join(launcherScripts, script), 0o755)
      }
      execFileSync("git", ["init", "-q"], { cwd: installRoot })
      execFileSync("git", ["remote", "add", "origin", "https://github.com/mxssnx-creator/CTS-K-N.git"], {
        cwd: installRoot,
      })
      const env = { ...process.env, CTS_INSTALL_SEARCH_ROOT: searchRoot }

      const bootstrap = execFileSync("bash", [
        path.join(launcherScripts, "bootstrap-install.sh"),
        "--name",
        "desk-pm2",
        "--resolve-only",
      ], { encoding: "utf8", env })
      expect(bootstrap).toContain(`CTS_INSTALL_DIR=${installRoot}`)
      expect(bootstrap).toContain("CTS_PROJECT_NAME=desk-pm2")
      expect(bootstrap).toContain("CTS_RUNTIME=pm2")

      const update = execFileSync("bash", [
        path.join(launcherScripts, "update.sh"),
        "--name",
        "desk-pm2",
        "--resolve-only",
      ], { encoding: "utf8", env })
      expect(update).toContain(`CTS_INSTALL_DIR=${installRoot}`)
      expect(update).toContain("CTS_PROJECT_NAME=desk-pm2")
      expect(update).toContain("CTS_RUNTIME=pm2")

      const duplicateRuntime = path.join(searchRoot, "duplicate", ".cts-runtime")
      await mkdir(duplicateRuntime, { recursive: true })
      await writeFile(
        path.join(duplicateRuntime, "install-values.env"),
        "CTS_INSTALLED_APP_NAME=desk-pm2\n",
      )
      expect(() => execFileSync("bash", [
        path.join(launcherScripts, "bootstrap-install.sh"),
        "--name",
        "desk-pm2",
        "--resolve-only",
      ], { encoding: "utf8", env, stdio: "pipe" })).toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects direct identity relocation and service control without saved metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cts-install-identity-"))
    const scriptsDir = path.join(root, "scripts")
    const runtimeDir = path.join(root, ".cts-runtime")
    const externalEnv = path.join(root, "..", `${path.basename(root)}.production.env`)
    try {
      await Promise.all([
        mkdir(scriptsDir, { recursive: true }),
        mkdir(runtimeDir, { recursive: true }),
      ])
      await Promise.all([
        writeFile(path.join(root, "package.json"), '{"name":"cts-install-fixture","version":"0.1.1"}\n'),
        writeFile(path.join(scriptsDir, "install.sh"), await readFile(path.join(process.cwd(), "scripts/install.sh"), "utf8")),
        writeFile(path.join(scriptsDir, "service-control.sh"), await readFile(path.join(process.cwd(), "scripts/service-control.sh"), "utf8")),
        writeFile(
          path.join(runtimeDir, "install-values.env"),
          [
            "CTS_INSTALLED_APP_NAME=desk-beta",
            "CTS_INSTALLED_APP_PORT=4412",
            "CTS_INSTALLED_RUNTIME=systemd",
            "CTS_INSTALLED_SERVICE_USER=desk-beta",
            `CTS_INSTALLED_PROJECT_ROOT=${root}`,
            `CTS_INSTALLED_ENV_FILE=${externalEnv}`,
            "CTS_INSTALLED_ENV_MANAGED=0",
            "",
          ].join("\n"),
        ),
      ])
      await Promise.all([
        chmod(path.join(scriptsDir, "install.sh"), 0o755),
        chmod(path.join(scriptsDir, "service-control.sh"), 0o755),
      ])

      expect(() => execFileSync("bash", [
        path.join(scriptsDir, "install.sh"),
        "--runtime",
        "pm2",
        "--non-interactive",
      ], { encoding: "utf8", stdio: "pipe" })).toThrow()
      expect(() => execFileSync("bash", [
        path.join(scriptsDir, "install.sh"),
        "--uninstall",
        "--env-file",
        path.join(root, "wrong.env"),
        "--non-interactive",
      ], { encoding: "utf8", stdio: "pipe" })).toThrow()

      await rm(path.join(runtimeDir, "install-values.env"))
      expect(() => execFileSync("bash", [
        path.join(scriptsDir, "service-control.sh"),
        "resolve",
      ], { encoding: "utf8", stdio: "pipe" })).toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(externalEnv, { force: true })
    }
  })

  it("passes the executable Kilo/Cloudflare static preflight", () => {
    const output = execFileSync(process.execPath, ["scripts/kilo-deploy-preflight.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
    expect(output).toContain('"success":true')
    expect(output).toContain('"schemaVersion":105')
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
    expect(await readFile(path.join(process.cwd(), "open-next.config.ts"), "utf8"))
      .toContain('buildCommand: "node scripts/build-next-with-trace-retry.mjs"')
    const nextBuildWrapper = await readFile(
      path.join(process.cwd(), "scripts/build-next-with-trace-retry.mjs"),
      "utf8",
    )
    expect(nextBuildWrapper).toContain('["pnpm@10.28.1", "run", "build:next"]')
    expect(nextBuildWrapper).toContain("const requiresStandalone = !isVercelBuild")
    expect(nextBuildWrapper).toContain('detached: process.platform !== "win32"')
    expect(nextBuildWrapper).toContain('process.kill(-pid, signal)')
    expect(nextBuildWrapper).toContain('signalProcessGroup(pid, "SIGKILL")')
    expect(wrangler).toContain('"required": ["ADMIN_SECRET", "CRON_SECRET", "ENCRYPTION_KEY", "JWT_SECRET", "BINGX_API_KEY", "BINGX_API_SECRET"]')
    expect(deployScript).toContain('"--secrets-file", secretsFile')
    expect(deployScript).toContain("KILO_REQUIRE_REMOTE_INSTALL_OWNER: \"1\"")
    expect(deployScript).toContain('REQUIRE_SHARED_PERSISTENCE: "1"')
    expect(deployScript).toContain('["scripts/clean-opennext-output.mjs"]')
    expect(deployScript).not.toContain('"CLOUDFLARE_API_TOKEN",')
    expect(await readFile(path.join(process.cwd(), "scripts/verify-deployment-contract.mjs"), "utf8"))
      .toContain('["cloudflare-workers", "kilo-deploy"]')
    const runtimeTest = await readFile(path.join(process.cwd(), "scripts/test-kilo-runtime.mjs"), "utf8")
    expect(runtimeTest).toContain('/api/install/remote')
    expect(runtimeTest).toContain('remoteInstallRouteFailClosed: true')
    expect(buildNormalizer).toContain("resolve(src) === resolve(dest)")
    expect(buildNormalizer).toContain("waitForValidJson(src, routeManifestSettleMs)")
    expect(buildNormalizer).toContain("isValidJson(src)")
    expect(buildNormalizer).toContain("standaloneManifest")
    expect(buildNormalizer).toContain("reconstructPrerenderManifest")
    expect(buildNormalizer).toContain("writeJsonAtomically")
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
        writeFile(path.join(dist, "BUILD_ID"), "fixture-build\n"),
        writeFile(path.join(dist, "routes-manifest.json"), "{}\n"),
        writeFile(path.join(dist, "prerender-manifest.json"), '{"version":4,"routes":{},"dynamicRoutes":{},"notFoundRoutes":[],"preview":{}}\n'),
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

  it("reconstructs an invalid prerender manifest from completed app output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cts-next-prerender-"))
    const dist = path.join(root, ".next")
    const app = path.join(dist, "server", "app")
    const standalone = path.join(dist, "standalone", ".next")
    const normalizer = path.join(process.cwd(), "scripts/normalize-next-env.mjs")
    try {
      await Promise.all([
        mkdir(path.join(app, "settings"), { recursive: true }),
        mkdir(standalone, { recursive: true }),
      ])
      await Promise.all([
        writeFile(path.join(root, "next-env.d.ts"), ""),
        writeFile(path.join(dist, "BUILD_ID"), "fixture-build\n"),
        writeFile(path.join(dist, "routes-manifest.json"), "{}\n"),
        writeFile(path.join(dist, "required-server-files.json"), '{"config":{"images":{}}}\n'),
        writeFile(path.join(dist, "images-manifest.json"), "{}\n"),
        writeFile(path.join(dist, "export-marker.json"), "{}\n"),
        writeFile(path.join(dist, "prerender-manifest.json"), ""),
        writeFile(path.join(standalone, "prerender-manifest.json"), ""),
        writeFile(path.join(app, "index.html"), "<main />"),
        writeFile(path.join(app, "index.rsc"), "root"),
        writeFile(path.join(app, "settings", "connections.html"), "<main />"),
        writeFile(path.join(app, "settings", "connections.rsc"), "settings"),
      ])

      execFileSync(process.execPath, [normalizer], { cwd: root })
      const manifest = JSON.parse(await readFile(path.join(dist, "prerender-manifest.json"), "utf8"))
      expect(manifest).toMatchObject({
        version: 4,
        routes: {
          "/": { srcRoute: "/", dataRoute: "/index.rsc" },
          "/settings/connections": {
            srcRoute: "/settings/connections",
            dataRoute: "/settings/connections.rsc",
          },
        },
        dynamicRoutes: {},
        notFoundRoutes: [],
      })
      expect(manifest.preview.previewModeId).toHaveLength(32)
      expect(JSON.parse(await readFile(path.join(standalone, "prerender-manifest.json"), "utf8")))
        .toEqual(manifest)
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
        writeFile(path.join(dist, "BUILD_ID"), "fixture-build\n"),
        writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
          include: [
            "**/*.ts",
            ".next/types/**/*.ts",
            ".next-prod/types/**/*.ts",
            ".next-live-preflight-123/types/**/*.ts",
            ".next/dev/types/**/*.ts",
          ],
        })),
        writeFile(path.join(dist, "routes-manifest.json"), "{}\n"),
        writeFile(path.join(dist, "prerender-manifest.json"), '{"version":4,"routes":{},"dynamicRoutes":{},"notFoundRoutes":[],"preview":{}}\n'),
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

  it("keeps metadata canonical when an interrupted dev build has no production artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cts-next-no-build-id-"))
    const normalizer = path.join(process.cwd(), "scripts/normalize-next-env.mjs")
    try {
      await Promise.all([
        mkdir(path.join(root, ".next"), { recursive: true }),
        writeFile(path.join(root, "next-env.d.ts"), ""),
        writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
          include: ["**/*.ts", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
        })),
      ])

      expect(() => execFileSync(process.execPath, [normalizer], { cwd: root })).not.toThrow()
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

  it("keeps remote and host installer path validation identical", async () => {
    const response = await POST(remoteRequest({
      mode: "preflight",
      host: "localhost",
      username: "root",
      installDir: "/opt/unsafe directory",
    }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Install directory must be a normalized, dedicated absolute /opt directory",
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
      expect(String(target)).toBe("https://owner.example.test/api/install/remote")
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
    const previousBootstrap = process.env.CTS_TEST_BOOTSTRAP
    const previousCapture = process.env.CTS_TEST_CAPTURE
    const previousMode = process.env.CTS_TEST_EXPECT_MODE
    const previousTestInstallRoot = process.env.CTS_REMOTE_INSTALL_TEST_ROOT

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
  cp "$CTS_TEST_BOOTSTRAP" "$destination/scripts/bootstrap-install.sh"
  chmod 755 "$destination/scripts/install.sh"
  chmod 755 "$destination/scripts/bootstrap-install.sh"
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
      process.env.CTS_REMOTE_INSTALL_TEST_ROOT = root
      process.env.CTS_TEST_INSTALLER = installerFixture
      process.env.CTS_TEST_BOOTSTRAP = path.join(process.cwd(), "scripts/bootstrap-install.sh")
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
      const preflightPayload = await preflightResponse.json()
      expect({ status: preflightResponse.status, payload: preflightPayload }).toMatchObject({
        status: 200,
        payload: { success: true, mode: "preflight", preflightPassed: true },
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
        projectName: "cts-kn",
        service: "cts-kn",
        schedulerService: "cts-kn-scheduler",
      })
      const installArgs = await readFile(capture, "utf8")
      expect(installArgs).toContain("--runtime auto")
      expect(installArgs).toContain("--seed-env-file")
      expect(installArgs).not.toContain("--preflight-only")
    } finally {
      process.env.PATH = previousPath
      if (previousFixture === undefined) delete process.env.CTS_TEST_INSTALLER
      else process.env.CTS_TEST_INSTALLER = previousFixture
      if (previousBootstrap === undefined) delete process.env.CTS_TEST_BOOTSTRAP
      else process.env.CTS_TEST_BOOTSTRAP = previousBootstrap
      if (previousCapture === undefined) delete process.env.CTS_TEST_CAPTURE
      else process.env.CTS_TEST_CAPTURE = previousCapture
      if (previousMode === undefined) delete process.env.CTS_TEST_EXPECT_MODE
      else process.env.CTS_TEST_EXPECT_MODE = previousMode
      if (previousTestInstallRoot === undefined) delete process.env.CTS_REMOTE_INSTALL_TEST_ROOT
      else process.env.CTS_REMOTE_INSTALL_TEST_ROOT = previousTestInstallRoot
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
