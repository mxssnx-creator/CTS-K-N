#!/usr/bin/env bash
# CTS-K-N production installer for Ubuntu/Debian, RHEL/Fedora/Amazon Linux,
# and compatible long-lived Linux servers.
#
# The installer is intentionally fail-closed:
#   - production always uses a network Redis backend (local or external)
#   - real trading is never enabled automatically
#   - exactly one app process and one portable 60-second scheduler are installed
#   - the complete test/build/migration/deployment contract runs before success
#   - an existing production build is restored when build or verification fails

set -Eeuo pipefail
umask 027

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { printf "%b[INFO]%b  %s\n" "$CYAN" "$RESET" "$*"; }
ok()      { printf "%b[OK]%b    %s\n" "$GREEN" "$RESET" "$*"; }
warn()    { printf "%b[WARN]%b  %s\n" "$YELLOW" "$RESET" "$*"; }
fatal()   { printf "%b[ERROR]%b %s\n" "$RED" "$RESET" "$*" >&2; exit 1; }
section() { printf "\n%b%s%b\n" "$BOLD$CYAN" "════════ $* ════════" "$RESET"; }

APP_NAME="cts-k-n"
APP_PORT="3002"
RUNTIME="auto"
SERVICE_USER="${SUDO_USER:-${USER:-$(id -un)}}"
CREATE_SERVICE_USER=0
PREFLIGHT_ONLY=0
SKIP_SYSTEM_PACKAGES=0
SKIP_TESTS=0
NON_INTERACTIVE=0
SEED_ENV_FILE=""
PNPM_VERSION="10.28.1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env.production.local"
RUNTIME_DIR="$PROJECT_ROOT/.cts-runtime"
BUILD_BACKUP=""
ROLLBACK_ARMED=0
ROLLBACK_RUNNING=0

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh [options]

Options:
  --name NAME             Service/process name (default: cts-k-n)
  --port PORT             HTTP port (default: 3002)
  --runtime MODE          auto, systemd, or pm2 (default: auto)
  --service-user USER     Unprivileged runtime user (default: current user)
  --create-service-user   Create the system service user when it is absent
  --env-file PATH         Production environment file
  --seed-env-file PATH    Merge KEY=VALUE entries before installation
  --preflight-only        Run non-mutating host/project checks and exit
  --skip-system-packages  Do not install OS packages
  --skip-tests            Skip Jest only (typecheck, lint, and build still run)
  --non-interactive       Never rely on interactive package prompts
  --help                  Show this help

Sensitive values should be supplied in --seed-env-file or the existing env
file, never as command-line arguments. The installer generates ADMIN_SECRET,
CRON_SECRET, ENCRYPTION_KEY, and JWT_SECRET when they are absent, but never
enables FORCE_LIVE automatically.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) APP_NAME="${2:?--name requires a value}"; shift 2 ;;
    --port) APP_PORT="${2:?--port requires a value}"; shift 2 ;;
    --runtime) RUNTIME="${2:?--runtime requires a value}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:?--service-user requires a value}"; shift 2 ;;
    --create-service-user) CREATE_SERVICE_USER=1; shift ;;
    --env-file) ENV_FILE="${2:?--env-file requires a value}"; shift 2 ;;
    --seed-env-file) SEED_ENV_FILE="${2:?--seed-env-file requires a value}"; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --skip-system-packages) SKIP_SYSTEM_PACKAGES=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fatal "Unknown option: $1" ;;
  esac
done

[[ "$APP_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || fatal "Invalid service name: $APP_NAME"
[[ "$SERVICE_USER" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]] || fatal "Invalid service user: $SERVICE_USER"
[[ "$APP_PORT" =~ ^[0-9]+$ ]] && (( APP_PORT >= 1 && APP_PORT <= 65535 )) || fatal "Port must be 1..65535"
case "$RUNTIME" in auto|systemd|pm2) ;; *) fatal "Runtime must be auto, systemd, or pm2" ;; esac
[[ "$PROJECT_ROOT" != "/" && -f "$PROJECT_ROOT/package.json" && -f "$PROJECT_ROOT/pnpm-lock.yaml" ]] \
  || fatal "Installer must run from a complete CTS-K-N checkout"
