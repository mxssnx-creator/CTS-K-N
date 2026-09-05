#!/usr/bin/env bash
# Reconcile and verify the already-installed CTS-K-N production host so its
# application, persistence, dashboard, update agent, and private network
# services return after a reboot. This script never changes exchange/live
# settings and never prints the production environment.

set -Eeuo pipefail
umask 077

APP_NAME="${CTS_PROJECT_NAME:-cts-kn}"
APP_PORT="${CTS_PORT:-3002}"
PROJECT_ROOT="${CTS_INSTALL_DIR:-/opt/cts-kn}"
SERVICE_USER="${CTS_SERVICE_USER:-cts-kn}"
STATE_DIR="${CTS_STATE_DIR:-}"
ENV_FILE="${CTS_ENV_FILE:-}"
REPOSITORY="${CTS_REPOSITORY:-https://github.com/mxssnx-creator/CTS-K-N.git}"
BRANCH="${CTS_BRANCH:-main}"
BACKUP_ROOT="${CTS_AUTOBOOT_BACKUP_ROOT:-}"
VERIFY_ONLY=0
SKIP_SWAP=0
SKIP_PULL_AGENT=0
CLEAR_MAINTENANCE=0
BACKUP_DIR=""

info() { printf '[autoboot] %s\n' "$*"; }
warn() { printf '[autoboot] WARN: %s\n' "$*" >&2; }
fatal() { printf '[autoboot] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sudo bash scripts/ensure-server-autoboot.sh [options]

Reconcile an existing CTS-K-N systemd installation and verify that all
required services survive a reboot. Apply mode creates and verifies a
root-only backup before changing anything. It does not edit exchange/live
trading settings and does not submit orders.

Options:
  --dir PATH           Existing checkout (default: /opt/cts-kn)
  --name NAME          Installed service name (default: cts-kn)
  --port PORT          Installed HTTP port (default: 3002)
  --service-user USER  Installed runtime user (default: cts-kn)
  --state-dir PATH     Durable instance state (default: /var/lib/cts/instances/<name>)
  --env-file PATH      External production environment
  --repository URL     Expected Git origin
  --branch NAME        Pull-agent branch (default: main)
  --backup-root PATH   Root-only backup parent
  --verify-only        Make no changes; only verify the complete contract
  --clear-maintenance  Back up and remove the exact CTS maintenance marker
                       before starting services
  --skip-swap          Do not create or verify the exact 18 GiB swap file
  --skip-pull-agent    Do not install or verify the Git pull timer
  --help               Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) PROJECT_ROOT="${2:?--dir requires a value}"; shift 2 ;;
    --name) APP_NAME="${2:?--name requires a value}"; shift 2 ;;
    --port) APP_PORT="${2:?--port requires a value}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:?--service-user requires a value}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:?--state-dir requires a value}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file requires a value}"; shift 2 ;;
    --repository) REPOSITORY="${2:?--repository requires a value}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch requires a value}"; shift 2 ;;
    --backup-root) BACKUP_ROOT="${2:?--backup-root requires a value}"; shift 2 ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --clear-maintenance) CLEAR_MAINTENANCE=1; shift ;;
    --skip-swap) SKIP_SWAP=1; shift ;;
    --skip-pull-agent) SKIP_PULL_AGENT=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fatal "Unknown option: $1" ;;
  esac
done

[[ -n "$STATE_DIR" ]] || STATE_DIR="/var/lib/cts/instances/$APP_NAME"
[[ -n "$ENV_FILE" ]] || ENV_FILE="$STATE_DIR/.env.production.local"
[[ -n "$BACKUP_ROOT" ]] || BACKUP_ROOT="/var/backups/cts/$APP_NAME"

