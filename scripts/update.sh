#!/usr/bin/env bash
# Update one existing CTS-K-N installation through the canonical clean server
# lifecycle: stop services, remove the exact target directory, clone again,
# restore persistent CTS state, and run the full installer.

set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="${CTS_INSTALL_DIR:-}"
APP_NAME="${CTS_PROJECT_NAME:-}"
APP_PORT="${CTS_PORT:-}"
RUNTIME="${CTS_RUNTIME:-}"
SERVICE_USER="${CTS_SERVICE_USER:-}"
ENV_FILE="${CTS_ENV_FILE:-}"
REPOSITORY="${CTS_REPOSITORY:-}"
BRANCH="${CTS_BRANCH:-}"
INSTALL_SEARCH_ROOT="${CTS_INSTALL_SEARCH_ROOT:-/opt}"
DIR_SET=0
NAME_SET=0
PORT_SET=0
RUNTIME_SET=0
SERVICE_USER_SET=0
ENV_FILE_SET=0
REPOSITORY_SET=0
BRANCH_SET=0
REINSTALL=0
RESOLVE_ONLY=0

[[ -n "${CTS_INSTALL_DIR:-}" ]] && DIR_SET=1
[[ -n "${CTS_PROJECT_NAME:-}" ]] && NAME_SET=1
[[ -n "${CTS_PORT:-}" ]] && PORT_SET=1
[[ -n "${CTS_RUNTIME:-}" ]] && RUNTIME_SET=1
[[ -n "${CTS_SERVICE_USER:-}" ]] && SERVICE_USER_SET=1
[[ -n "${CTS_ENV_FILE:-}" ]] && ENV_FILE_SET=1
[[ -n "${CTS_REPOSITORY:-}" ]] && REPOSITORY_SET=1
[[ -n "${CTS_BRANCH:-}" ]] && BRANCH_SET=1

usage() {
  cat <<'EOF'
Usage: scripts/update.sh [options]

  --dir PATH           Exact existing checkout
  --name NAME          Existing service name
  --port PORT          New or existing application port
  --runtime MODE       Existing runtime: systemd or pm2
  --service-user USER  Existing runtime user
  --env-file PATH      Existing production environment file
  --repository URL     Expected Git origin
  --branch NAME        Branch to clone from (default: saved branch/main)
  --reinstall          Reinstall host runtimes and project dependencies
  --resolve-only       Print the resolved update target without changing it

The saved .cts-runtime/install-values.env identity is authoritative. Every
update delegates to bootstrap-install.sh and performs a complete clean install.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) PROJECT_ROOT="${2:?--dir requires a value}"; DIR_SET=1; shift 2 ;;
    --name) APP_NAME="${2:?--name requires a value}"; NAME_SET=1; shift 2 ;;
    --port) APP_PORT="${2:?--port requires a value}"; PORT_SET=1; shift 2 ;;
    --runtime) RUNTIME="${2:?--runtime requires a value}"; RUNTIME_SET=1; shift 2 ;;
    --service-user) SERVICE_USER="${2:?--service-user requires a value}"; SERVICE_USER_SET=1; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file requires a value}"; ENV_FILE_SET=1; shift 2 ;;
    --repository) REPOSITORY="${2:?--repository requires a value}"; REPOSITORY_SET=1; shift 2 ;;
    --branch) BRANCH="${2:?--branch requires a value}"; BRANCH_SET=1; shift 2 ;;
    --reinstall) REINSTALL=1; shift ;;
    --resolve-only) RESOLVE_ONLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown update option: $1" >&2; exit 2 ;;
  esac
done