[[ -f "$PROJECT_ROOT/lib/redis-migrations.ts" ]] || fatal "Migration bundle is missing"
[[ -z "$SEED_ENV_FILE" || -r "$SEED_ENV_FILE" ]] || fatal "Seed env file is not readable: $SEED_ENV_FILE"

if (( EUID == 0 )); then
  SUDO=()
elif command -v sudo >/dev/null 2>&1; then
  if (( NON_INTERACTIVE == 1 )); then SUDO=(sudo -n); else SUDO=(sudo); fi
else
  SUDO=()
fi

run_root() {
  if (( EUID != 0 )) && (( ${#SUDO[@]} == 0 )); then
    fatal "Root privileges or sudo are required for package/service installation"
  fi
  "${SUDO[@]}" "$@"
}

service_home() {
  local home
  home="$(awk -F: -v user="$SERVICE_USER" '$1 == user { print $6; exit }' /etc/passwd 2>/dev/null || true)"
  [[ -n "$home" && "$home" != "/" ]] || home="/var/lib/$APP_NAME"
  printf '%s' "$home"
}

run_as_service() {
  local home
  home="$(service_home)"
  if [[ "$(id -un)" == "$SERVICE_USER" ]]; then
    env HOME="$home" PM2_HOME="$home/.pm2" "$@"
  elif (( EUID == 0 )); then
    runuser -u "$SERVICE_USER" -- env HOME="$home" PM2_HOME="$home/.pm2" "$@"
  else
    run_root -u "$SERVICE_USER" env HOME="$home" PM2_HOME="$home/.pm2" "$@"
  fi
}

detect_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then printf 'apt'; return; fi
  if command -v dnf >/dev/null 2>&1; then printf 'dnf'; return; fi
  if command -v yum >/dev/null 2>&1; then printf 'yum'; return; fi
  printf 'none'
}

PACKAGE_MANAGER="$(detect_package_manager)"

free_port() {
  if command -v ss >/dev/null 2>&1; then
    ! ss -ltn "sport = :$APP_PORT" 2>/dev/null | tail -n +2 | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 | grep -q .
  elif [[ -r /proc/net/tcp ]]; then
    local port_hex files=(/proc/net/tcp)
    printf -v port_hex '%04X' "$APP_PORT"
    [[ -r /proc/net/tcp6 ]] && files+=(/proc/net/tcp6)
    ! awk -v needle=":$port_hex" '
      $4 == "0A" && substr($2, length($2) - 4) == needle { found = 1 }
      END { exit(found ? 0 : 1) }
    ' "${files[@]}"
  else
    return 2
  fi
}

existing_runtime_active() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$APP_NAME" 2>/dev/null; then return 0; fi
  if command -v pm2 >/dev/null 2>&1 && id "$SERVICE_USER" >/dev/null 2>&1 \
    && run_as_service pm2 describe "$APP_NAME" >/dev/null 2>&1; then return 0; fi
  return 1
}

run_preflight() {
  section "Production preflight"
  [[ "$(uname -s)" == "Linux" ]] || fatal "Only long-lived Linux servers are supported by this installer"
  ok "OS: $(uname -srm)"
  [[ "$PACKAGE_MANAGER" != "none" || "$SKIP_SYSTEM_PACKAGES" == "1" ]] \
    || fatal "No supported package manager found (apt, dnf, or yum)"
  ok "Package manager: $PACKAGE_MANAGER"

  local disk_kb memory_kb
  disk_kb="$(df -Pk "$PROJECT_ROOT" | awk 'NR==2 {print $4}')"
  memory_kb="$(awk '/MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
  (( disk_kb >= 4 * 1024 * 1024 )) || fatal "At least 4 GiB free disk is required"
  (( memory_kb >= 1536 * 1024 )) || fatal "At least 1.5 GiB RAM is required"
  ok "Capacity: $((disk_kb / 1024 / 1024)) GiB free disk, $((memory_kb / 1024 / 1024)) GiB RAM"

  local port_status=0
  free_port || port_status=$?
  if (( port_status == 0 )); then
    ok "Port $APP_PORT is available"
  elif (( port_status == 2 )); then
    fatal "Cannot inspect TCP port $APP_PORT (ss, lsof, and /proc/net/tcp unavailable)"
  elif existing_runtime_active; then
    warn "Port $APP_PORT is owned by the existing CTS service; upgrade mode will restart it"
  else
    fatal "Port $APP_PORT is already in use by an unrelated process"
  fi

  if [[ "$RUNTIME" == "systemd" ]]; then
    command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] \
      || fatal "The requested systemd runtime is not active on this host"
  fi
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    if (( CREATE_SERVICE_USER == 1 )); then
      command -v useradd >/dev/null 2>&1 || fatal "useradd is required to create service user $SERVICE_USER"
      warn "Service user $SERVICE_USER will be created during installation"
    else
      fatal "Service user does not exist: $SERVICE_USER (use --create-service-user)"
    fi
  fi

  for file in package.json pnpm-lock.yaml pnpm-workspace.yaml scripts/run-minute-scheduler.mjs scripts/run-with-env.mjs scripts/post-deploy-verify.sh scripts/production-deploy-init.mjs; do
    [[ -f "$PROJECT_ROOT/$file" ]] || fatal "Required install artifact is missing: $file"
  done
  bash -n "$PROJECT_ROOT/scripts/install.sh"
  ok "Project/install artifacts are complete and shell syntax is valid"

  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -p 'Number(process.versions.node.split(".")[0])')"
    (( major >= 20 )) || warn "Node $(node --version) will be upgraded to Node 22"
  else
    warn "Node.js is missing and will be installed"
  fi
  [[ -z "$SEED_ENV_FILE" ]] || ok "Seed environment file is readable"
}

