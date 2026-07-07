#!/usr/bin/env bash
# =============================================================================
# CTS-V-A Install Script
# Usage: bash install.sh [--name <app-name>] [--port <port>]
# Defaults: name=cts  port=2222
# Tested on: Amazon Linux 2023, Ubuntu 22+, Debian 12+
# =============================================================================

set -euo pipefail

# ─────────────────────────────────────────────
# ANSI colour helpers
# ─────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
section() { echo -e "\n${BOLD}${CYAN}══════════════════════════════════════════════════════${RESET}"; \
            echo -e "${BOLD}${CYAN}  $*${RESET}"; \
            echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════${RESET}"; }
success() { echo -e "${BOLD}${GREEN}  $*${RESET}"; }

# ─────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────
APP_NAME="cts"
APP_PORT="2222"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name|-n)   APP_NAME="${2:?--name requires a value}"; shift 2 ;;
    --port|-p)   APP_PORT="${2:?--port requires a value}"; shift 2 ;;
    --help|-h)
      echo "Usage: bash install.sh [--name <app-name>] [--port <port>]"
      echo "  --name  -n   PM2 app name    (default: cts)"
      echo "  --port  -p   HTTP listen port (default: 2222)"
      exit 0 ;;
    *) error "Unknown argument: $1"; exit 1 ;;
  esac
done

# Validate port is numeric
if ! [[ "$APP_PORT" =~ ^[0-9]+$ ]] || [[ "$APP_PORT" -lt 1 ]] || [[ "$APP_PORT" -gt 65535 ]]; then
  error "Port must be a number between 1 and 65535 (got: $APP_PORT)"
  exit 1
fi

# ─────────────────────────────────────────────
# Resolve project root (script lives in scripts/)
# ─────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║          CTS-V-A Trading Engine — Installer          ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""
info "App name : ${BOLD}$APP_NAME${RESET}"
info "Port     : ${BOLD}$APP_PORT${RESET}"
info "Root     : ${BOLD}$PROJECT_ROOT${RESET}"
echo ""

# ─────────────────────────────────────────────
# 0. Detect OS / package manager
# ─────────────────────────────────────────────
section "0 / Detecting system"

OS="unknown"
PKG_INSTALL=""

if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS="${ID:-unknown}"
fi

# Pick package manager
if command -v dnf &>/dev/null; then
  PKG_INSTALL="dnf install -y -q"
  PKG_CHECK="rpm -q"
  ok "Package manager: dnf (Amazon Linux / RHEL / Fedora)"
elif command -v yum &>/dev/null; then
  PKG_INSTALL="yum install -y -q"
  PKG_CHECK="rpm -q"
  ok "Package manager: yum"
elif command -v apt-get &>/dev/null; then
  PKG_INSTALL="apt-get install -y -q"
  PKG_CHECK="dpkg -s"
  ok "Package manager: apt"
else
  warn "No recognised package manager — system package installs will be skipped"
  PKG_INSTALL=""
  PKG_CHECK=""
fi

ok "OS: ${OS} | Kernel: $(uname -r)"

# ─────────────────────────────────────────────
# Helper: install a system package only if missing
# ─────────────────────────────────────────────
sys_install_if_missing() {
  local pkg="$1"
  local bin="${2:-$1}"   # binary name to test with 'which'

  if command -v "$bin" &>/dev/null; then
    ok "  $pkg already installed ($(command -v "$bin"))"
    return 0
  fi

  if [ -z "$PKG_INSTALL" ]; then
    warn "  Cannot install $pkg — no package manager found. Please install manually."
    return 1
  fi

  info "  Installing $pkg via package manager..."
  if $PKG_INSTALL "$pkg" &>/dev/null 2>&1; then
    ok "  $pkg installed"
  else
    warn "  Failed to install $pkg — continuing (may not be needed)"
  fi
}

# ─────────────────────────────────────────────
# 1. System prerequisites
# ─────────────────────────────────────────────
section "1 / System prerequisites"

sys_install_if_missing "curl"   "curl"
sys_install_if_missing "git"    "git"
sys_install_if_missing "tar"    "tar"
sys_install_if_missing "gzip"   "gzip"
sys_install_if_missing "openssl" "openssl"