valid_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; }
valid_user() { [[ "$1" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
valid_absolute_path() {
  [[ "$1" =~ ^/[a-zA-Z0-9._/-]+$ && "$1" != "/" && "$1" != *"//"* \
    && "$1" != *"/./"* && "$1" != */. && "$1" != *"/../"* && "$1" != */.. ]]
}
valid_branch() { [[ "$1" =~ ^[A-Za-z0-9._/-]+$ && "$1" != *".."* && "$1" != *"//"* ]]; }
valid_repository() { [[ -n "$1" && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *[[:space:]]* ]]; }

valid_name "$APP_NAME" || fatal "Invalid app name"
valid_user "$SERVICE_USER" || fatal "Invalid service user"
valid_port "$APP_PORT" || fatal "Invalid app port"
valid_absolute_path "$PROJECT_ROOT" && [[ "$PROJECT_ROOT" == /opt/* ]] \
  || fatal "Project directory must be a safe path under /opt"
valid_absolute_path "$STATE_DIR" && [[ "$STATE_DIR" == /var/lib/* ]] \
  || fatal "State directory must be a safe path under /var/lib"
valid_absolute_path "$ENV_FILE" \
  && { [[ "$ENV_FILE" == "$STATE_DIR"/* ]] || [[ "$ENV_FILE" == /etc/* ]] || [[ "$ENV_FILE" == /var/lib/* ]]; } \
  || fatal "Environment file must be inside durable state, /var/lib, or /etc"
valid_absolute_path "$BACKUP_ROOT" && [[ "$BACKUP_ROOT" == /var/backups/* ]] \
  || fatal "Backup root must be a safe path below /var/backups"
valid_repository "$REPOSITORY" || fatal "Invalid repository URL"
valid_branch "$BRANCH" || fatal "Invalid branch"

(( EUID == 0 )) || fatal "Run as root (for example with sudo)"

for command_name in \
  systemctl install stat git node curl sha256sum find sort xargs sed cp chmod \
  date mktemp awk grep swapon timeout sleep id runuser rm; do
  command -v "$command_name" >/dev/null 2>&1 || fatal "Required command is missing: $command_name"
done

[[ -d "$PROJECT_ROOT/.git" ]] || fatal "Missing Git checkout: $PROJECT_ROOT"
[[ -f "$PROJECT_ROOT/package.json" ]] || fatal "Incomplete CTS-K-N checkout"
[[ -f "$PROJECT_ROOT/scripts/install-pull-agent.sh" ]] || fatal "Pull-agent installer is missing"
[[ -f "$PROJECT_ROOT/scripts/run-with-env.mjs" ]] || fatal "Environment runner is missing"
[[ -f "$PROJECT_ROOT/scripts/verify-redis-endpoint.mjs" ]] || fatal "Redis verifier is missing"
MAINTENANCE_MARKER="$PROJECT_ROOT/.cts-runtime/maintenance-stop"
if [[ ( -e "$MAINTENANCE_MARKER" || -L "$MAINTENANCE_MARKER" ) && "$VERIFY_ONLY" -eq 1 ]]; then
  fatal "CTS maintenance marker is present; reboot-persistence verification must remain fail-closed"
fi
if [[ ( -e "$MAINTENANCE_MARKER" || -L "$MAINTENANCE_MARKER" ) && "$CLEAR_MAINTENANCE" -eq 0 ]]; then
  fatal "CTS maintenance marker is present; rerun with --clear-maintenance only after explicit start authorization"
fi
[[ -f "$ENV_FILE" ]] || fatal "Production environment is missing: $ENV_FILE"
[[ -r "$ENV_FILE" ]] || fatal "Production environment is not readable by root"
env_mode="$(stat -c '%a' "$ENV_FILE")"
[[ "$env_mode" =~ ^[0-7]{3,4}$ ]] || fatal "Cannot determine production environment permissions"
env_mode_bits=$((8#$env_mode & 0777))
(( env_mode_bits == 0600 || env_mode_bits == 0640 )) \
  || fatal "Production environment may be owner-only or service-group-readable, never group-writable/world-accessible"
id "$SERVICE_USER" >/dev/null 2>&1 || fatal "Service user does not exist: $SERVICE_USER"
id www-data >/dev/null 2>&1 || fatal "Dashboard service user does not exist: www-data"
runuser -u "$SERVICE_USER" -- test -r "$ENV_FILE" \
  || fatal "Production environment is not readable by the configured service user"

git_project() {
  git -c "safe.directory=$PROJECT_ROOT" -C "$PROJECT_ROOT" "$@"
}

current_origin="$(git_project remote get-url origin 2>/dev/null || true)"
[[ "$current_origin" == "$REPOSITORY" ]] || fatal "Checkout origin does not match the configured repository"

unit_load_state() {
  systemctl show --property=LoadState --value "$1" 2>/dev/null || true
}

unit_exists() {
  local state
  state="$(unit_load_state "$1")"
  [[ -n "$state" && "$state" != "not-found" ]]
}

require_unit() {
  unit_exists "$1" || fatal "Required systemd unit is missing: $1"
}

APP_UNITS=(
  "$APP_NAME.service"
  "$APP_NAME-scheduler.service"
  "$APP_NAME-direct-trade.service"
  "$APP_NAME-recovery.timer"
)
NETWORK_UNITS=(
  "chisel-server.service"
  "netbird.service"
  "tailscaled.service"
)

for unit in "${APP_UNITS[@]}" "${NETWORK_UNITS[@]}"; do
  require_unit "$unit"
done

command -v nginx >/dev/null 2>&1 || fatal "nginx is required for the public dashboard"
require_unit nginx.service
nginx -t >/dev/null 2>&1 || fatal "Existing nginx configuration is invalid; no changes made"

for dashboard_source in \
  "$PROJECT_ROOT/ops/server-access-dashboard/server/access-dashboard.mjs" \
  "$PROJECT_ROOT/ops/server-access-dashboard/public/index.html" \
  "$PROJECT_ROOT/ops/server-access-dashboard/public/dashboard.js" \
  "$PROJECT_ROOT/ops/server-access-dashboard/deploy/projects.json" \
  "$PROJECT_ROOT/ops/server-access-dashboard/deploy/server-access-dashboard.service"; do
  [[ -f "$dashboard_source" ]] || fatal "Dashboard source is missing: $dashboard_source"
done

if (( SKIP_SWAP == 0 )); then
  [[ -f "$PROJECT_ROOT/ops/server-access-dashboard/deploy/ensure-swap-18g.sh" ]] \
    || fatal "18 GiB swap installer is missing"
fi

REDIS_UNIT=""
for candidate in "$APP_NAME-redis.service" redis-server.service redis.service; do
  if unit_exists "$candidate"; then REDIS_UNIT="$candidate"; break; fi
done
if [[ -z "$REDIS_UNIT" ]]; then
  warn "No local Redis unit is loaded; the exact configured Redis endpoint will still be verified"
fi

backup_one() {
  local source_path="$1" destination
  [[ -e "$source_path" || -L "$source_path" ]] || return 0
  destination="$BACKUP_DIR/files/${source_path#/}"
  install -d -m 0700 -- "$(dirname "$destination")"
  cp -a -- "$source_path" "$destination"
}

create_backup() {
  local timestamp status_file unit
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 -- "$BACKUP_ROOT"
  BACKUP_DIR="$BACKUP_ROOT/${timestamp}-pre-autoboot"
  [[ ! -e "$BACKUP_DIR" ]] || fatal "Backup path already exists: $BACKUP_DIR"
  install -d -m 0700 -- "$BACKUP_DIR"

  backup_one /etc/fstab
  backup_one /etc/sysctl.d/99-cts-kn-memory.conf
  backup_one "$PROJECT_ROOT/.cts-runtime/install-values.env"
  backup_one "$ENV_FILE"
  backup_one "$MAINTENANCE_MARKER"
  backup_one /opt/server-access
  backup_one /etc/server-access-dashboard
  backup_one /etc/systemd/system/server-access-dashboard.service
  backup_one "/etc/systemd/system/$APP_NAME-pull-agent.service"
  backup_one "/etc/systemd/system/$APP_NAME-pull-agent.timer"
  backup_one "/etc/$APP_NAME/pull-agent.env"
  backup_one "/usr/local/sbin/$APP_NAME-pull-agent"
  for unit in "${APP_UNITS[@]}" "${NETWORK_UNITS[@]}" nginx.service; do
    backup_one "/etc/systemd/system/$unit"
  done
  [[ -z "$REDIS_UNIT" ]] || backup_one "/etc/systemd/system/$REDIS_UNIT"

  git_project bundle create "$BACKUP_DIR/repository.bundle" --all
  git_project bundle verify "$BACKUP_DIR/repository.bundle" >/dev/null 2>&1 \
    || fatal "Repository backup bundle verification failed"
  git_project status --porcelain=v1 > "$BACKUP_DIR/git-status.txt"
  git_project diff --binary > "$BACKUP_DIR/worktree.patch"
  git_project diff --binary --cached > "$BACKUP_DIR/index.patch"
  git_project ls-files --others --exclude-standard > "$BACKUP_DIR/untracked-files.txt"

  status_file="$BACKUP_DIR/systemd-state.txt"
  : > "$status_file"
  for unit in "${APP_UNITS[@]}" "${NETWORK_UNITS[@]}" nginx.service \
    server-access-dashboard.service "$APP_NAME-pull-agent.timer"; do
    printf '%s load=%s enabled=%s active=%s\n' \
      "$unit" \
      "$(unit_load_state "$unit")" \
      "$(systemctl is-enabled "$unit" 2>/dev/null || true)" \
      "$(systemctl is-active "$unit" 2>/dev/null || true)" >> "$status_file"
  done

  (
    cd "$BACKUP_DIR"
    find . -type f ! -name SHA256SUMS -print0 \
      | sort -z \
      | xargs -0 -r sha256sum > SHA256SUMS
    sha256sum -c SHA256SUMS >/dev/null
  ) || fatal "Backup checksum verification failed"
  chmod -R go-rwx -- "$BACKUP_DIR"
  info "Verified pre-change backup: $BACKUP_DIR"
}

install_dashboard() {
  local rendered_unit
  install -d -m 0755 /opt/server-access/server /opt/server-access/public /etc/server-access-dashboard
  install -m 0644 \
    "$PROJECT_ROOT/ops/server-access-dashboard/server/access-dashboard.mjs" \
    /opt/server-access/server/access-dashboard.mjs
  install -m 0644 \
    "$PROJECT_ROOT/ops/server-access-dashboard/public/index.html" \
    /opt/server-access/public/index.html
  install -m 0644 \
    "$PROJECT_ROOT/ops/server-access-dashboard/public/dashboard.js" \
    /opt/server-access/public/dashboard.js
  install -m 0644 \
    "$PROJECT_ROOT/ops/server-access-dashboard/deploy/projects.json" \
    /etc/server-access-dashboard/projects.json

  rendered_unit="$(mktemp)"
  if ! sed "s/After=network-online.target cts-kn.service/After=network-online.target $APP_NAME.service/" \
    "$PROJECT_ROOT/ops/server-access-dashboard/deploy/server-access-dashboard.service" \
    > "$rendered_unit"; then
    rm -f -- "$rendered_unit"
    fatal "Could not render the dashboard systemd unit"
  fi
  if ! install -m 0644 "$rendered_unit" /etc/systemd/system/server-access-dashboard.service; then
    rm -f -- "$rendered_unit"
    fatal "Could not install the dashboard systemd unit"
  fi
  rm -f -- "$rendered_unit"
}

enable_unit() {
  local unit="$1"
  systemctl reset-failed "$unit" 2>/dev/null || true
  systemctl enable --now "$unit"
}

verify_unit() {
  local unit="$1"
  unit_exists "$unit" || fatal "Unit disappeared during verification: $unit"
  systemctl is-enabled --quiet "$unit" || fatal "Unit is not enabled for reboot: $unit"
  systemctl is-active --quiet "$unit" || fatal "Unit is not active: $unit"
  info "$unit: enabled and active"
}

wait_for_http() {
  local label="$1" url="$2" attempt
  for attempt in {1..20}; do
    if curl --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1; then
      info "$label health: ready"
      return 0
    fi
    sleep 1
  done
  fatal "$label health endpoint did not become ready: $url"
}

verify_swap() {
  local swap_file=/swapfile-cts-kn expected_bytes=$((18 * 1024 * 1024 * 1024))
  [[ -f "$swap_file" ]] || fatal "Expected swap file is missing: $swap_file"
  [[ "$(stat -c '%s' "$swap_file")" -eq "$expected_bytes" ]] \
    || fatal "Swap file is not exactly 18 GiB"
  swapon --noheadings --show=NAME | awk '{print $1}' | grep -Fxq "$swap_file" \
    || fatal "18 GiB swap file is not active"
  grep -Fqx "$swap_file none swap sw 0 0" /etc/fstab \
    || fatal "18 GiB swap file is not persistent in /etc/fstab"
  info "swap: exactly 18 GiB, active, and persistent"
}

verify_network_state() {
  if command -v tailscale >/dev/null 2>&1; then
    timeout 10s tailscale status --json 2>/dev/null \
      | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"' \
      || fatal "tailscaled is active but the node is not connected"
    info "Tailscale: connected"
  else
    fatal "tailscale CLI is missing"
  fi

  if command -v netbird >/dev/null 2>&1; then
    timeout 10s netbird status >/dev/null 2>&1 \
      || fatal "netbird is active but the peer is not connected"
    info "NetBird: connected"
  else
    fatal "netbird CLI is missing"
  fi
}

verify_all() {
  local unit
  for unit in "${NETWORK_UNITS[@]}"; do verify_unit "$unit"; done
  [[ -z "$REDIS_UNIT" ]] || verify_unit "$REDIS_UNIT"
  for unit in "${APP_UNITS[@]}"; do verify_unit "$unit"; done
  verify_unit server-access-dashboard.service
  verify_unit nginx.service
  if (( SKIP_PULL_AGENT == 0 )); then verify_unit "$APP_NAME-pull-agent.timer"; fi
  if (( SKIP_SWAP == 0 )); then verify_swap; fi

  timeout 20s node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    node "$PROJECT_ROOT/scripts/verify-redis-endpoint.mjs" >/dev/null 2>&1 \
    || fatal "Configured Redis endpoint verification failed"
  info "Redis: configured endpoint passed PING verification"
  wait_for_http "CTS-K-N" "http://127.0.0.1:$APP_PORT/api/health"
  wait_for_http "server dashboard" "http://127.0.0.1:3004/api/health"
  verify_network_state
  nginx -t >/dev/null 2>&1 || fatal "nginx verification failed"
  info "nginx: configuration valid"
}

if (( VERIFY_ONLY == 1 )); then
  verify_all
  info "Complete reboot-persistence contract verified without changes"
  exit 0
fi

create_backup

if (( CLEAR_MAINTENANCE == 1 )) && [[ -e "$MAINTENANCE_MARKER" || -L "$MAINTENANCE_MARKER" ]]; then
  rm -f -- "$MAINTENANCE_MARKER"
  info "Backed up and cleared the explicit CTS maintenance marker"
fi

if (( SKIP_SWAP == 0 )); then
  bash "$PROJECT_ROOT/ops/server-access-dashboard/deploy/ensure-swap-18g.sh"
fi

install_dashboard
if (( SKIP_PULL_AGENT == 0 )); then
  bash "$PROJECT_ROOT/scripts/install-pull-agent.sh" \
    --dir "$PROJECT_ROOT" \
    --name "$APP_NAME" \
    --port "$APP_PORT" \
    --service-user "$SERVICE_USER" \
    --env-file "$ENV_FILE" \
    --repository "$REPOSITORY" \
    --branch "$BRANCH" \
    --interval 15min \
    --on-boot 3min
fi

systemctl daemon-reload
for unit in "${NETWORK_UNITS[@]}"; do enable_unit "$unit"; done
[[ -z "$REDIS_UNIT" ]] || enable_unit "$REDIS_UNIT"
for unit in "${APP_UNITS[@]}"; do enable_unit "$unit"; done
enable_unit server-access-dashboard.service
enable_unit nginx.service
if (( SKIP_PULL_AGENT == 0 )); then enable_unit "$APP_NAME-pull-agent.timer"; fi

verify_all
info "Auto-boot reconciliation complete; rollback material: $BACKUP_DIR"