run_preflight
if (( PREFLIGHT_ONLY == 1 )); then
  ok "Preflight completed without mutations"
  exit 0
fi

install_system_packages() {
  (( SKIP_SYSTEM_PACKAGES == 0 )) || { warn "Skipping OS package installation"; return; }
  section "Operating-system dependencies"
  case "$PACKAGE_MANAGER" in
    apt)
      (( NON_INTERACTIVE == 1 )) && export DEBIAN_FRONTEND=noninteractive
      run_root apt-get update -y
      run_root apt-get install -y ca-certificates curl git build-essential openssl redis-server redis-tools
      ;;
    dnf)
      run_root dnf install -y ca-certificates curl git gcc-c++ make openssl redis
      ;;
    yum)
      run_root yum install -y ca-certificates curl git gcc-c++ make openssl redis
      ;;
    none) fatal "Cannot install required system packages" ;;
  esac
  ok "System dependencies installed"
}

ensure_service_user() {
  section "Unprivileged service identity"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    (( CREATE_SERVICE_USER == 1 )) || fatal "Service user does not exist: $SERVICE_USER (use --create-service-user)"
    local nologin_shell="/usr/sbin/nologin"
    [[ -x "$nologin_shell" ]] || nologin_shell="/sbin/nologin"
    [[ -x "$nologin_shell" ]] || nologin_shell="/bin/false"
    run_root useradd --system --create-home --home-dir "/var/lib/$APP_NAME" --shell "$nologin_shell" "$SERVICE_USER"
    ok "Created system service user: $SERVICE_USER"
  else
    ok "Service user exists: $SERVICE_USER"
  fi
}

