import { NextResponse } from "next/server"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { authorizeAdminBearer } from "@/lib/admin-auth"
import { isServerlessDeploymentRuntime } from "@/lib/deployment-runtime"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
// Vercel Hobby permits a maximum of 300 seconds per Serverless Function.
export const maxDuration = 300

const DEFAULT_REPOSITORY = "https://github.com/mxssnx-creator/CTS-K-N.git"
const DEFAULT_PROJECT_NAME = "cts-kn"
const DEFAULT_SERVICE_USER = DEFAULT_PROJECT_NAME
const MAX_REQUEST_BYTES = 512 * 1024
const MAX_REMOTE_LOG_BYTES = 256 * 1024
const BLOCKED_ENV_KEYS = new Set([
  "BASH_ENV",
  "ENV",
  "FORCE_LIVE",
  "GIT_SSH_COMMAND",
  "HOME",
  "HOST",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NPM_CONFIG_PREFIX",
  "PATH",
  "PNPM_HOME",
  "PORT",
  "PWD",
  "SCHEDULER_BASE_URL",
  "SHELL",
])

const ALLOWED_ENV_KEYS = new Set([
  "CI",
  "DEBUG",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "TERM",
  "TMPDIR",
])

function buildSshProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV || "development" }
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue
    if (BLOCKED_ENV_KEYS.has(key)) continue
    if (ALLOWED_ENV_KEYS.has(key)) {
      env[key] = value
    }
  }
  return env
}
const DANGEROUS_INSTALL_DIRS = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
])

type RemoteInstallMode = "preflight" | "install"
type RemoteInstallRuntime = "auto" | "systemd" | "pm2"

interface RemoteInstallRequest {
  mode?: RemoteInstallMode
  host?: string
  port?: number | string
  username?: string
  password?: string
  sshKey?: string
  installDir?: string
  repoUrl?: string
  branch?: string
  runtime?: RemoteInstallRuntime
  projectName?: string
  reinstall?: boolean
  skipTests?: boolean
  appPort?: number | string
  serviceUser?: string
  redisUrl?: string
  env?: Record<string, string>
}

