import { NextResponse } from "next/server"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

interface RemoteInstallRequest {
  host?: string
  port?: number | string
  username?: string
  password?: string
  sshKey?: string
  installDir?: string
  repoUrl?: string
  branch?: string
  appPort?: number | string
  redisUrl?: string
  env?: Record<string, string>
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function safeName(value: string, fallback: string) {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._/-]/g, "")
  return cleaned || fallback
}

function runRemoteInstall(command: string, args: string[], input: string, options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env: options.env })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new Error("Remote installation timed out"))
    }, options.timeout ?? 20 * 60 * 1000)

    child.stdout.on("data", (chunk) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(Object.assign(error, { stdout, stderr }))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(Object.assign(new Error(`Remote installation failed with exit code ${code}`), { stdout, stderr }))
    })
    child.stdin.end(input)
  })
}

function buildInstallScript(input: Required<Pick<RemoteInstallRequest, "installDir" | "repoUrl" | "branch" | "appPort">> & { redisUrl?: string; env?: Record<string, string> }) {
  const envEntries = Object.entries(input.env ?? {}).filter(([key, value]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof value === "string")
  if (input.redisUrl) envEntries.push(["REDIS_URL", input.redisUrl])

  const envFile = envEntries
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")

  return `#!/usr/bin/env bash
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
APP_DIR=${shellQuote(input.installDir)}
REPO_URL=${shellQuote(input.repoUrl)}
BRANCH=${shellQuote(input.branch)}
APP_PORT=${shellQuote(String(input.appPort))}
SERVICE_NAME=cts-k-n
log(){ printf '[remote-install] %s\\n' "$*"; }

log "Installing operating-system dependencies"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl git build-essential redis-server
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y ca-certificates curl git gcc-c++ make redis
elif command -v yum >/dev/null 2>&1; then
  sudo yum install -y ca-certificates curl git gcc-c++ make redis
fi

log "Ensuring Node.js 22 and pnpm are available"
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable
sudo corepack prepare pnpm@latest --activate

log "Starting Redis when available"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl enable --now redis-server 2>/dev/null || sudo systemctl enable --now redis 2>/dev/null || true
fi

log "Checking out application"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER":"$USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  rm -rf "$APP_DIR"/*
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

log "Writing production environment"
cat > .env.production <<'ENVEOF'
NODE_ENV=production
PORT=${input.appPort}
${envFile || "REDIS_URL=redis://127.0.0.1:6379"}
ENVEOF
cp .env.production .env.local

log "Installing dependencies and building"
pnpm install --frozen-lockfile
pnpm run build

log "Installing systemd service"
sudo tee /etc/systemd/system/$SERVICE_NAME.service >/dev/null <<SERVICEEOF
[Unit]
Description=CTS-K-N production service
After=network-online.target redis-server.service redis.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env.production
ExecStart=$(command -v pnpm) start
Restart=always
RestartSec=5
User=$USER

[Install]
WantedBy=multi-user.target
SERVICEEOF
sudo systemctl daemon-reload
sudo systemctl enable --now $SERVICE_NAME
sudo systemctl restart $SERVICE_NAME

log "Verifying service and HTTP startup"
sudo systemctl --no-pager --full status $SERVICE_NAME || true
for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/system/health" >/dev/null 2>&1 || curl -fsS "http://127.0.0.1:$APP_PORT" >/dev/null 2>&1; then
    log "Application is running continuously on port $APP_PORT"
    exit 0
  fi
  sleep 2
done
log "Service started but HTTP health check did not become ready in time"
exit 1
`
}

export async function POST(request: Request) {
  let tempDir: string | null = null
  try {
    const body = (await request.json()) as RemoteInstallRequest
    const host = body.host?.trim()
    const username = body.username?.trim()
    if (!host || !username) return NextResponse.json({ success: false, error: "Host and username are required" }, { status: 400 })

    const port = String(body.port || 22)
    const installDir = safeName(body.installDir || "/opt/cts-k-n", "/opt/cts-k-n")
    const repoUrl = body.repoUrl?.trim() || "https://github.com/your-org/CTS-K-N.git"
    const branch = safeName(body.branch || "main", "main")
    const appPort = String(body.appPort || 3002)
    const script = buildInstallScript({ installDir, repoUrl, branch, appPort, redisUrl: body.redisUrl, env: body.env })

    tempDir = await mkdtemp(path.join(tmpdir(), "cts-remote-install-"))
    const scriptPath = path.join(tempDir, "install.sh")
    await writeFile(scriptPath, script, { mode: 0o700 })

    const sshArgs = ["-p", port, "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30"]
    const env = { ...process.env }

    if (body.sshKey?.trim()) {
      const keyPath = path.join(tempDir, "id_remote")
      await writeFile(keyPath, body.sshKey.trimEnd() + "\n", { mode: 0o600 })
      sshArgs.push("-i", keyPath, "-o", "IdentitiesOnly=yes")
    } else if (body.password?.trim()) {
      // Password auth is supported through sshpass when it is installed on the web server.
    } else {
      sshArgs.push("-o", "BatchMode=yes")
    }

    const usePassword = Boolean(body.password?.trim() && !body.sshKey?.trim())
    const command = usePassword ? "sshpass" : "ssh"
    const args = usePassword
      ? ["-e", "ssh", ...sshArgs, `${username}@${host}`, "bash -s"]
      : [...sshArgs, `${username}@${host}`, "bash -s"]
    const { stdout, stderr } = await runRemoteInstall(command, args, script, { timeout: 20 * 60 * 1000, env: { ...env, SSHPASS: body.password || "" } })

    return NextResponse.json({ success: true, message: "Remote installation completed and service was started", logs: [...stdout.split("\n"), ...stderr.split("\n")].filter(Boolean), service: "cts-k-n", url: `http://${host}:${appPort}` })
  } catch (error: any) {
    const missingSshpass = error?.code === "ENOENT" && String(error?.path || "").includes("sshpass")
    return NextResponse.json({ success: false, error: missingSshpass ? "Password SSH requires sshpass on this server. Use an SSH private key or install sshpass." : error instanceof Error ? error.message : "Remote installation failed", logs: [error?.stdout, error?.stderr].filter(Boolean).join("\n").split("\n").filter(Boolean) }, { status: 500 })
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  }
}