ensure_node_and_pnpm() {
  section "Node.js and pinned pnpm"
  local major=0
  command -v node >/dev/null 2>&1 && major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  if (( major < 20 )); then
    info "Installing Node.js 22 LTS"
    case "$PACKAGE_MANAGER" in
      apt)
        curl -fsSL https://deb.nodesource.com/setup_22.x | run_root bash -
        run_root apt-get install -y nodejs
        ;;
      dnf|yum)
        curl -fsSL https://rpm.nodesource.com/setup_22.x | run_root bash -
        run_root "$PACKAGE_MANAGER" install -y nodejs
        ;;
      *) fatal "Install Node.js >=20 manually" ;;
    esac
  fi
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  (( major >= 20 )) || fatal "Node.js >=20 is required"

  if command -v corepack >/dev/null 2>&1; then
    run_root corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null 2>&1 || [[ "$(pnpm --version 2>/dev/null || true)" != "$PNPM_VERSION" ]]; then
    run_root npm install -g "pnpm@$PNPM_VERSION" --no-audit --no-fund --loglevel=error
  fi
  [[ "$(pnpm --version)" == "$PNPM_VERSION" ]] || fatal "Could not activate pnpm $PNPM_VERSION"
  ok "Node $(node --version), pnpm $(pnpm --version)"
}