# ─────────────────────────────────────────────
# 2. Node.js >= 20 and < 23
# ─────────────────────────────────────────────
section "2 / Node.js (required >=20 <23)"

NODE_OK=false
if command -v node &>/dev/null; then
  NODE_VER=$(node --version 2>/dev/null | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 20 && "$NODE_MAJOR" -lt 23 ]]; then
    ok "Node.js $NODE_VER already installed and compatible"
    NODE_OK=true
  else
    warn "Node.js $NODE_VER found but outside required range >=20 <23"
  fi
fi

if [ "$NODE_OK" = false ]; then
  info "Installing Node.js 22 LTS via NodeSource..."
  if command -v curl &>/dev/null; then
    # Try NodeSource setup for the detected distro
    if [[ "$OS" == "amzn" || "$OS" == "rhel" || "$OS" == "fedora" ]]; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - &>/dev/null 2>&1 || true
      sys_install_if_missing "nodejs" "node"
    elif [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - &>/dev/null 2>&1 || true
      sys_install_if_missing "nodejs" "node"
    else
      warn "Cannot auto-install Node.js on OS=${OS}. Install Node.js 20–22 manually."
    fi
  fi

  # Final check
  if command -v node &>/dev/null; then
    ok "Node.js $(node --version) ready"
  else
    error "Node.js installation failed. Install Node.js 20–22 manually and re-run."
    exit 1
  fi
fi

# ─────────────────────────────────────────────
# 3. npm / pnpm / pm2
# ─────────────────────────────────────────────
section "3 / npm, pnpm, pm2"

# npm comes with Node
if command -v npm &>/dev/null; then
  ok "npm $(npm --version) ready"
else
  error "npm not found — reinstall Node.js"
  exit 1
fi

# pnpm
if command -v pnpm &>/dev/null; then
  ok "pnpm $(pnpm --version) already installed"
else
  info "Installing pnpm..."
  npm install -g pnpm --loglevel=error
  ok "pnpm $(pnpm --version) installed"
fi

# pm2
if command -v pm2 &>/dev/null; then
  ok "pm2 $(pm2 --version 2>/dev/null || echo '?') already installed"
else
  info "Installing pm2..."
  npm install -g pm2 --loglevel=error
  ok "pm2 $(pm2 --version) installed"
fi

# ─────────────────────────────────────────────
# 4. Python 3 + pip (optional — for diagnostic scripts)
# ─────────────────────────────────────────────
section "4 / Python 3 + pip (optional, used by diagnostic tools)"

PYTHON_OK=false
for py in python3 python; do
  if command -v "$py" &>/dev/null; then
    PYVER=$($py --version 2>&1 | awk '{print $2}')
    PYMAJ=$(echo "$PYVER" | cut -d. -f1)
    if [[ "$PYMAJ" -ge 3 ]]; then
      ok "Python $PYVER found at $(command -v $py)"
      PYTHON_CMD="$py"
      PYTHON_OK=true
      break
    fi
  fi
done

if [ "$PYTHON_OK" = false ]; then
  sys_install_if_missing "python3" "python3"
  PYTHON_CMD="python3"
fi

# pip3
if command -v pip3 &>/dev/null; then
  ok "pip3 $(pip3 --version 2>/dev/null | awk '{print $2}') already installed"
elif command -v pip &>/dev/null; then
  ok "pip $(pip --version 2>/dev/null | awk '{print $2}') already installed"
  alias pip3=pip
else
  info "Installing pip3..."
  sys_install_if_missing "python3-pip" "pip3" || true
  # Fallback: use ensurepip
  if ! command -v pip3 &>/dev/null; then
    $PYTHON_CMD -m ensurepip --upgrade &>/dev/null 2>&1 || true
    $PYTHON_CMD -m pip install --upgrade pip --quiet &>/dev/null 2>&1 || true
  fi
  if command -v pip3 &>/dev/null; then
    ok "pip3 installed"
  else
    warn "pip3 could not be installed — Python package features unavailable"
  fi
fi

# Python packages used by diagnostic scripts
PYTHON_PKGS=("requests" "urllib3")

if command -v pip3 &>/dev/null; then
  for pkg in "${PYTHON_PKGS[@]}"; do
    if $PYTHON_CMD -c "import $pkg" &>/dev/null 2>&1; then
      ok "  Python package '$pkg' already installed"
    else
      info "  pip install --force-reinstall $pkg ..."
      pip3 install --quiet --force-reinstall "$pkg" 2>/dev/null \
        && ok "  '$pkg' installed" \
        || warn "  Failed to install '$pkg' — continuing"
    fi
  done
else
  warn "Skipping Python package installs (pip3 not available)"
fi

# ─────────────────────────────────────────────
# 5. Redis (optional — app falls back to InlineLocalRedis)
# ─────────────────────────────────────────────
section "5 / Redis (optional — app works without it)"

REDIS_RUNNING=false
if command -v redis-cli &>/dev/null; then
  if redis-cli ping &>/dev/null 2>&1; then
    REDIS_RUNNING=true
    ok "Redis is installed and running"
    REDIS_URL="redis://127.0.0.1:6379"
  else
    warn "redis-cli found but Redis server not responding — will use in-process store"
  fi
else
  info "Redis not installed — app will use InlineLocalRedis (in-process, no persistence across restarts)"
  info "To install Redis: sudo dnf install redis / sudo apt-get install redis-server"
fi

# ─────────────────────────────────────────────
# 6. Project dependencies (pnpm install)
# ─────────────────────────────────────────────
section "6 / Installing project dependencies"

cd "$PROJECT_ROOT"

if [ -d "node_modules" ] && [ -f "node_modules/.modules.yaml" ]; then
  ok "node_modules present — running pnpm install to sync/update..."
else
  info "node_modules missing — full install..."
fi

pnpm install --frozen-lockfile 2>/dev/null \
  || pnpm install 2>/dev/null \
  || { error "pnpm install failed"; exit 1; }

ok "All npm/pnpm packages installed"

# ─────────────────────────────────────────────
# 7. TypeScript check
# ─────────────────────────────────────────────
section "7 / TypeScript validation"

if pnpm exec tsc --noEmit --skipLibCheck 2>&1 | grep -v "node_modules\|__tests__" | grep "error TS" | head -5; then
  warn "TypeScript reported errors (see above) — build may still work with ignoreBuildErrors"
else
  ok "TypeScript validation passed (0 errors)"
fi

# ─────────────────────────────────────────────
# 8. Production build
# ─────────────────────────────────────────────
section "8 / Building production bundle"

if [ -d ".next" ] && [ -f ".next/BUILD_ID" ]; then
  BUILD_ID=$(cat .next/BUILD_ID 2>/dev/null)
  ok ".next already built (BUILD_ID: $BUILD_ID) — skipping rebuild"
  info "Run 'pnpm build' manually to force a fresh build"
else
  info "Building Next.js production bundle (this takes 1–3 minutes)..."
  NODE_OPTIONS='--max-old-space-size=12288 --max-semi-space-size=128' \
    pnpm build 2>&1 | tail -20 \
    || { error "Production build failed — check output above"; exit 1; }
  ok "Build complete ($(cat .next/BUILD_ID 2>/dev/null || echo '?'))"
fi

# ─────────────────────────────────────────────
# 9. Create runtime directories
# ─────────────────────────────────────────────
section "9 / Runtime directories"

mkdir -p data/redis
mkdir -p logs
ok "data/redis/ and logs/ created"

# ─────────────────────────────────────────────
# 10. Environment file
# ─────────────────────────────────────────────
section "10 / Environment file"

ENV_FILE="$PROJECT_ROOT/.env.production.local"

if [ ! -f "$ENV_FILE" ]; then
  info "Creating $ENV_FILE with defaults..."
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=$APP_PORT
FORCE_LIVE=1
ENABLE_PRODUCTION_MIGRATIONS=1
AUTO_MIGRATE_ON_STARTUP=1
PROGRESSION_CYCLE_INTERVAL_MS=5000
LIVE_SYNC_INTERVAL_MS=200
REDIS_HEAP_PRESSURE_MB=1200
REDIS_MAX_TOTAL_KEYS=12000
NEXT_PUBLIC_API_URL=http://localhost:${APP_PORT}/api
EOF
  # Inject REDIS_URL if Redis is running
  if [ "$REDIS_RUNNING" = true ]; then
    echo "REDIS_URL=${REDIS_URL}" >> "$ENV_FILE"
    ok "REDIS_URL set to ${REDIS_URL}"
  fi
  ok "Created $ENV_FILE"
else
  ok "$ENV_FILE already exists — not overwritten"
  # Patch PORT if it differs
  if grep -q "^PORT=" "$ENV_FILE"; then
    EXISTING_PORT=$(grep "^PORT=" "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')
    if [ "$EXISTING_PORT" != "$APP_PORT" ]; then
      warn "Existing PORT=$EXISTING_PORT — updating to PORT=$APP_PORT"
      sed -i "s/^PORT=.*/PORT=${APP_PORT}/" "$ENV_FILE"
    fi
  else
    echo "PORT=$APP_PORT" >> "$ENV_FILE"
    ok "PORT=$APP_PORT appended to $ENV_FILE"
  fi
fi

# ─────────────────────────────────────────────
# 11. PM2 ecosystem file
# ─────────────────────────────────────────────
section "11 / PM2 ecosystem config"

ECOSYSTEM_FILE="$PROJECT_ROOT/ecosystem.config.js"

cat > "$ECOSYSTEM_FILE" <<EOF
// CTS-V-A PM2 ecosystem — auto-generated by install.sh
// App: ${APP_NAME}   Port: ${APP_PORT}
module.exports = {
  apps: [
    {
      name: "${APP_NAME}",
      cwd: "${PROJECT_ROOT}",
      script: "node_modules/.bin/next",
      args: "start --port ${APP_PORT}",
      instances: 1,
      exec_mode: "fork",
      node_args: "--max-old-space-size=12288 --max-semi-space-size=128",
      env: {
        NODE_ENV: "production",
        PORT: "${APP_PORT}",
        FORCE_LIVE: "1",
        ENABLE_PRODUCTION_MIGRATIONS: "1",
        AUTO_MIGRATE_ON_STARTUP: "1",
      },
      // Restart policy
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 3000,
      // Logs
      out_file:   "${PROJECT_ROOT}/logs/${APP_NAME}-out.log",
      error_file: "${PROJECT_ROOT}/logs/${APP_NAME}-err.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      // Watch (disabled for production — use deployments instead)
      watch: false,
    },
  ],
};
EOF

ok "ecosystem.config.js written → $ECOSYSTEM_FILE"

# ─────────────────────────────────────────────
# 12. Stop any old PM2 process with this name
# ─────────────────────────────────────────────
section "12 / Stopping previous instance (if any)"

if pm2 list 2>/dev/null | grep -q "\\b${APP_NAME}\\b"; then
  info "Stopping existing PM2 process: $APP_NAME"
  pm2 delete "$APP_NAME" --silent 2>/dev/null || true
  ok "Old process removed"
else
  ok "No previous PM2 process named '$APP_NAME'"
fi

# ─────────────────────────────────────────────
# 13. Start application with PM2
# ─────────────────────────────────────────────
section "13 / Starting application"

cd "$PROJECT_ROOT"
pm2 start ecosystem.config.js

# Wait for the process to come up
info "Waiting for the app to come up on port $APP_PORT..."
MAX_WAIT=90
ELAPSED=0
APP_READY=false

while [ $ELAPSED -lt $MAX_WAIT ]; do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:${APP_PORT}" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    APP_READY=true
    break
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
  echo -n "."
done
echo ""

if [ "$APP_READY" = false ]; then
  warn "App did not respond on port $APP_PORT within ${MAX_WAIT}s"
  warn "Check logs: pm2 logs $APP_NAME --lines 40"
else
  ok "App is responding on port $APP_PORT"
fi

# ─────────────────────────────────────────────
# 14. Save PM2 process list & setup startup hook
# ─────────────────────────────────────────────
section "14 / PM2 startup persistence"

pm2 save --force &>/dev/null && ok "PM2 process list saved"

# Generate the startup command (print it; user may need to run as root)
STARTUP_CMD=$(pm2 startup 2>/dev/null | grep "sudo " | head -1 || true)
if [ -n "$STARTUP_CMD" ]; then
  info "To survive reboots, run this once as root:"
  echo -e "    ${BOLD}${YELLOW}${STARTUP_CMD}${RESET}"
fi

# ─────────────────────────────────────────────
# 15. Quick health check
# ─────────────────────────────────────────────
section "15 / Post-install health check"

HEALTH_URL="http://localhost:${APP_PORT}/api/trade-engine/status"
HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 6 "$HEALTH_URL" 2>/dev/null || echo "000")

if [ "$HEALTH_CODE" = "200" ]; then
  ok "Health check passed (HTTP 200) — $HEALTH_URL"
else
  warn "Health check returned HTTP $HEALTH_CODE — engine may still be initialising"
  warn "Re-check in 30s: curl -s $HEALTH_URL | python3 -m json.tool"
fi

# ─────────────────────────────────────────────
# 16. Detect public IP
# ─────────────────────────────────────────────
section "16 / Network access information"

PUBLIC_IP=""
for svc in \
  "https://checkip.amazonaws.com" \
  "https://api.ipify.org" \
  "https://icanhazip.com" \
  "https://ifconfig.me"; do
  ip=$(curl -s --max-time 4 "$svc" 2>/dev/null | tr -d '[:space:]')
  if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    PUBLIC_IP="$ip"
    break
  fi
done

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")

# ─────────────────────────────────────────────
# 17. Final summary
# ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║           INSTALLATION COMPLETE                      ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════╝${RESET}"
echo ""
success "App name    : $APP_NAME"
success "Port        : $APP_PORT"
success "Project     : $PROJECT_ROOT"
success "Build ID    : $(cat .next/BUILD_ID 2>/dev/null || echo 'unknown')"
success "Node.js     : $(node --version)"
success "pnpm        : $(pnpm --version)"
success "PM2         : $(pm2 --version 2>/dev/null || echo '?')"
[ "$REDIS_RUNNING" = true ] && success "Redis       : running (${REDIS_URL})" \
                             || warn    "Redis       : not running — using InlineLocalRedis (dev-mode in-process store)"
echo ""
echo -e "${BOLD}${CYAN}── Access URLs ─────────────────────────────────────────${RESET}"
echo -e "  Local      : ${BOLD}http://localhost:${APP_PORT}${RESET}"
echo -e "  LAN        : ${BOLD}http://${LOCAL_IP}:${APP_PORT}${RESET}"
if [ -n "$PUBLIC_IP" ]; then
  echo -e "  Public     : ${BOLD}http://${PUBLIC_IP}:${APP_PORT}${RESET}"
  echo ""
  warn "Ensure port ${APP_PORT} is open in your firewall / security group!"
  warn "AWS: EC2 → Security Groups → Inbound → Add rule: Custom TCP ${APP_PORT} 0.0.0.0/0"
else
  warn "Could not detect public IP — check your network configuration"
fi
echo ""
echo -e "${BOLD}${CYAN}── Useful Commands ────────────────────────────────────${RESET}"
echo -e "  Status     : ${BOLD}pm2 status${RESET}"
echo -e "  Logs       : ${BOLD}pm2 logs $APP_NAME${RESET}"
echo -e "  Restart    : ${BOLD}pm2 restart $APP_NAME${RESET}"
echo -e "  Stop       : ${BOLD}pm2 stop $APP_NAME${RESET}"
echo -e "  Delete     : ${BOLD}pm2 delete $APP_NAME${RESET}"
echo ""
echo -e "${BOLD}${CYAN}── API Endpoints ───────────────────────────────────────${RESET}"
echo -e "  Dashboard  : http://${PUBLIC_IP:-localhost}:${APP_PORT}/"
echo -e "  Status     : http://${PUBLIC_IP:-localhost}:${APP_PORT}/api/trade-engine/status"
echo -e "  Stats      : http://${PUBLIC_IP:-localhost}:${APP_PORT}/api/connections/progression/bingx-x01/stats"
echo -e "  Start      : POST http://${PUBLIC_IP:-localhost}:${APP_PORT}/api/trade-engine/start"
echo ""
echo -e "${BOLD}${CYAN}── PM2 Process List ───────────────────────────────────${RESET}"
pm2 status 2>/dev/null || true
echo ""
[ "$APP_READY" = true ] && ok "Everything is up and running." || warn "App may still be starting up — run 'pm2 logs $APP_NAME' to monitor."
echo ""