interface ValidatedRemoteInstall {
  mode: RemoteInstallMode
  host: string
  port: number
  username: string
  password?: string
  sshKey?: string
  installDir: string
  repoUrl: string
  branch: string
  runtime: RemoteInstallRuntime
  projectName: string
  reinstall: boolean
  skipTests: boolean
  appPort: number
  serviceUser: string
  seedEnv: string
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function assertText(value: unknown, label: string, maximum: number): string {
  const normalized = String(value ?? "").trim()
  if (!normalized || normalized.length > maximum || /[\0\r\n]/.test(normalized)) {
    throw new Error(`${label} is invalid`)
  }
  return normalized
}

function parsePort(value: unknown, fallback: number, label: string): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${label} must be an integer from 1 to 65535`)
  }
  return parsed
}

function validateHost(value: unknown): string {
  const host = assertText(value, "Host", 253)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host)) throw new Error("Host is invalid")
  return host
}

function validateUnixName(value: unknown, label: string): string {
  const name = assertText(value, label, 32)
  if (!/^[a-zA-Z_][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`${label} is invalid`)
  return name
}

function validateBranch(value: unknown): string {
  const branch = assertText(value || "main", "Branch", 128)
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith(".") ||
    branch.endsWith("/") ||
    branch.includes("@{")
  ) {
    throw new Error("Branch is invalid")
  }
  return branch
}

function validateRuntime(value: unknown): RemoteInstallRuntime {
  const runtime = String(value || "auto").trim().toLowerCase()
  if (runtime !== "auto" && runtime !== "systemd" && runtime !== "pm2") {
    throw new Error("Runtime must be auto, systemd, or pm2")
  }
  return runtime
}

function validateInstallDir(value: unknown, projectName: string): string {
  const installDir = assertText(value || `/opt/${projectName}`, "Install directory", 240)
  const normalized = path.posix.normalize(installDir)
  if (
    !installDir.startsWith("/") ||
    !/^\/[a-zA-Z0-9._/-]+$/.test(installDir) ||
    installDir.includes("//") ||
    normalized !== installDir ||
    DANGEROUS_INSTALL_DIRS.has(installDir) ||
    !installDir.startsWith("/opt/") ||
    installDir.split("/").filter(Boolean).length < 2
  ) {
    throw new Error("Install directory must be a normalized, dedicated absolute /opt directory")
  }
  return installDir
}

function validateRepository(value: unknown): string {
  const repoUrl = assertText(value || DEFAULT_REPOSITORY, "Repository URL", 500)
  const allowed = /^(?:https:\/\/|ssh:\/\/|git@[a-zA-Z0-9.-]+:)[^\s]+$/
  if (!allowed.test(repoUrl)) throw new Error("Repository URL must use HTTPS or SSH")
  if (repoUrl.startsWith("http")) {
    const parsed = new URL(repoUrl)
    if (parsed.username || parsed.password) throw new Error("Repository credentials must not be embedded in the URL")
  }
  return repoUrl
}

function buildSeedEnvironment(input: RemoteInstallRequest): string {
  const entries = Object.entries(input.env ?? {})
  if (entries.length > 80) throw new Error("Too many environment entries")

  const result = new Map<string, string>()
  for (const [key, rawValue] of entries) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || BLOCKED_ENV_KEYS.has(key) || key.startsWith("LD_")) {
      throw new Error(`Environment key is blocked: ${key}`)
    }
    if (typeof rawValue !== "string" || rawValue.length > 16_384 || /[\0\r\n]/.test(rawValue)) {
      throw new Error(`Environment value is invalid: ${key}`)
    }
    result.set(key, rawValue)
  }

  if (input.redisUrl?.trim()) {
    const redisUrl = assertText(input.redisUrl, "Redis URL", 2_048)
    let parsed: URL
    try {
      parsed = new URL(redisUrl)
    } catch {
      throw new Error("Redis URL is invalid")
    }
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      throw new Error("Redis URL must use redis:// or rediss://")
    }
    result.set("REDIS_URL", redisUrl)
  }

  const text = Array.from(result, ([key, value]) => `${key}=${value}`).join("\n")
  if (Buffer.byteLength(text, "utf8") > 256 * 1024) throw new Error("Environment payload is too large")
  return text ? `${text}\n` : ""
}

function validateRequest(input: RemoteInstallRequest): ValidatedRemoteInstall {
  const mode = input.mode || "install"
  if (mode !== "preflight" && mode !== "install") throw new Error("Mode must be preflight or install")
  const password = input.password?.trim() || undefined
  const sshKey = input.sshKey?.trim() || undefined
  if (password && (password.length > 4_096 || /[\0\r\n]/.test(password))) throw new Error("SSH password is invalid")
  if (sshKey && (sshKey.length > 128 * 1024 || !/^-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----/.test(sshKey))) {
    throw new Error("SSH private key is invalid")
  }
  const projectName = validateUnixName(input.projectName || DEFAULT_PROJECT_NAME, "Project name")
  return {
    mode,
    host: validateHost(input.host),
    port: parsePort(input.port, 22, "SSH port"),
    username: validateUnixName(input.username, "SSH username"),
    password,
    sshKey,
    installDir: validateInstallDir(input.installDir, projectName),
    repoUrl: validateRepository(input.repoUrl),
    branch: validateBranch(input.branch),
    runtime: validateRuntime(input.runtime),
    projectName,
    reinstall: input.reinstall === true,
    skipTests: input.skipTests === true,
    appPort: parsePort(input.appPort, 3002, "Application port"),
    serviceUser: validateUnixName(input.serviceUser || projectName || DEFAULT_SERVICE_USER, "Service user"),
    seedEnv: buildSeedEnvironment(input),
  }
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const combined = current + chunk.toString()
  return combined.length <= MAX_REMOTE_LOG_BYTES
    ? combined
    : `[earlier output truncated]\n${combined.slice(-MAX_REMOTE_LOG_BYTES)}`
}

function runRemoteCommand(
  command: string,
  args: string[],
  input: string,
  options: { timeout: number; env: NodeJS.ProcessEnv },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finishError = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(Object.assign(error, { stdout, stderr }))
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finishError(new Error("Remote operation timed out"))
    }, options.timeout)

    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk) })
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk) })
    child.on("error", finishError)
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(Object.assign(new Error(`Remote operation failed with exit code ${code}`), { stdout, stderr }))
    })
    child.stdin.on("error", finishError)
    child.stdin.end(input)
  })
}

function buildRemoteScript(input: ValidatedRemoteInstall) {
  const seedEnvBase64 = Buffer.from(input.seedEnv, "utf8").toString("base64")
  const installerMode = input.mode === "preflight"
    ? "--preflight-only --skip-system-packages --create-service-user --non-interactive"
    : ""
  return `#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

MODE=${shellQuote(input.mode)}
APP_DIR=${shellQuote(input.installDir)}
REPO_URL=${shellQuote(input.repoUrl)}
BRANCH=${shellQuote(input.branch)}
RUNTIME=${shellQuote(input.runtime)}
APP_PORT=${shellQuote(String(input.appPort))}
SERVICE_USER=${shellQuote(input.serviceUser)}
PROJECT_NAME=${shellQuote(input.projectName)}
REINSTALL=${input.reinstall ? "1" : "0"}
REINSTALL_ARG=()
if [[ "$REINSTALL" == "1" ]]; then REINSTALL_ARG+=(--reinstall); fi
SKIP_TESTS_ARG=()
if [[ "${input.skipTests ? "1" : "0"}" == "1" ]]; then SKIP_TESTS_ARG+=(--skip-tests); fi
SEED_ENV_BASE64=${shellQuote(seedEnvBase64)}
WORK_ROOT="/opt/cts-k-n-install-work"
TMP_DIR=""
SEED_FILE=""

log() { printf '[remote-server] %s\\n' "$*"; }
fatal() { printf '[remote-server] ERROR: %s\\n' "$*" >&2; exit 1; }
cleanup() {
  if [[ -n "$TMP_DIR" && "$TMP_DIR" == "$WORK_ROOT"/cts-k-n-* && -d "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR"
  fi
  [[ -z "$SEED_FILE" ]] || rm -f -- "$SEED_FILE"
}
trap cleanup EXIT

[[ "$(uname -s)" == "Linux" ]] || fatal "Only long-lived Linux servers are supported"
command -v sudo >/dev/null 2>&1 || [[ "$(id -u)" == "0" ]] || fatal "sudo or root access is required"
if [[ "$(id -u)" != "0" ]]; then sudo -n true >/dev/null 2>&1 || fatal "Passwordless sudo is required"; fi
ROOT=()
[[ "$(id -u)" == "0" ]] || ROOT=(sudo -n)

disk_probe=${shellQuote(path.posix.dirname(input.installDir))}
while [[ ! -e "$disk_probe" && "$disk_probe" != "/" ]]; do
  disk_probe="$(dirname "$disk_probe")"
done
disk_kb="$(df -Pk "$disk_probe" 2>/dev/null | awk 'NR==2 {print $4}')"
memory_kb="$(awk '/MemTotal:/ {print $2}' /proc/meminfo)"
[[ "$disk_kb" =~ ^[0-9]+$ ]] && (( disk_kb >= 4 * 1024 * 1024 )) || fatal "At least 4 GiB free disk is required"
[[ "$memory_kb" =~ ^[0-9]+$ ]] && (( memory_kb >= 1536 * 1024 )) || fatal "At least 1.5 GiB RAM is required"
log "Host capacity and privilege prechecks passed"

install_bootstrap_dependencies() {
  command -v git >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && return 0
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    "\${ROOT[@]}" apt-get update -y
    "\${ROOT[@]}" apt-get install -y ca-certificates curl git
  elif command -v dnf >/dev/null 2>&1; then
    "\${ROOT[@]}" dnf install -y ca-certificates curl git
  elif command -v yum >/dev/null 2>&1; then
    "\${ROOT[@]}" yum install -y ca-certificates curl git
  else
    fatal "No supported package manager found"
  fi
}

if [[ "$MODE" == "preflight" ]]; then
  command -v git >/dev/null 2>&1 || fatal "git is required for a non-mutating preflight"
  command -v base64 >/dev/null 2>&1 || fatal "base64 is required for secure environment transfer"
  "\${ROOT[@]}" install -d -m 0700 "$WORK_ROOT"
  "\${ROOT[@]}" chown "$(id -u):$(id -g)" "$WORK_ROOT"
  TMP_DIR="$(mktemp -d "$WORK_ROOT/cts-k-n-preflight.XXXXXX")"
  log "Fetching the requested revision into a disposable preflight checkout"
  git clone --quiet --depth 1 --single-branch --branch "$BRANCH" "$REPO_URL" "$TMP_DIR/source"
  bash "$TMP_DIR/source/scripts/install.sh" --name "$PROJECT_NAME" --port "$APP_PORT" \
    --runtime "$RUNTIME" --service-user "$SERVICE_USER" ${installerMode} "\${SKIP_TESTS_ARG[@]}"
  log "Remote preflight passed without persistent host changes"
  exit 0
fi

install_bootstrap_dependencies
command -v base64 >/dev/null 2>&1 || fatal "base64 is required for secure environment transfer"
"\${ROOT[@]}" install -d -m 0700 "$WORK_ROOT"
"\${ROOT[@]}" chown "$(id -u):$(id -g)" "$WORK_ROOT"
TMP_DIR="$(mktemp -d "$WORK_ROOT/cts-k-n-bootstrap.XXXXXX")"
log "Fetching the requested bootstrap revision before replacing the target"
git clone --quiet --depth 1 --single-branch --branch "$BRANCH" "$REPO_URL" "$TMP_DIR/source"

SEED_FILE="$(mktemp "$WORK_ROOT/cts-k-n-seed.XXXXXX")"
printf '%s' "$SEED_ENV_BASE64" | base64 --decode > "$SEED_FILE"
chmod 600 "$SEED_FILE"

log "Running clean remote lifecycle: stop services, delete target, clone, install, migrate, build, and verify"
CTS_BOOTSTRAP_CLEAN_INSTALL=1 bash "$TMP_DIR/source/scripts/bootstrap-install.sh" \
  --dir "$APP_DIR" --name "$PROJECT_NAME" --port "$APP_PORT" \
  --runtime "$RUNTIME" --service-user "$SERVICE_USER" --repository "$REPO_URL" \
  --branch "$BRANCH" --seed-env-file "$SEED_FILE" -- "\${REINSTALL_ARG[@]}"
log "Remote installation, scheduler ownership, restart recovery, and schema verification passed"
`
}

function toLogLines(...values: string[]) {
  return values
    .flatMap((value) => value.replace(/\u001b\[[0-9;]*m/g, "").split("\n"))
    .filter(Boolean)
    .slice(-800)
}

export async function POST(request: Request) {
  const authorization = authorizeAdminBearer(request.headers.get("authorization"))
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    )
  }

  // Cloudflare/Kilo request workers cannot spawn SSH. They may securely proxy
  // the administrative request to the independently installed long-lived
  // owner, which runs this same route with Node/systemd capabilities.
  if (isServerlessDeploymentRuntime()) {
    const ownerSecret = String(process.env.REMOTE_INSTALL_OWNER_SECRET || "").trim()
    let ownerUrl: URL
    try {
      ownerUrl = new URL(String(process.env.REMOTE_INSTALL_OWNER_URL || ""))
    } catch {
      return NextResponse.json(
        { success: false, error: "Remote SSH install requires REMOTE_INSTALL_OWNER_URL on serverless/Kilo deployments" },
        { status: 503 },
      )
    }
    if (ownerUrl.protocol !== "https:" || ownerUrl.username || ownerUrl.password || ownerSecret.length < 16) {
      return NextResponse.json(
        { success: false, error: "Remote install owner proxy is not securely configured" },
        { status: 503 },
      )
    }
    if (ownerUrl.origin === new URL(request.url).origin) {
      return NextResponse.json({ success: false, error: "Remote install owner proxy cannot target itself" }, { status: 503 })
    }
    const rawBody = await request.text()
    if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BYTES) {
      return NextResponse.json({ success: false, error: "Remote install request is too large" }, { status: 413 })
    }
    const target = new URL("/api/install/remote", ownerUrl)
    try {
      const response = await fetch(target, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerSecret}`,
          "x-cts-install-proxy": "kilo",
        },
        body: rawBody,
        signal: AbortSignal.timeout(60 * 60 * 1000),
      })
      return new NextResponse(await response.text(), {
        status: response.status,
        headers: { "Content-Type": response.headers.get("content-type") || "application/json" },
      })
    } catch (error) {
      return NextResponse.json(
        { success: false, error: `Remote install owner proxy failed: ${error instanceof Error ? error.message : String(error)}` },
        { status: 502 },
      )
    }
  }

  let tempDir: string | null = null
  try {
    let body: RemoteInstallRequest
    try {
      const rawBody = await request.text()
      if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BYTES) {
        return NextResponse.json({ success: false, error: "Remote install request is too large" }, { status: 413 })
      }
      body = JSON.parse(rawBody) as RemoteInstallRequest
    } catch {
      return NextResponse.json({ success: false, error: "A JSON body is required" }, { status: 400 })
    }
    const input = validateRequest(body)
    const script = buildRemoteScript(input)

    const localWorkRoot = "/opt/cts-k-n-install-work"
    await mkdir(localWorkRoot, { recursive: true, mode: 0o700 })
    tempDir = await mkdtemp(path.join(localWorkRoot, "cts-remote-install-"))
    const knownHostsPath = path.join(tempDir, "known_hosts")
    const sshArgs = [
      "-p",
      String(input.port),
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsPath}`,
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=4",
      "-o",
      "ConnectTimeout=15",
    ]

    if (input.sshKey) {
      const keyPath = path.join(tempDir, "id_remote")
      await writeFile(keyPath, `${input.sshKey.trimEnd()}\n`, { mode: 0o600 })
      sshArgs.push("-i", keyPath, "-o", "IdentitiesOnly=yes")
    } else if (!input.password) {
      sshArgs.push("-o", "BatchMode=yes")
    }

    const usePassword = Boolean(input.password && !input.sshKey)
    const command = usePassword ? "sshpass" : "ssh"
    const sshHost = input.host.includes(":") ? `[${input.host}]` : input.host
    const args = usePassword
      ? ["-e", "ssh", ...sshArgs, `${input.username}@${sshHost}`, "bash -s"]
      : [...sshArgs, `${input.username}@${sshHost}`, "bash -s"]
    const result = await runRemoteCommand(command, args, script, {
      timeout: input.mode === "preflight" ? 10 * 60 * 1000 : 60 * 60 * 1000,
      env: { ...buildSshProcessEnv(), SSHPASS: input.password || "" },
    })

    return NextResponse.json({
      success: true,
      mode: input.mode,
      preflightPassed: true,
      message: input.mode === "preflight"
        ? "Remote production preflight passed"
        : "Remote production installation and continuity verification passed",
      logs: toLogLines(result.stdout, result.stderr),
      projectName: input.projectName,
      service: input.projectName,
      schedulerService: `${input.projectName}-scheduler`,
      runtime: input.runtime,
      url: `http://${sshHost}:${input.appPort}`,
    })
  } catch (error: any) {
    const remoteError = error as Error & { code?: string; path?: string; stdout?: string; stderr?: string }
    const missingSshpass = remoteError?.code === "ENOENT" && String(remoteError?.path || "").includes("sshpass")
    const validationError = error instanceof Error && !remoteError.stdout && !remoteError.stderr
    return NextResponse.json(
      {
        success: false,
        error: missingSshpass
          ? "Password SSH requires sshpass on this API host. Use an SSH private key or install sshpass."
          : error instanceof Error
            ? remoteError.message
            : "Remote operation failed",
        logs: toLogLines(String(remoteError.stdout || ""), String(remoteError.stderr || "")),
      },
      { status: validationError ? 400 : 500 },
    )
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  }
}