log_info() { echo "[update] $*"; }
log_fatal() { echo "[update] FATAL: $*" >&2; exit 1; }
valid_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; }
valid_user() { [[ "$1" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
valid_absolute_path() {
  [[ "$1" =~ ^/[a-zA-Z0-9._/-]+$ && "$1" != "/" && "$1" != *"//"* \
    && "$1" != *"/./"* && "$1" != */. && "$1" != *"/../"* && "$1" != */.. ]]
}

discover_from_name() {
  (( DIR_SET == 0 )) || return 0
  [[ -n "$APP_NAME" ]] || return 0
  command -v systemctl >/dev/null 2>&1 || return 0
  local working_dir
  working_dir="$(systemctl show --property=WorkingDirectory --value "$APP_NAME" 2>/dev/null || true)"
  if [[ "$working_dir" == /* && "$working_dir" != "/" ]]; then PROJECT_ROOT="$working_dir"; fi
}

discover_single_saved_install() {
  [[ -z "$PROJECT_ROOT" ]] || return 0
  local -a candidates=()
  local values
  shopt -s nullglob
  for values in "$INSTALL_SEARCH_ROOT"/*/.cts-runtime/install-values.env; do
    [[ -r "$values" ]] && candidates+=("${values%/.cts-runtime/install-values.env}")
  done
  shopt -u nullglob
  if (( ${#candidates[@]} == 1 )); then
    PROJECT_ROOT="${candidates[0]}"
  elif (( ${#candidates[@]} > 1 )); then
    printf '[update] FATAL: Multiple CTS-K-N installs found; specify --dir or --name:\n' >&2
    printf '  %s\n' "${candidates[@]}" >&2
    exit 2
  fi
}

discover_saved_install_from_name() {
  [[ -z "$PROJECT_ROOT" && -n "$APP_NAME" ]] || return 0
  local -a candidates=()
  local values
  shopt -s nullglob
  for values in "$INSTALL_SEARCH_ROOT"/*/.cts-runtime/install-values.env; do
    [[ -r "$values" ]] || continue
    if grep -Fqx "CTS_INSTALLED_APP_NAME=$APP_NAME" "$values"; then
      candidates+=("${values%/.cts-runtime/install-values.env}")
    fi
  done
  shopt -u nullglob
  if (( ${#candidates[@]} == 1 )); then
    PROJECT_ROOT="${candidates[0]}"
  elif (( ${#candidates[@]} > 1 )); then
    printf "[update] FATAL: Multiple CTS-K-N installs named '%s' found under %s; specify --dir:\n" \
      "$APP_NAME" "$INSTALL_SEARCH_ROOT" >&2
    printf '  %s\n' "${candidates[@]}" >&2
    exit 2
  fi
}

valid_absolute_path "$INSTALL_SEARCH_ROOT" \
  || log_fatal "CTS_INSTALL_SEARCH_ROOT must be a safe absolute non-root path"
discover_from_name
if [[ -z "$PROJECT_ROOT" && -r "$SOURCE_ROOT/.cts-runtime/install-values.env" ]]; then
  PROJECT_ROOT="$SOURCE_ROOT"
fi
discover_saved_install_from_name
if [[ -z "$PROJECT_ROOT" && -n "$APP_NAME" && -d "$INSTALL_SEARCH_ROOT/$APP_NAME" ]]; then
  PROJECT_ROOT="$INSTALL_SEARCH_ROOT/$APP_NAME"
fi
discover_single_saved_install
[[ -n "$PROJECT_ROOT" ]] || log_fatal "No installed checkout found; use --dir or bootstrap-install.sh"
valid_absolute_path "$PROJECT_ROOT" || log_fatal "Install directory must be a safe absolute non-root path"
[[ -f "$PROJECT_ROOT/package.json" && -f "$PROJECT_ROOT/scripts/install.sh" && -d "$PROJECT_ROOT/.git" ]] \
  || log_fatal "Not a complete CTS-K-N Git checkout: $PROJECT_ROOT"

RUNTIME_DIR="$PROJECT_ROOT/.cts-runtime"
VALUES_FILE="$RUNTIME_DIR/install-values.env"
[[ -r "$VALUES_FILE" ]] || log_fatal "Missing authoritative install metadata: $VALUES_FILE"

SAVED_APP_NAME=""
SAVED_APP_PORT=""
SAVED_RUNTIME=""
SAVED_SERVICE_USER=""
SAVED_PROJECT_ROOT=""
SAVED_ENV_FILE=""
SAVED_ENV_MANAGED=""
SAVED_REPOSITORY=""
SAVED_BRANCH=""

while IFS='=' read -r key value || [[ -n "$key" ]]; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  case "$key" in
    CTS_INSTALLED_APP_NAME) valid_name "$value" && SAVED_APP_NAME="$value" ;;
    CTS_INSTALLED_APP_PORT) valid_port "$value" && SAVED_APP_PORT="$value" ;;
    CTS_INSTALLED_RUNTIME) [[ "$value" =~ ^(systemd|pm2)$ ]] && SAVED_RUNTIME="$value" ;;
    CTS_INSTALLED_SERVICE_USER) valid_user "$value" && SAVED_SERVICE_USER="$value" ;;
    CTS_INSTALLED_PROJECT_ROOT) SAVED_PROJECT_ROOT="$value" ;;
    CTS_INSTALLED_ENV_FILE) [[ "$value" == /* && "$value" != "/" ]] && SAVED_ENV_FILE="$value" ;;
    CTS_INSTALLED_ENV_MANAGED) [[ "$value" =~ ^[01]$ ]] && SAVED_ENV_MANAGED="$value" ;;
    CTS_INSTALLED_REPOSITORY) SAVED_REPOSITORY="$value" ;;
    CTS_INSTALLED_BRANCH) SAVED_BRANCH="$value" ;;
  esac
done < "$VALUES_FILE"

[[ -z "$SAVED_PROJECT_ROOT" || "$SAVED_PROJECT_ROOT" == "$PROJECT_ROOT" ]] \
  || log_fatal "Saved root '$SAVED_PROJECT_ROOT' does not match '$PROJECT_ROOT'"
if (( NAME_SET == 1 )) && [[ -n "$SAVED_APP_NAME" && "$APP_NAME" != "$SAVED_APP_NAME" ]]; then
  log_fatal "Update cannot rename '$SAVED_APP_NAME' to '$APP_NAME'; use bootstrap-install.sh"
fi
if (( RUNTIME_SET == 1 )) && [[ -n "$SAVED_RUNTIME" && "$RUNTIME" != "$SAVED_RUNTIME" ]]; then
  log_fatal "Update cannot change runtime '$SAVED_RUNTIME' to '$RUNTIME'; use bootstrap-install.sh"
fi
if (( SERVICE_USER_SET == 1 )) && [[ -n "$SAVED_SERVICE_USER" && "$SERVICE_USER" != "$SAVED_SERVICE_USER" ]]; then
  log_fatal "Update cannot change service user '$SAVED_SERVICE_USER' to '$SERVICE_USER'; use bootstrap-install.sh"
fi
if (( ENV_FILE_SET == 1 )) && [[ -n "$SAVED_ENV_FILE" && "$ENV_FILE" != "$SAVED_ENV_FILE" ]]; then
  log_fatal "Update cannot relocate the environment file; use bootstrap-install.sh"
fi

[[ -n "$APP_NAME" ]] || APP_NAME="${SAVED_APP_NAME:-cts-kn}"
[[ -n "$APP_PORT" ]] || APP_PORT="${SAVED_APP_PORT:-3002}"
[[ -n "$RUNTIME" ]] || RUNTIME="${SAVED_RUNTIME:-systemd}"
[[ -n "$SERVICE_USER" ]] || SERVICE_USER="${SAVED_SERVICE_USER:-cts-kn}"
[[ -n "$ENV_FILE" ]] || ENV_FILE="${SAVED_ENV_FILE:-$PROJECT_ROOT/.env.production.local}"
[[ -n "$REPOSITORY" ]] || REPOSITORY="${SAVED_REPOSITORY:-$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)}"
[[ -n "$BRANCH" ]] || BRANCH="${SAVED_BRANCH:-$(git -C "$PROJECT_ROOT" symbolic-ref --short HEAD 2>/dev/null || true)}"
[[ -n "$BRANCH" ]] || BRANCH="main"

valid_name "$APP_NAME" || log_fatal "Invalid installed app name"
valid_port "$APP_PORT" || log_fatal "Invalid installed port"
valid_user "$SERVICE_USER" || log_fatal "Invalid installed service user"
[[ "$RUNTIME" =~ ^(systemd|pm2)$ ]] || log_fatal "Invalid installed runtime"
valid_absolute_path "$ENV_FILE" || log_fatal "Invalid installed environment file"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ && "$BRANCH" != *".."* && "$BRANCH" != *"//"* ]] || log_fatal "Invalid branch"
[[ -n "$REPOSITORY" && "$REPOSITORY" != *$'\n'* && "$REPOSITORY" != *[[:space:]]* ]] || log_fatal "Invalid repository URL"

CURRENT_REPOSITORY="$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)"
[[ "$CURRENT_REPOSITORY" == "$REPOSITORY" ]] \
  || log_fatal "Origin '$CURRENT_REPOSITORY' does not match expected repository '$REPOSITORY'; use bootstrap-install.sh"

if (( RESOLVE_ONLY == 1 )); then
  printf 'CTS_INSTALL_DIR=%s\n' "$PROJECT_ROOT"
  printf 'CTS_PROJECT_NAME=%s\n' "$APP_NAME"
  printf 'CTS_PORT=%s\n' "$APP_PORT"
  printf 'CTS_RUNTIME=%s\n' "$RUNTIME"
  printf 'CTS_SERVICE_USER=%s\n' "$SERVICE_USER"
  printf 'CTS_ENV_FILE=%s\n' "$ENV_FILE"
  printf 'CTS_ENV_MANAGED=%s\n' "${SAVED_ENV_MANAGED:-0}"
  printf 'CTS_REPOSITORY=%s\n' "$REPOSITORY"
  printf 'CTS_BRANCH=%s\n' "$BRANCH"
  exit 0
fi

[[ -z "$(git -C "$PROJECT_ROOT" status --porcelain --untracked-files=no)" ]] \
  || log_fatal "Tracked local changes exist; refusing to overwrite them"

bootstrap_args=(
  --dir "$PROJECT_ROOT"
  --name "$APP_NAME"
  --port "$APP_PORT"
  --runtime "$RUNTIME"
  --service-user "$SERVICE_USER"
  --env-file "$ENV_FILE"
  --repository "$REPOSITORY"
  --branch "$BRANCH"
)
bootstrap_args+=(--)
(( REINSTALL == 0 )) || bootstrap_args+=(--reinstall)

log_info "Delegating to clean stop → delete → install lifecycle for $PROJECT_ROOT"
exec env CTS_BOOTSTRAP_CLEAN_INSTALL=1 CTS_INSTALL_SEARCH_ROOT="$INSTALL_SEARCH_ROOT" \
  CTS_PRESERVE_ENV_MANAGED="${SAVED_ENV_MANAGED:-0}" \
  bash "$PROJECT_ROOT/scripts/bootstrap-install.sh" "${bootstrap_args[@]}"
