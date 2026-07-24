#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/.."
INSTALL_DIR="${CTS_INSTALL_DIR:-/opt/cts-k-n}"
APP_NAME="ctsv0.1.1"

log_info() { echo "[update] $*"; }
log_ok() { echo "[update] OK: $*"; }
log_fatal() { echo "[update] FATAL: $*" >&2; exit 1; }

as_root() {
  if [[ "$(id -u)" == "0" ]]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else log_fatal "sudo/root is required for this operation"; fi
}

run_as_service() {
  [[ -n "${SERVICE_USER:-}" ]] || return 0
  local home
  home="$(awk -F: -v user="$SERVICE_USER" '$1 == user { print $6; exit }' /etc/passwd 2>/dev/null || true)"
  [[ -n "$home" && "$home" != "/" ]] || home="/var/lib/$APP_NAME"
  if [[ "$(id -un)" == "$SERVICE_USER" ]]; then
    env HOME="$home" PM2_HOME="$home/.pm2" "$@"
  else
    as_root -u "$SERVICE_USER" env HOME="$home" PM2_HOME="$home/.pm2" "$@"
  fi
}

resolve_runtime_paths() {
  RUNTIME_DIR="$PROJECT_ROOT/.cts-runtime"
  ENV_FILE="$PROJECT_ROOT/.env.production.local"
}

read_saved_values() {
  resolve_runtime_paths
  [[ -r "$RUNTIME_DIR/install-values.env" ]] || return 0
  local key value
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    case "$key" in
      CTS_INSTALLED_SERVICE_USER) SERVICE_USER="$value" ;;
    esac
  done < "$RUNTIME_DIR/install-values.env"
}

read_install_dir_from_name() {
  command -v systemctl >/dev/null 2>&1 || return 0
  [[ -z "${CTS_PROJECT_NAME:-}" ]] && return 0
  local working_dir
  working_dir="$(systemctl show --property=WorkingDirectory --value "$CTS_PROJECT_NAME" 2>/dev/null || true)"
  if [[ "$working_dir" == /* && "$working_dir" != "/" && -d "$working_dir" ]]; then
    INSTALL_DIR="$working_dir"
  fi
}

ensure_active_dir() {
  if [[ "$INSTALL_DIR" == /* && -d "$INSTALL_DIR" ]]; then
    PROJECT_ROOT="$INSTALL_DIR"
    return
  fi
  read_install_dir_from_name
  if [[ "$PROJECT_ROOT" == /* && -d "$PROJECT_ROOT" ]]; then
    INSTALL_DIR="$PROJECT_ROOT"
    return
  fi
  log_fatal "Cannot determine install dir. Set CTS_INSTALL_DIR=/opt/cts-k-n"
}

stop_services() {
  resolve_runtime_paths
  log_info "Stopping services..."
  if [[ -x "$PROJECT_ROOT/scripts/service-control.sh" ]]; then
    as_root bash "$PROJECT_ROOT/scripts/service-control.sh" stop || true
  elif command -v systemctl >/dev/null 2>&1; then
    as_root systemctl stop "$APP_NAME-scheduler" "$APP_NAME" "$APP_NAME-redis" 2>/dev/null || true
  elif command -v pm2 >/dev/null 2>&1; then
    run_as_service pm2 stop "$APP_NAME-scheduler" "$APP_NAME" "$APP_NAME-redis" >/dev/null 2>&1 || true
  fi
  log_ok "Services stopped"
}

pull_latest() {
  log_info "Pulling latest from GitHub..."
  cd "$PROJECT_ROOT"
  as_root git fetch --prune origin
  as_root git reset --hard origin/main
  as_root git clean -fdx
  log_ok "Code updated"
}

install_dependencies() {
  log_info "Installing dependencies..."
  cd "$PROJECT_ROOT"
  if command -v pnpm >/dev/null 2>&1; then
    as_root pnpm install --frozen-lockfile
  else
    as_root npm install
  fi
  log_ok "Dependencies installed"
}

build_production() {
  log_info "Building production bundle..."
  cd "$PROJECT_ROOT"
  # Turbopack in Next 15.3+ expects server-external-packages.jsonc but pnpm
  # hoisting only provides server-external-packages.json. Ensure the .jsonc file
  # exists to avoid build failures.
  node scripts/prepare-turbopack.mjs 2>/dev/null || true
  NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-prod}" as_root node node_modules/next/dist/bin/next build
  log_ok "Production build complete"
}

restart_services() {
  resolve_runtime_paths
  log_info "Restarting services..."
  if [[ -x "$PROJECT_ROOT/scripts/service-control.sh" ]]; then
    as_root bash "$PROJECT_ROOT/scripts/service-control.sh" restart
  elif command -v systemctl >/dev/null 2>&1; then
    as_root systemctl restart "$APP_NAME-redis" 2>/dev/null || true
    as_root systemctl restart "$APP_NAME" "$APP_NAME-scheduler"
  elif command -v pm2 >/dev/null 2>&1; then
    run_as_service pm2 restart "$APP_NAME-redis" --update-env 2>/dev/null || true
    run_as_service pm2 restart "$APP_NAME" "$APP_NAME-scheduler" --update-env
  fi
  log_ok "Services restarted"
}

verify_running() {
  log_info "Verifying deployment..."
  sleep 5
  local port="${CTS_PORT:-3002}"
  local url="http://127.0.0.1:$port/api/health"
  if curl -sf "$url" >/dev/null 2>&1; then
    log_ok "Health check passed on port $port"
  else
    log_fatal "Health check failed on port $port"
  fi
}

main() {
  ensure_active_dir
  read_saved_values
  [[ -n "${SERVICE_USER:-}" ]] || SERVICE_USER="cts-kn"
  stop_services
  pull_latest
  install_dependencies
  build_production
  restart_services
  verify_running
  log_ok "Update complete"
}

main "$@"