env_value() {
  local key="$1" value
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

upsert_env() {
  local key="$1" value="$2" tmp
  [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || fatal "Invalid environment key: $key"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fatal "Environment values cannot contain newlines"
  tmp="$(mktemp "$RUNTIME_DIR/env.XXXXXX")"
  grep -Ev "^${key}=" "$ENV_FILE" 2>/dev/null > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

merge_seed_env() {
  [[ -n "$SEED_ENV_FILE" ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fatal "Invalid seed environment line"
    key="${line%%=*}"; value="${line#*=}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || fatal "Invalid seed environment key: $key"
    case "$key" in NODE_OPTIONS|PATH|LD_*|BASH_ENV|ENV|SHELL|HOME|FORCE_LIVE|ALLOW_LIVE_ORDER_PLACEMENT) fatal "Blocked seed environment key: $key" ;; esac
    upsert_env "$key" "$value"
  done < "$SEED_ENV_FILE"
}

placeholder_secret() {
  local value="$1"
  [[ -z "$value" || ${#value} -lt 16 || "$value" =~ ^(replace|change|your)[_-]?me ]]
}

configure_environment_and_redis() {
  section "Durable Redis and production environment"
  mkdir -p "$RUNTIME_DIR" "$PROJECT_ROOT/logs" "$PROJECT_ROOT/data/redis"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  merge_seed_env

  local redis_url
  redis_url="${INSTALL_REDIS_URL:-$(env_value REDIS_URL)}"
  if [[ -z "$redis_url" ]]; then
    if command -v systemctl >/dev/null 2>&1; then
      run_root systemctl enable --now redis-server 2>/dev/null || run_root systemctl enable --now redis
    fi
    redis_url="redis://127.0.0.1:6379"
  fi

  command -v redis-cli >/dev/null 2>&1 || fatal "redis-cli is required to verify durable persistence"
  redis-cli -u "$redis_url" --no-auth-warning ping >/dev/null 2>&1 \
    || fatal "Redis is not reachable; refusing process-local production fallback"
  if [[ "$redis_url" =~ ^redis://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/[0-9]+)?/?$ ]]; then
    redis-cli -u "$redis_url" --no-auth-warning CONFIG SET appendonly yes >/dev/null
    redis-cli -u "$redis_url" --no-auth-warning CONFIG SET save "900 1 300 10 60 10000" >/dev/null
    redis-cli -u "$redis_url" --no-auth-warning CONFIG REWRITE >/dev/null 2>&1 || true
    [[ "$(redis-cli -u "$redis_url" --no-auth-warning CONFIG GET appendonly | tail -n 1)" == "yes" ]] \
      || fatal "Local Redis AOF persistence could not be enabled"
  fi

  upsert_env NODE_ENV production
  upsert_env HOST 0.0.0.0
  upsert_env PORT "$APP_PORT"
  upsert_env REDIS_URL "$redis_url"
  upsert_env ALLOW_PROD_INLINE_REDIS 0
  upsert_env ALLOW_INLINE_REDIS_LIVE_TRADING 0
  upsert_env ENABLE_PRODUCTION_MIGRATIONS 1
  upsert_env AUTO_MIGRATE_ON_STARTUP 1
  upsert_env DISABLE_IN_PROCESS_CONTINUITY 1
  upsert_env DISABLE_TRADE_ENGINE_IN_PROCESS 0
  upsert_env SCHEDULER_BASE_URL "http://127.0.0.1:$APP_PORT"
  upsert_env NEXT_PUBLIC_APP_URL "${NEXT_PUBLIC_APP_URL:-$(env_value NEXT_PUBLIC_APP_URL)}"
  [[ -n "$(env_value NEXT_PUBLIC_APP_URL)" ]] || upsert_env NEXT_PUBLIC_APP_URL "http://127.0.0.1:$APP_PORT"

  local admin_secret cron_secret encryption_key jwt_secret
  admin_secret="$(env_value ADMIN_SECRET)"; cron_secret="$(env_value CRON_SECRET)"
  encryption_key="$(env_value ENCRYPTION_KEY)"; jwt_secret="$(env_value JWT_SECRET)"
  if placeholder_secret "$admin_secret"; then upsert_env ADMIN_SECRET "$(openssl rand -hex 32)"; fi
  if placeholder_secret "$cron_secret"; then upsert_env CRON_SECRET "$(openssl rand -hex 32)"; fi
  if placeholder_secret "$encryption_key"; then upsert_env ENCRYPTION_KEY "$(openssl rand -hex 32)"; fi
  if placeholder_secret "$jwt_secret"; then upsert_env JWT_SECRET "$(openssl rand -hex 32)"; fi
  ok "Network Redis is reachable, persistence is enabled, and secrets/gates are configured"
}

resolve_runtime() {
  if [[ "$RUNTIME" == "auto" ]]; then
    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then RUNTIME="systemd"; else RUNTIME="pm2"; fi
  fi
  upsert_env CTS_DEPLOYMENT_RUNTIME "$RUNTIME"
  ok "Runtime owner: $RUNTIME (one app + one external minute scheduler)"
}

stop_runtime() {
  if [[ "$RUNTIME" == "systemd" ]] && command -v systemctl >/dev/null 2>&1; then
    run_root systemctl stop "$APP_NAME-scheduler" "$APP_NAME" 2>/dev/null || true
  elif [[ "$RUNTIME" == "pm2" ]] && command -v pm2 >/dev/null 2>&1; then
    run_as_service pm2 stop "$APP_NAME-scheduler" "$APP_NAME" >/dev/null 2>&1 || true
  fi
}

start_runtime() {
  if [[ "$RUNTIME" == "systemd" ]]; then
    run_root systemctl restart "$APP_NAME"
    run_root systemctl restart "$APP_NAME-scheduler"
  else
    run_as_service pm2 restart "$APP_NAME" --update-env >/dev/null 2>&1 || true
    run_as_service pm2 restart "$APP_NAME-scheduler" --update-env >/dev/null 2>&1 || true
  fi
}

install_dependencies_and_validate() {
  section "Locked dependencies and full release validation"
  cd "$PROJECT_ROOT"
  pnpm install --frozen-lockfile
  pnpm exec tsc --noEmit
  pnpm exec eslint .
  if (( SKIP_TESTS == 0 )); then
    pnpm exec jest --runInBand --detectOpenHandles --passWithNoTests
  else
    warn "Jest was explicitly skipped"
  fi

  stop_runtime
  mkdir -p "$RUNTIME_DIR"
  if [[ -d "$PROJECT_ROOT/.next" ]]; then
    BUILD_BACKUP="$RUNTIME_DIR/previous-next-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$PROJECT_ROOT/.next" "$BUILD_BACKUP"
    ROLLBACK_ARMED=1
  fi
  if ! node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- pnpm run build; then
    [[ -z "$BUILD_BACKUP" || ! -d "$BUILD_BACKUP" ]] || mv "$BUILD_BACKUP" "$PROJECT_ROOT/.next"
    ROLLBACK_ARMED=0
    start_runtime || true
    fatal "Production build failed; previous build restored"
  fi
  [[ -f "$PROJECT_ROOT/.next/BUILD_ID" ]] || fatal "Production build did not create BUILD_ID"
  ok "All static checks/tests and the optimized production build passed"
}

write_runtime_wrappers() {
  local pnpm_bin node_bin
  pnpm_bin="$(command -v pnpm)"; node_bin="$(command -v node)"
  cat > "$RUNTIME_DIR/start-app.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
exec ${node_bin@Q} scripts/run-with-env.mjs ${ENV_FILE@Q} -- ${pnpm_bin@Q} start
EOF
  cat > "$RUNTIME_DIR/start-scheduler.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
exec ${node_bin@Q} scripts/run-with-env.mjs ${ENV_FILE@Q} -- ${node_bin@Q} scripts/run-minute-scheduler.mjs
EOF
  chmod 750 "$RUNTIME_DIR/start-app.sh" "$RUNTIME_DIR/start-scheduler.sh"
}

prepare_runtime_permissions() {
  local service_group install_owner
  service_group="$(id -gn "$SERVICE_USER")"
  install_owner="$(id -un)"
  # pnpm and Next resolve runtime files below the checkout. With this script's
  # restrictive umask those directories are not traversable by an unrelated
  # service identity until their group is set explicitly.
  run_root chown "$install_owner:$service_group" "$PROJECT_ROOT"
  run_root chmod g+rx "$PROJECT_ROOT"
  for runtime_path in node_modules .next scripts package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.js next.config.mjs next.config.ts; do
    [[ -e "$PROJECT_ROOT/$runtime_path" ]] || continue
    run_root chown -R "$install_owner:$service_group" "$PROJECT_ROOT/$runtime_path"
    run_root chmod -R g+rX "$PROJECT_ROOT/$runtime_path"
  done
  run_root chown "$install_owner:$service_group" "$ENV_FILE"
  run_root chmod 640 "$ENV_FILE"
  run_root chown -R "$install_owner:$service_group" "$RUNTIME_DIR" "$PROJECT_ROOT/.next"
  run_root chmod -R g+rX "$RUNTIME_DIR" "$PROJECT_ROOT/.next"
  # Next's production fetch/image cache is the only writable area beneath the
  # immutable build. Keep executable code read-only to the service identity.
  run_root install -d -m 0750 -o "$SERVICE_USER" -g "$service_group" "$PROJECT_ROOT/.next/cache"
  run_root chown -R "$SERVICE_USER:$service_group" "$PROJECT_ROOT/.next/cache"
  run_root chmod -R u+rwX,g+rX,o-rwx "$PROJECT_ROOT/.next/cache"
  run_root chown -R "$SERVICE_USER:$service_group" "$PROJECT_ROOT/logs" "$PROJECT_ROOT/data"
  run_as_service test -r "$PROJECT_ROOT/package.json" || fatal "Service user cannot read the checkout"
  run_as_service test -x "$RUNTIME_DIR/start-app.sh" || fatal "Service user cannot execute the app wrapper"
  run_as_service test -r "$ENV_FILE" || fatal "Service user cannot read the production environment"
  run_as_service test -w "$PROJECT_ROOT/.next/cache" || fatal "Service user cannot write the Next runtime cache"
  ok "Runtime artifacts are owned by the unprivileged service identity"
}

install_systemd_runtime() {
  section "systemd app and minute-scheduler services"
  command -v systemctl >/dev/null 2>&1 || fatal "systemd is unavailable"
  id "$SERVICE_USER" >/dev/null 2>&1 || fatal "Service user does not exist: $SERVICE_USER"
  local app_unit="/etc/systemd/system/$APP_NAME.service"
  local scheduler_unit="/etc/systemd/system/$APP_NAME-scheduler.service"

  run_root tee "$app_unit" >/dev/null <<EOF
[Unit]
Description=CTS-K-N production application and trade-engine owner
After=network-online.target redis-server.service redis.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_ROOT
ExecStart=$RUNTIME_DIR/start-app.sh
Restart=always
RestartSec=5
TimeoutStartSec=180
TimeoutStopSec=45
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

  run_root tee "$scheduler_unit" >/dev/null <<EOF
[Unit]
Description=CTS-K-N portable 60-second scheduler
After=network-online.target $APP_NAME.service
Requires=$APP_NAME.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_ROOT
ExecStart=$RUNTIME_DIR/start-scheduler.sh
Restart=always
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  run_root systemctl daemon-reload
  run_root systemctl enable "$APP_NAME" "$APP_NAME-scheduler"
  run_root systemctl restart "$APP_NAME"
  run_root systemctl restart "$APP_NAME-scheduler"
  ok "systemd services enabled for boot and restart-always continuity"
}

install_pm2_runtime() {
  section "PM2 app and minute-scheduler processes"
  command -v pm2 >/dev/null 2>&1 || run_root npm install -g pm2 --no-audit --no-fund --loglevel=error
  local home
  home="$(service_home)"
  run_root install -d -m 0750 -o "$SERVICE_USER" -g "$(id -gn "$SERVICE_USER")" "$home" "$home/.pm2"
  run_as_service pm2 delete "$APP_NAME" "$APP_NAME-scheduler" >/dev/null 2>&1 || true
  run_as_service pm2 start "$RUNTIME_DIR/start-app.sh" --name "$APP_NAME" --time --restart-delay 5000
  run_as_service pm2 start "$RUNTIME_DIR/start-scheduler.sh" --name "$APP_NAME-scheduler" --time --restart-delay 5000
  run_as_service pm2 save --force
  run_root env PATH="$PATH" PM2_HOME="$home/.pm2" pm2 startup -u "$SERVICE_USER" --hp "$home"
  ok "PM2 processes and init-system reboot startup are configured"
}

wait_for_health() {
  local attempts="${1:-60}" base_url="http://127.0.0.1:$APP_PORT"
  for ((attempt=1; attempt<=attempts; attempt++)); do
    if curl -fsS --max-time 5 "$base_url/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

site_instance_id() {
  node -e 'fetch(process.argv[1]).then(r=>r.json()).then(x=>process.stdout.write(String(x?.system?.site_instance_id||""))).catch(()=>process.exit(1))' \
    "http://127.0.0.1:$APP_PORT/api/system/init-status"
}

verify_and_restart() {
  section "Migrations, scheduler, persistence, and restart recovery"
  local base_url="http://127.0.0.1:$APP_PORT" before_id after_id
  wait_for_health 90 || return 1

  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env DEPLOYMENT_URL="$base_url" node "$PROJECT_ROOT/scripts/production-deploy-init.mjs"
  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env NODE_ENV=production SCHEDULER_BASE_URL="$base_url" \
    node "$PROJECT_ROOT/scripts/run-minute-scheduler.mjs" --once
  before_id="$(site_instance_id)"

  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env REQUIRE_SHARED_PERSISTENCE=1 REQUIRE_FRESH_CONTINUITY=1 DEPLOYMENT_URL="$base_url" \
    bash "$PROJECT_ROOT/scripts/post-deploy-verify.sh"

  start_runtime
  wait_for_health 90 || return 1
  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env NODE_ENV=production SCHEDULER_BASE_URL="$base_url" \
    node "$PROJECT_ROOT/scripts/run-minute-scheduler.mjs" --once
  after_id="$(site_instance_id)"
  [[ -n "$before_id" && "$before_id" == "$after_id" ]] || {
    warn "Durable site identity did not survive restart"
    return 1
  }
  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env REQUIRE_SHARED_PERSISTENCE=1 REQUIRE_FRESH_CONTINUITY=1 DEPLOYMENT_URL="$base_url" \
    bash "$PROJECT_ROOT/scripts/post-deploy-verify.sh"

  if [[ "$RUNTIME" == "systemd" ]]; then
    run_root systemctl is-active --quiet "$APP_NAME" && run_root systemctl is-active --quiet "$APP_NAME-scheduler" || return 1
  else
    run_as_service pm2 describe "$APP_NAME" >/dev/null && run_as_service pm2 describe "$APP_NAME-scheduler" >/dev/null || return 1
  fi
  return 0
}

rollback_after_failed_verification() {
  warn "Final verification failed"
  if [[ -n "$BUILD_BACKUP" && -d "$BUILD_BACKUP" ]]; then
    stop_runtime
    if [[ -d "$PROJECT_ROOT/.next" ]]; then
      mv "$PROJECT_ROOT/.next" "$RUNTIME_DIR/failed-next-$(date -u +%Y%m%dT%H%M%SZ)"
    fi
    mv "$BUILD_BACKUP" "$PROJECT_ROOT/.next"
    ROLLBACK_ARMED=0
    start_runtime || true
    fatal "Previous production build restored and restarted"
  fi
  fatal "Installation is not production-ready; inspect service logs"
}

installer_exit_handler() {
  local status=$?
  trap - EXIT
  if (( status != 0 && ROLLBACK_ARMED == 1 && ROLLBACK_RUNNING == 0 )) \
    && [[ -n "$BUILD_BACKUP" && -d "$BUILD_BACKUP" ]]; then
    ROLLBACK_RUNNING=1
    ROLLBACK_ARMED=0
    set +e
    warn "Deployment failed after the previous build was staged; restoring it"
    stop_runtime
    if [[ -d "$PROJECT_ROOT/.next" ]]; then
      mv "$PROJECT_ROOT/.next" "$RUNTIME_DIR/failed-next-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    fi
    mv "$BUILD_BACKUP" "$PROJECT_ROOT/.next"
    start_runtime
    warn "Previous production build restoration attempted"
  fi
  exit "$status"
}

trap installer_exit_handler EXIT

install_system_packages
ensure_service_user
ensure_node_and_pnpm
mkdir -p "$RUNTIME_DIR"
configure_environment_and_redis
resolve_runtime
install_dependencies_and_validate
write_runtime_wrappers
prepare_runtime_permissions

if [[ "$RUNTIME" == "systemd" ]]; then install_systemd_runtime; else install_pm2_runtime; fi
verify_and_restart || rollback_after_failed_verification
ROLLBACK_ARMED=0
if [[ -n "$BUILD_BACKUP" && -d "$BUILD_BACKUP" ]]; then
  rm -rf -- "$BUILD_BACKUP"
  BUILD_BACKUP=""
fi

section "Installation complete"
ok "CTS-K-N is ready at http://127.0.0.1:$APP_PORT"
ok "Schema, shared Redis, one-minute continuity, engine ownership, and restart persistence are verified"
info "App service: $APP_NAME"
info "Scheduler service: $APP_NAME-scheduler"
info "Environment: $ENV_FILE (owner/group-only; secrets were not printed)"
warn "Real exchange order placement remains disabled until the operator explicitly enables the hardened live gates."
