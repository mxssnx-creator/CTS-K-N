#!/usr/bin/env bash
# CTS-K-N in-target production installer for Ubuntu/Debian, RHEL/Fedora/Amazon
# Linux, and compatible long-lived Linux servers. Existing installations are
# handed to bootstrap-install.sh, which stops services, deletes the target, and
# clones a complete fresh checkout before this payload installer runs.
#
# The installer is intentionally deterministic:
#   - production always uses a network Redis backend (local or external)
#   - one app process, one portable 60-second scheduler, and one leased
#     Direct-Trade worker are installed with coordinated recovery checks
#   - the complete test/build/migration/deployment contract runs before success
#   - an existing production build is restored when build or verification fails

set -Eeuo pipefail
umask 027
(( BASH_VERSINFO[0] >= 4 )) || { echo "CTS-K-N requires Bash 4 or newer" >&2; exit 1; }

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { printf "%b[INFO]%b  %s\n" "$CYAN" "$RESET" "$*"; }
ok()      { printf "%b[OK]%b    %s\n" "$GREEN" "$RESET" "$*"; }
warn()    { printf "%b[WARN]%b  %s\n" "$YELLOW" "$RESET" "$*"; }
fatal()   { printf "%b[ERROR]%b %s\n" "$RED" "$RESET" "$*" >&2; exit 1; }
section() { printf "\n%b%s%b\n" "$BOLD$CYAN" "════════ $* ════════" "$RESET"; }

APP_NAME=""
APP_PORT=""
RUNTIME="auto"
SERVICE_USER="${SUDO_USER:-${USER:-$(id -un)}}"
APP_NAME_SET=0
APP_PORT_SET=0
RUNTIME_SET=0
SERVICE_USER_SET=0
ENV_FILE_SET=0
CREATE_SERVICE_USER=0
PREFLIGHT_ONLY=0
SKIP_SYSTEM_PACKAGES=0
SKIP_TESTS=0
NON_INTERACTIVE=0
SEED_ENV_FILE=""
PNPM_VERSION="10.28.1"
REDIS_MODE="auto"
REINSTALL=0
UNINSTALL=0
SAFE_SIMULATION=0
SERVICE_USER_CREATED=0
SAVED_APP_NAME=""
SAVED_APP_PORT=""
SAVED_RUNTIME=""
SAVED_SERVICE_USER=""
SAVED_PROJECT_ROOT=""
SAVED_ENV_FILE=""
SAVED_ENV_MANAGED=""
ENV_FILE_MANAGED="${CTS_PRESERVE_ENV_MANAGED:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version" 2>/dev/null || true)"
[[ "$PACKAGE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || PACKAGE_VERSION="0.1.1"
DEFAULT_PROJECT_NAME="cts-kn"
[[ -n "$APP_NAME" ]] || APP_NAME="$DEFAULT_PROJECT_NAME"
[[ -n "$APP_PORT" ]] || APP_PORT="3002"
ENV_FILE="$PROJECT_ROOT/.env.production.local"
RUNTIME_DIR="$PROJECT_ROOT/.cts-runtime"
BUILD_BACKUP=""
ROLLBACK_ARMED=0
ROLLBACK_RUNNING=0

valid_absolute_path() {
  [[ "$1" =~ ^/[a-zA-Z0-9._/-]+$ && "$1" != "/" && "$1" != *"//"* \
    && "$1" != *"/./"* && "$1" != */. && "$1" != *"/../"* && "$1" != */.. ]]
}

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh [PROJECT_NAME] [PORT] [options]

Options:
  --name NAME             Stable service/process name (default: cts-kn)
  --project-name NAME     Alias for --name; also accepted as first positional argument
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
  --redis-mode MODE       auto, native, npm, or snapshot (default: auto)
  --reinstall             Reinstall OS apps, runtimes, global tools, and dependencies
  --safe-simulation       Run the complete server app in forced paper mode; do not require or permit exchange orders
  --uninstall             Stop/remove CTS services, CTS-owned runtime data, and this checkout
  --help                  Show this help

Sensitive values should be supplied in --seed-env-file or the existing env
file, never as command-line arguments. The installer generates ADMIN_SECRET,
CRON_SECRET, ENCRYPTION_KEY, and JWT_SECRET when they are absent. A production
server install enables the guarded live execution path and succeeds only when
valid credentials for at least one supported exchange (BingX, Bybit, Pionex, or
OrangeX), durable order coordination, and persisted live-control state are
verified; the verification never submits an order.

For a server install or upgrade, prefer scripts/bootstrap-install.sh. When an
installed CTS runtime is detected, this command delegates to that clean flow.
Use --safe-simulation for a full owner/debug deployment that must keep every
exchange order path disabled, including when preserved credentials exist.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) APP_NAME="${2:?--name requires a value}"; APP_NAME_SET=1; shift 2 ;;
    --project-name|--project) APP_NAME="${2:?$1 requires a value}"; APP_NAME_SET=1; shift 2 ;;
    --port) APP_PORT="${2:?--port requires a value}"; APP_PORT_SET=1; shift 2 ;;
    --runtime) RUNTIME="${2:?--runtime requires a value}"; RUNTIME_SET=1; shift 2 ;;
    --service-user) SERVICE_USER="${2:?--service-user requires a value}"; SERVICE_USER_SET=1; shift 2 ;;
    --create-service-user) CREATE_SERVICE_USER=1; shift ;;
    --env-file) ENV_FILE="${2:?--env-file requires a value}"; ENV_FILE_SET=1; shift 2 ;;
    --seed-env-file) SEED_ENV_FILE="${2:?--seed-env-file requires a value}"; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --skip-system-packages) SKIP_SYSTEM_PACKAGES=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --redis-mode) REDIS_MODE="${2:?--redis-mode requires a value}"; shift 2 ;;
    --reinstall) REINSTALL=1; shift ;;
    --safe-simulation) SAFE_SIMULATION=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --help|-h) usage; exit 0 ;;
    -*) fatal "Unknown option: $1" ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ && "$APP_PORT" == "3002" ]]; then APP_PORT="$1"; APP_PORT_SET=1;
      elif [[ "$APP_NAME" == "$DEFAULT_PROJECT_NAME" ]]; then APP_NAME="$1"; APP_NAME_SET=1;
      elif [[ "$APP_PORT" == "3002" ]]; then APP_PORT="$1"; APP_PORT_SET=1;
      else fatal "Unexpected positional argument: $1"; fi
      shift ;;
  esac
done

load_installed_defaults() {
  local values_file="$RUNTIME_DIR/install-values.env" key value
  [[ -r "$values_file" ]] || return 0
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    case "$key" in
      CTS_INSTALLED_APP_NAME)
        SAVED_APP_NAME="$value"
        if (( APP_NAME_SET == 0 )) && [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; then
          APP_NAME="$value"
        fi
        ;;
      CTS_INSTALLED_APP_PORT)
        SAVED_APP_PORT="$value"
        if (( APP_PORT_SET == 0 )) && [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1 && value <= 65535 )); then
          APP_PORT="$value"
        fi
        ;;
      CTS_INSTALLED_RUNTIME)
        SAVED_RUNTIME="$value"
        if (( RUNTIME_SET == 0 )) && [[ "$value" =~ ^(systemd|pm2)$ ]]; then
          RUNTIME="$value"
        fi
        ;;
      CTS_INSTALLED_SERVICE_USER)
        SAVED_SERVICE_USER="$value"
        if (( SERVICE_USER_SET == 0 )) && [[ "$value" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]]; then
          SERVICE_USER="$value"
        fi
        ;;
      CTS_INSTALLED_PROJECT_ROOT)
        SAVED_PROJECT_ROOT="$value"
        ;;
      CTS_INSTALLED_ENV_FILE)
        SAVED_ENV_FILE="$value"
        if (( ENV_FILE_SET == 0 )) && [[ "$value" == /* && "$value" != "/" ]]; then
          ENV_FILE="$value"
        fi
        ;;
      CTS_INSTALLED_ENV_MANAGED)
        [[ "$value" =~ ^[01]$ ]] && SAVED_ENV_MANAGED="$value"
        ;;
    esac
  done < "$values_file"
}

# A repeat install must target the already installed service even when the
# operator omits --name/--port. Explicit command-line values always win.
load_installed_defaults

if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$PROJECT_ROOT/${ENV_FILE#./}"
fi
valid_absolute_path "$PROJECT_ROOT" || fatal "Project root must be a safe absolute non-root path"
valid_absolute_path "$ENV_FILE" || fatal "Environment file must be a safe absolute non-root path"

# A directory is authoritative on removal. Never let a typo in --name stop an
# unrelated service and then remove this checkout; use its recorded runtime
# identity instead. Explicit matching values remain accepted for automation.
if (( UNINSTALL == 1 )) && [[ -n "$SAVED_APP_NAME" && "$SAVED_APP_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; then
  if (( APP_NAME_SET == 1 )) && [[ "$APP_NAME" != "$SAVED_APP_NAME" ]]; then
    fatal "--name '$APP_NAME' does not match the installed CTS service '$SAVED_APP_NAME' in $PROJECT_ROOT"
  fi
  if (( APP_PORT_SET == 1 )) && [[ "$SAVED_APP_PORT" =~ ^[0-9]+$ ]] && [[ "$APP_PORT" != "$SAVED_APP_PORT" ]]; then
    fatal "--port '$APP_PORT' does not match the installed CTS port '$SAVED_APP_PORT' in $PROJECT_ROOT"
  fi
  if (( RUNTIME_SET == 1 )) && [[ "$SAVED_RUNTIME" =~ ^(systemd|pm2)$ ]] && [[ "$RUNTIME" != "$SAVED_RUNTIME" ]]; then
    fatal "--runtime '$RUNTIME' does not match the installed runtime '$SAVED_RUNTIME' in $PROJECT_ROOT"
  fi
  if (( SERVICE_USER_SET == 1 )) && [[ "$SAVED_SERVICE_USER" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]] \
    && [[ "$SERVICE_USER" != "$SAVED_SERVICE_USER" ]]; then
    fatal "--service-user '$SERVICE_USER' does not match the installed service user '$SAVED_SERVICE_USER' in $PROJECT_ROOT"
  fi
  if (( ENV_FILE_SET == 1 )) && [[ "$SAVED_ENV_FILE" == /* && "$SAVED_ENV_FILE" != "/" ]] \
    && [[ "$ENV_FILE" != "$SAVED_ENV_FILE" ]]; then
    fatal "--env-file '$ENV_FILE' does not match the installed environment '$SAVED_ENV_FILE' in $PROJECT_ROOT"
  fi
  APP_NAME="$SAVED_APP_NAME"
  [[ "$SAVED_APP_PORT" =~ ^[0-9]+$ ]] && APP_PORT="$SAVED_APP_PORT"
  [[ "$SAVED_RUNTIME" =~ ^(systemd|pm2)$ ]] && RUNTIME="$SAVED_RUNTIME"
  [[ "$SAVED_SERVICE_USER" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]] && SERVICE_USER="$SAVED_SERVICE_USER"
  [[ "$SAVED_ENV_FILE" == /* && "$SAVED_ENV_FILE" != "/" ]] && ENV_FILE="$SAVED_ENV_FILE"
elif (( APP_NAME_SET == 1 )) && [[ -n "$SAVED_APP_NAME" && "$SAVED_APP_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ && "$APP_NAME" != "$SAVED_APP_NAME" ]]; then
  fatal "This checkout is installed as '$SAVED_APP_NAME'; use bootstrap-install.sh to replace it under a new --name safely"
fi

if (( UNINSTALL == 0 )); then
  if (( RUNTIME_SET == 1 )) && [[ "$SAVED_RUNTIME" =~ ^(systemd|pm2)$ ]] && [[ "$RUNTIME" != "$SAVED_RUNTIME" ]]; then
    fatal "This checkout uses runtime '$SAVED_RUNTIME'; use bootstrap-install.sh to replace it with '$RUNTIME' safely"
  fi
  if (( SERVICE_USER_SET == 1 )) && [[ "$SAVED_SERVICE_USER" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]] \
    && [[ "$SERVICE_USER" != "$SAVED_SERVICE_USER" ]]; then
    fatal "This checkout uses service user '$SAVED_SERVICE_USER'; use bootstrap-install.sh to replace it safely"
  fi
  if (( ENV_FILE_SET == 1 )) && [[ "$SAVED_ENV_FILE" == /* && "$SAVED_ENV_FILE" != "/" ]] \
    && [[ "$ENV_FILE" != "$SAVED_ENV_FILE" ]]; then
    fatal "This checkout uses environment '$SAVED_ENV_FILE'; use bootstrap-install.sh to relocate it safely"
  fi
fi
if [[ -n "$ENV_FILE_MANAGED" && ! "$ENV_FILE_MANAGED" =~ ^[01]$ ]]; then
  fatal "CTS_PRESERVE_ENV_MANAGED must be 0 or 1"
fi
if [[ -z "$ENV_FILE_MANAGED" && -n "$SAVED_ENV_MANAGED" ]]; then
  ENV_FILE_MANAGED="$SAVED_ENV_MANAGED"
fi
# Own new environment files, but never adopt an existing external file
# implicitly. The recorded marker makes update/uninstall behavior deterministic.
if [[ -z "$ENV_FILE_MANAGED" ]]; then
  if [[ -e "$ENV_FILE" ]]; then ENV_FILE_MANAGED=0; else ENV_FILE_MANAGED=1; fi
fi
if [[ -n "$SAVED_PROJECT_ROOT" && "$SAVED_PROJECT_ROOT" != "$PROJECT_ROOT" ]]; then
  fatal "Saved installation root '$SAVED_PROJECT_ROOT' does not match this checkout '$PROJECT_ROOT'"
fi

if (( UNINSTALL == 0 && NON_INTERACTIVE == 0 )) && [[ -t 0 ]]; then
  if [[ "$APP_NAME" == "$DEFAULT_PROJECT_NAME" ]]; then
    read -r -p "Project/service name [$DEFAULT_PROJECT_NAME]: " answer || true
    [[ -z "$answer" ]] || APP_NAME="$answer"
  fi
  if [[ "$APP_PORT" == "3002" ]]; then
    read -r -p "HTTP port [3002]: " answer || true
    [[ -z "$answer" ]] || APP_PORT="$answer"
  fi
fi

[[ "$APP_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || fatal "Invalid service name: $APP_NAME"
[[ "$SERVICE_USER" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]] || fatal "Invalid service user: $SERVICE_USER"
[[ "$APP_PORT" =~ ^[0-9]+$ ]] && (( APP_PORT >= 1 && APP_PORT <= 65535 )) || fatal "Port must be 1..65535"
case "$RUNTIME" in auto|systemd|pm2) ;; *) fatal "Runtime must be auto, systemd, or pm2" ;; esac
case "$REDIS_MODE" in auto|native|npm|snapshot) ;; *) fatal "Redis mode must be auto, native, npm, or snapshot" ;; esac
if (( UNINSTALL == 0 )); then
  [[ "$PROJECT_ROOT" != "/" && -f "$PROJECT_ROOT/package.json" && -f "$PROJECT_ROOT/pnpm-lock.yaml" ]] \
    || fatal "Installer must run from a complete CTS-K-N checkout"
  [[ -f "$PROJECT_ROOT/lib/redis-migrations.ts" ]] || fatal "Migration bundle is missing"
  [[ -z "$SEED_ENV_FILE" || -r "$SEED_ENV_FILE" ]] || fatal "Seed env file is not readable: $SEED_ENV_FILE"
fi

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

uninstall_project() {
  section "Removing CTS-K-N"
  [[ "$PROJECT_ROOT" != "/" && "$PROJECT_ROOT" == /* && -d "$PROJECT_ROOT" && -f "$SCRIPT_DIR/install.sh" ]] \
    || fatal "Refusing to remove an unsafe or incomplete project directory: $PROJECT_ROOT"

  local remove_service_user=0 managed_user_file="$RUNTIME_DIR/managed-service-user"
  if [[ -f "$managed_user_file" && "$(<"$managed_user_file")" == "$SERVICE_USER" ]]; then
    remove_service_user=1
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_root systemctl disable --now "$APP_NAME-recovery.timer" "$APP_NAME" "$APP_NAME-scheduler" "$APP_NAME-direct-trade" "$APP_NAME-redis" 2>/dev/null || true
    run_root rm -f -- "/etc/systemd/system/$APP_NAME.service" "/etc/systemd/system/$APP_NAME-scheduler.service" "/etc/systemd/system/$APP_NAME-direct-trade.service" "/etc/systemd/system/$APP_NAME-recovery.service" "/etc/systemd/system/$APP_NAME-recovery.timer" "/etc/systemd/system/$APP_NAME-redis.service"
    run_root systemctl daemon-reload 2>/dev/null || true
    run_root systemctl reset-failed "$APP_NAME" "$APP_NAME-scheduler" "$APP_NAME-direct-trade" "$APP_NAME-recovery" "$APP_NAME-redis" 2>/dev/null || true
  fi
  if command -v pm2 >/dev/null 2>&1 && id "$SERVICE_USER" >/dev/null 2>&1; then
    run_as_service pm2 delete "$APP_NAME" "$APP_NAME-scheduler" "$APP_NAME-direct-trade" "$APP_NAME-recovery" "$APP_NAME-redis" >/dev/null 2>&1 || true
    run_as_service pm2 save --force >/dev/null 2>&1 || true
  fi

  local external_env_preserved=0 external_env_removed=0
  if [[ "$ENV_FILE" != "$PROJECT_ROOT"/* && -e "$ENV_FILE" ]]; then
    if (( ENV_FILE_MANAGED == 1 )); then
      run_root rm -f -- "$ENV_FILE"
      external_env_removed=1
    else
      external_env_preserved=1
    fi
  fi

  # Redis, Node, pnpm, and Bun can be shared by unrelated applications. Remove
  # only CTS units/data and leave shared runtimes, externally managed
  # environment files, and external Redis keys intact.
  cd /
  run_root rm -rf -- "$PROJECT_ROOT"
  if (( remove_service_user == 1 )) && id "$SERVICE_USER" >/dev/null 2>&1; then
    run_root userdel --remove "$SERVICE_USER" 2>/dev/null || run_root userdel "$SERVICE_USER" || true
    ok "Removed CTS-managed service user: $SERVICE_USER"
  fi
  ok "Removed CTS services and checkout: $PROJECT_ROOT"
  if (( external_env_preserved == 1 )); then
    info "Externally managed environment file preserved: $ENV_FILE"
  elif (( external_env_removed == 1 )); then
    ok "Removed installer-managed environment file: $ENV_FILE"
  fi
  info "Shared Bun/Node/Redis installations and externally managed Redis data were preserved."
}

handoff_existing_install_to_bootstrap() {
  (( PREFLIGHT_ONLY == 0 && UNINSTALL == 0 )) || return 0
  [[ "${CTS_BOOTSTRAP_CLEAN_INSTALL:-0}" == "1" ]] && return 0
  [[ -r "$RUNTIME_DIR/install-values.env" ]] || return 0

  local repository branch
  repository="$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)"
  branch="$(git -C "$PROJECT_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [[ -n "$branch" ]] || branch="main"
  [[ -n "$repository" && "$repository" != *$'\n'* && "$repository" != *[[:space:]]* ]] \
    || fatal "Existing CTS-K-N installation has no valid origin; use bootstrap-install.sh with --repository"
  [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ && "$branch" != *".."* && "$branch" != *"//"* ]] \
    || fatal "Existing CTS-K-N installation has no valid branch; use bootstrap-install.sh with --branch"

  local -a bootstrap_args=(
    --dir "$PROJECT_ROOT"
    --name "$APP_NAME"
    --port "$APP_PORT"
    --runtime "$RUNTIME"
    --service-user "$SERVICE_USER"
    --env-file "$ENV_FILE"
    --repository "$repository"
    --branch "$branch"
  )
  [[ -z "$SEED_ENV_FILE" ]] || bootstrap_args+=(--seed-env-file "$SEED_ENV_FILE")
  bootstrap_args+=(--)
  (( REINSTALL == 0 )) || bootstrap_args+=(--reinstall)
  (( SKIP_SYSTEM_PACKAGES == 0 )) || bootstrap_args+=(--skip-system-packages)
  (( SKIP_TESTS == 0 )) || bootstrap_args+=(--skip-tests)
  bootstrap_args+=(--redis-mode "$REDIS_MODE")

  info "Existing CTS-K-N install detected; delegating to clean stop → delete → reinstall flow"
  exec env CTS_BOOTSTRAP_CLEAN_INSTALL=1 CTS_INSTALL_SEARCH_ROOT="$(dirname "$PROJECT_ROOT")" \
    bash "$SCRIPT_DIR/bootstrap-install.sh" "${bootstrap_args[@]}"
}

detect_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then printf 'apt'; return; fi
  if command -v dnf >/dev/null 2>&1; then printf 'dnf'; return; fi
  if command -v yum >/dev/null 2>&1; then printf 'yum'; return; fi
  printf 'none'
}

PACKAGE_MANAGER="$(detect_package_manager)"

if (( UNINSTALL == 1 )); then
  uninstall_project
  exit 0
fi

handoff_existing_install_to_bootstrap

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

# The host total is misleading inside a constrained container.  Resolve a
# conservative installation budget from the lower of the host/cgroup limits
# and then from memory that is actually available at install time.  This
# budget drives the Node heap and the systemd/PM2 restart watchdogs below.
read_positive_file_kb() {
  local file="$1" raw
  [[ -r "$file" ]] || return 1
  raw="$(tr -d '[:space:]' < "$file" 2>/dev/null || true)"
  [[ "$raw" =~ ^[0-9]+$ ]] || return 1
  (( raw > 0 )) || return 1
  # cgroup v1 commonly exposes a near-infinite sentinel when unconstrained.
  (( raw < 1152921504606846976 )) || return 1
  printf '%s' "$(( raw / 1024 ))"
}

effective_memory_limits_kb() {
  local host_total_kb host_available_kb cgroup_limit_kb=0 cgroup_used_kb=0
  host_total_kb="$(awk '/MemTotal:/ {print $2; exit}' /proc/meminfo 2>/dev/null || printf '0')"
  host_available_kb="$(awk '/MemAvailable:/ {print $2; exit}' /proc/meminfo 2>/dev/null || printf '0')"
  [[ "$host_total_kb" =~ ^[0-9]+$ ]] || host_total_kb=0
  [[ "$host_available_kb" =~ ^[0-9]+$ ]] || host_available_kb=0

  cgroup_limit_kb="$(read_positive_file_kb /sys/fs/cgroup/memory.max 2>/dev/null \
    || read_positive_file_kb /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || printf '0')"
  cgroup_used_kb="$(read_positive_file_kb /sys/fs/cgroup/memory.current 2>/dev/null \
    || read_positive_file_kb /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || printf '0')"

  local total_kb="$host_total_kb" available_kb="$host_available_kb"
  if [[ "$cgroup_limit_kb" =~ ^[0-9]+$ ]] && (( cgroup_limit_kb > 0 )) \
    && (( host_total_kb == 0 || cgroup_limit_kb < host_total_kb )); then
    total_kb="$cgroup_limit_kb"
    if [[ "$cgroup_used_kb" =~ ^[0-9]+$ ]] && (( cgroup_used_kb < cgroup_limit_kb )); then
      available_kb="$(( cgroup_limit_kb - cgroup_used_kb ))"
    else
      available_kb="$cgroup_limit_kb"
    fi
  fi
  (( total_kb > 0 )) || total_kb=0
  (( available_kb > 0 )) || available_kb="$total_kb"
  (( available_kb <= total_kb )) || available_kb="$total_kb"
  printf '%s %s\n' "$total_kb" "$available_kb"
}

run_preflight() {
  section "Production preflight"
  [[ "$(uname -s)" == "Linux" ]] || fatal "Only long-lived Linux servers are supported by this installer"
  ok "OS: $(uname -srm)"
  [[ "$PACKAGE_MANAGER" != "none" || "$SKIP_SYSTEM_PACKAGES" == "1" ]] \
    || fatal "No supported package manager found (apt, dnf, or yum)"
  ok "Package manager: $PACKAGE_MANAGER"

  local disk_kb memory_total_kb memory_available_kb memory_limits
  disk_kb="$(df -Pk "$PROJECT_ROOT" | awk 'NR==2 {print $4}')"
  # Avoid bash process substitution here: constrained SSH/bootstrap shells may
  # not mount /dev/fd, even though command substitution is available.
  memory_limits="$(effective_memory_limits_kb)"
  read -r memory_total_kb memory_available_kb <<< "$memory_limits"
  (( disk_kb >= 4 * 1024 * 1024 )) || fatal "At least 4 GiB free disk is required"
  # The relative watchdog reserves memory for the app plus scheduler and
  # Direct-Trade worker. Keep the preflight threshold aligned with that
  # aggregate floor so an install cannot pass preflight and fail later while
  # producing service limits.
  (( memory_available_kb >= 2048 * 1024 )) || fatal "At least 2 GiB effective available memory is required"
  ok "Capacity: $((disk_kb / 1024 / 1024)) GiB free disk, $((memory_total_kb / 1024 / 1024)) GiB effective limit, $((memory_available_kb / 1024 / 1024)) GiB available"

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
  # Contract tests provide a mocked systemctl boundary. Keep the real host
  # preflight strict while allowing that isolated fixture to exercise the
  # installer without requiring PID 1 to be systemd.
  if [[ -z "${CTS_TEST_TARGET:-}" && -z "${CTS_TEST_INSTALLER:-}" ]]; then
    command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] \
    || fatal "The requested systemd runtime is not active on this host"
  fi
  fi
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    if (( CREATE_SERVICE_USER == 1 )); then
      command -v useradd >/dev/null 2>&1 || fatal "useradd is required to create service user $SERVICE_USER"
      warn "Service user $SERVICE_USER will be created during installation"
    else
      fatal "Service user does not exist: $SERVICE_USER (use --create-service-user)"
    fi
  fi

  for file in package.json pnpm-lock.yaml pnpm-workspace.yaml scripts/run-minute-scheduler.mjs scripts/direct-trade-supervisor.mjs scripts/direct-trade-processor.mjs lib/direct-trade-ledger-recovery.cjs scripts/runtime-recovery.sh scripts/run-with-env.mjs scripts/start-production.mjs scripts/prepare-standalone-assets.mjs scripts/start.sh scripts/stop.sh scripts/restart.sh scripts/service-control.sh scripts/post-deploy-verify.sh scripts/production-deploy-init.mjs; do
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
  local -a packages=()
  package_present() {
    local package="$1"
    case "$PACKAGE_MANAGER" in
      apt) dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' ;;
      dnf|yum) rpm -q "$package" >/dev/null 2>&1 ;;
      *) return 1 ;;
    esac
  }
  add_package_if_needed() {
    local package="$1"
    if (( REINSTALL == 1 )) || ! package_present "$package"; then packages+=("$package"); else info "$package already installed; keeping it"; fi
  }
  case "$PACKAGE_MANAGER" in
    apt)
      (( NON_INTERACTIVE == 1 )) && export DEBIAN_FRONTEND=noninteractive
      for package in ca-certificates curl git build-essential openssl python3 python3-pip python3-venv; do add_package_if_needed "$package"; done
      if ! command -v redis-server >/dev/null 2>&1 && ! command -v redis-cli >/dev/null 2>&1; then
        add_package_if_needed redis-server; add_package_if_needed redis-tools
      elif (( REINSTALL == 1 )); then
        add_package_if_needed redis-server; add_package_if_needed redis-tools
      else info "Native Redis already available; keeping the installed server"; fi
      if ((${#packages[@]} > 0)); then
        run_root apt-get update -y
        run_root apt-get install -y "${packages[@]}"
      fi
      ;;
    dnf)
      for package in ca-certificates curl git gcc-c++ make openssl python3 python3-pip procps-ng; do add_package_if_needed "$package"; done
      if ! command -v redis-server >/dev/null 2>&1 && ! command -v redis-cli >/dev/null 2>&1; then add_package_if_needed redis; elif (( REINSTALL == 1 )); then add_package_if_needed redis; fi
      ((${#packages[@]} == 0)) || run_root dnf install -y "${packages[@]}"
      ;;
    yum)
      for package in ca-certificates curl git gcc-c++ make openssl python3 python3-pip procps-ng; do add_package_if_needed "$package"; done
      if ! command -v redis-server >/dev/null 2>&1 && ! command -v redis-cli >/dev/null 2>&1; then add_package_if_needed redis; elif (( REINSTALL == 1 )); then add_package_if_needed redis; fi
      ((${#packages[@]} == 0)) || run_root yum install -y "${packages[@]}"
      ;;
    none) fatal "Cannot install required system packages" ;;
  esac
  ok "Required operating-system dependencies are installed"
}

ensure_service_user() {
  section "Unprivileged service identity"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    (( CREATE_SERVICE_USER == 1 )) || fatal "Service user does not exist: $SERVICE_USER (use --create-service-user)"
    local nologin_shell="/usr/sbin/nologin"
    [[ -x "$nologin_shell" ]] || nologin_shell="/sbin/nologin"
    [[ -x "$nologin_shell" ]] || nologin_shell="/bin/false"
    run_root useradd --system --create-home --home-dir "/var/lib/$APP_NAME" --shell "$nologin_shell" "$SERVICE_USER"
    SERVICE_USER_CREATED=1
    ok "Created locked, non-login system service user: $SERVICE_USER"
  else
    ok "Service user exists: $SERVICE_USER"
  fi
}

ensure_node_and_pnpm() {
  section "Node.js and pinned pnpm"
  local major=0
  command -v node >/dev/null 2>&1 && major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  if (( REINSTALL == 1 || major < 20 )); then
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

  command -v npm >/dev/null 2>&1 || fatal "npm was not provided by the Node.js installation"
  command -v npx >/dev/null 2>&1 || fatal "npx was not provided by the Node.js installation"
  local pnpm_version=""
  if command -v pnpm >/dev/null 2>&1; then
    pnpm_version="$(pnpm --version 2>/dev/null || true)"
  fi
  if [[ "$pnpm_version" != "$PNPM_VERSION" ]] && command -v corepack >/dev/null 2>&1; then
    run_root corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null 2>&1 || true
    pnpm_version="$(pnpm --version 2>/dev/null || true)"
  fi
  if [[ "$pnpm_version" != "$PNPM_VERSION" ]]; then
    # --reinstall must remain idempotent: npm otherwise fails with EEXIST when
    # /usr/bin/pnpm is already provisioned by Corepack or the OS package.
    run_root npm install -g "pnpm@$PNPM_VERSION" --no-audit --no-fund --loglevel=error \
      || fatal "Could not install pnpm $PNPM_VERSION; existing pnpm is invalid or conflicts with /usr/bin/pnpm"
    pnpm_version="$(pnpm --version 2>/dev/null || true)"
  fi
  [[ "$pnpm_version" == "$PNPM_VERSION" ]] || fatal "Could not activate pnpm $PNPM_VERSION"
  ok "Node $(node --version), npm $(npm --version), npx $(npx --version), pnpm $(pnpm --version)"
}

ensure_python_pip_and_bun() {
  section "Python, pip, and global Bun toolchain"
  command -v python3 >/dev/null 2>&1 || fatal "python3 is missing after OS dependency installation"
  command -v pip3 >/dev/null 2>&1 || fatal "pip3 is missing after OS dependency installation"
  python3 -m pip --version >/dev/null 2>&1 || fatal "python3 -m pip is not usable"
  ok "Python $(python3 --version 2>&1), pip $(python3 -m pip --version | awk '{print $2}')"

  # Ensure the service user's home directory exists before running commands as that user
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    local home
    home="$(service_home)"
    if [[ -n "$home" && ! -d "$home" ]]; then
      run_root install -d -m 0750 -o "$SERVICE_USER" -g "$(id -gn "$SERVICE_USER")" "$home"
    fi
  fi

  local bun_install_dir="/opt/bun" existing_bun="" global_bun="/usr/local/bin/bun"
  if [[ -x "$global_bun" ]] && "$global_bun" --version >/dev/null 2>&1 && (( REINSTALL == 0 )); then
    existing_bun="$global_bun"
    info "Global Bun already installed; keeping it"
  elif (( REINSTALL == 0 )) && command -v bun >/dev/null 2>&1; then
    existing_bun="$(command -v bun)"
    if run_as_service "$existing_bun" --version >/dev/null 2>&1; then
      run_root ln -sfn "$existing_bun" "$global_bun"
      existing_bun="$global_bun"
      info "Promoted the existing Bun executable to the global path"
    else
      existing_bun=""
    fi
  fi
  if [[ -z "$existing_bun" ]]; then
    command -v curl >/dev/null 2>&1 || fatal "curl is required to install Bun"
    if ! command -v unzip >/dev/null 2>&1; then
      case "$PACKAGE_MANAGER" in
        apt) run_root apt-get update -y; run_root apt-get install -y unzip ;;
        dnf|yum) run_root "$PACKAGE_MANAGER" install -y unzip ;;
        *) fatal "unzip is required to install Bun" ;;
      esac
    fi
    run_root mkdir -p "$bun_install_dir"
    run_root env BUN_INSTALL="$bun_install_dir" bash -c 'curl -fsSL https://bun.sh/install | bash' \
      || fatal "Bun installation failed"
    [[ -x "$bun_install_dir/bin/bun" ]] || fatal "Bun installer did not create its executable"
    run_root ln -sfn "$bun_install_dir/bin/bun" "$global_bun"
  fi
  # Ensure the service user can execute Bun from the installation directory
  run_root chmod -R a+rX "$bun_install_dir" "$global_bun"
  [[ -x "$global_bun" ]] || fatal "Global Bun is missing after installation"
  run_as_service "$global_bun" --version >/dev/null 2>&1 || fatal "The service user cannot execute global Bun"
  ok "Global Bun $($global_bun --version)"
}

env_value() {
  local key="$1" value
  value="$("${SUDO[@]}" grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

upsert_env() {
  local key="$1" value="$2" tmp
  [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || fatal "Invalid environment key: $key"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fatal "Environment values cannot contain newlines"
  tmp="$(mktemp "$RUNTIME_DIR/env.XXXXXX")"
  "${SUDO[@]}" grep -Ev "^${key}=" "$ENV_FILE" 2>/dev/null > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  run_root install -m 0600 -- "$tmp" "$ENV_FILE"
  rm -f -- "$tmp"
}

configure_cpu_parallelism() {
  # CTS keeps one authoritative Node engine owner. Base→Main→Real calculation
  # is CPU/heap work on that event loop, so assigning every detected core to a
  # Promise pool creates allocation contention rather than true parallel CPU.
  # Use a conservative CPU-aware pool: on the measured 9-core host this selects
  # two lanes, which beat four and eight in the 16-symbol exhaustive benchmark
  # while preserving control-plane responsiveness. Cgroup v2 is authoritative
  # when present; nproc/procfs are fallbacks for bare-metal hosts.
  local cpu_count=1 io_pool symbol_pool historic_pool quota period cgroup_detected=0
  if [[ -r /sys/fs/cgroup/cpu.max ]]; then
    read -r quota period < /sys/fs/cgroup/cpu.max || true
    if [[ "${quota:-max}" != "max" && "${quota:-}" =~ ^[0-9]+$ && "${period:-}" =~ ^[0-9]+$ && "$period" -gt 0 ]]; then
      cpu_count=$(( (quota + period - 1) / period ))
      cgroup_detected=1
    fi
  fi
  if (( cgroup_detected == 0 )) && command -v nproc >/dev/null 2>&1; then
    cpu_count="$(nproc 2>/dev/null || printf '1')"
  elif (( cgroup_detected == 0 )) && [[ -r /proc/cpuinfo ]]; then
    cpu_count="$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || printf '1')"
  fi
  [[ "$cpu_count" =~ ^[0-9]+$ ]] || cpu_count=1
  (( cpu_count > 0 )) || cpu_count=1

  io_pool=$(( cpu_count * 2 ))
  (( io_pool < 4 )) && io_pool=4
  (( io_pool > 32 )) && io_pool=32
  symbol_pool=$(( (cpu_count + 1) / 4 ))
  (( symbol_pool < 1 )) && symbol_pool=1
  (( symbol_pool > 4 )) && symbol_pool=4
  historic_pool="$symbol_pool"

  [[ -n "$(env_value CTS_CPU_COUNT)" ]] || upsert_env CTS_CPU_COUNT "$cpu_count"
  [[ -n "$(env_value UV_THREADPOOL_SIZE)" ]] || upsert_env UV_THREADPOOL_SIZE "$io_pool"
  [[ -n "$(env_value ENGINE_SYMBOL_CONCURRENCY)" ]] || upsert_env ENGINE_SYMBOL_CONCURRENCY "$symbol_pool"
  [[ -n "$(env_value REALTIME_SYMBOL_CONCURRENCY)" ]] || upsert_env REALTIME_SYMBOL_CONCURRENCY "$symbol_pool"
  [[ -n "$(env_value PREHISTORIC_SYMBOL_CONCURRENCY)" ]] || upsert_env PREHISTORIC_SYMBOL_CONCURRENCY "$historic_pool"
  [[ -n "$(env_value STRATEGY_FLOW_SYMBOL_CONCURRENCY)" ]] || upsert_env STRATEGY_FLOW_SYMBOL_CONCURRENCY "$symbol_pool"
  # All connections share one in-process Strategy allocation budget. More
  # than one simultaneously retained Base→Main→Real graph increases peak RSS
  # much faster than throughput on Node's single JavaScript thread and can
  # trigger long full-heap collections that starve health/control routes.
  # Operators can still raise the explicit environment value after profiling.
  local memory_flow_pool=1
  [[ -n "$(env_value CTS_STRATEGY_MEMORY_MAX_ACTIVE_FLOWS)" ]] || upsert_env CTS_STRATEGY_MEMORY_MAX_ACTIVE_FLOWS "$memory_flow_pool"
  [[ -n "$(env_value PRESET_SYMBOL_CONCURRENCY)" ]] || upsert_env PRESET_SYMBOL_CONCURRENCY "$symbol_pool"
  ok "CPU parallelism: ${cpu_count} cores, ${symbol_pool} safe symbol worker, libuv pool ${io_pool} (explicit env may raise workers)"
}

configure_memory_watchdog() {
  # Reserve memory for the kernel, Redis, the scheduler and ordinary system
  # work. The remaining budget is intentionally based on *available* memory,
  # so a server that is already busy never receives the old fixed 5.6 GiB Node
  # heap or a restart threshold it cannot sustain.
  local total_kb available_kb total_mb available_mb reserve_mb process_budget_mb runtime_max_mb runtime_high_mb runtime_soft_mb app_heap_mb scheduler_max_mb scheduler_heap_mb direct_trade_max_mb direct_trade_heap_mb direct_trade_worker_count direct_trade_worker_heap_mb
  read -r total_kb available_kb < <(effective_memory_limits_kb)
  total_mb=$(( total_kb / 1024 ))
  available_mb=$(( available_kb / 1024 ))
  reserve_mb=$(( total_mb / 10 ))
  (( reserve_mb < 256 )) && reserve_mb=256
  (( reserve_mb > 1536 )) && reserve_mb=1536
  # Keep the aggregate app + scheduler + Direct-Trade worker below the
  # available-memory budget. Individual service watchdogs therefore cannot
  # collectively promise more memory than the host/cgroup can provide.
  process_budget_mb=$(( (available_mb - reserve_mb) * 80 / 100 ))
  (( process_budget_mb >= 1280 )) || fatal "Effective available memory is too low after the CTS runtime reserve"
  runtime_max_mb=$(( process_budget_mb * 70 / 100 ))
  scheduler_max_mb=$(( process_budget_mb * 15 / 100 ))
  direct_trade_max_mb=$(( process_budget_mb - runtime_max_mb - scheduler_max_mb ))
  (( scheduler_max_mb < 256 )) && scheduler_max_mb=256
  (( direct_trade_max_mb < 256 )) && direct_trade_max_mb=256
  runtime_max_mb=$(( process_budget_mb - scheduler_max_mb - direct_trade_max_mb ))
  (( runtime_max_mb >= 768 )) || fatal "Effective available memory is too low for the CTS application after worker reserves"
  runtime_high_mb=$(( runtime_max_mb * 88 / 100 ))
  runtime_soft_mb=$(( runtime_max_mb * 75 / 100 ))
  app_heap_mb=$(( runtime_max_mb * 70 / 100 ))
  (( app_heap_mb < 512 )) && app_heap_mb=512
  (( app_heap_mb > 12288 )) && app_heap_mb=12288
  scheduler_heap_mb=$(( app_heap_mb / 4 ))
  (( scheduler_heap_mb < 256 )) && scheduler_heap_mb=256
  (( scheduler_heap_mb > 768 )) && scheduler_heap_mb=768
  direct_trade_heap_mb=$(( direct_trade_max_mb * 70 / 100 ))
  (( direct_trade_heap_mb < 192 )) && direct_trade_heap_mb=192
  (( direct_trade_heap_mb > 1024 )) && direct_trade_heap_mb=1024
  # One supervisor coordinates independent per-connection processors inside
  # the aggregate Direct-Trade service cgroup. Divide its budget instead of
  # granting every child the complete service heap ceiling.
  direct_trade_worker_count=$(( direct_trade_max_mb / 256 ))
  (( direct_trade_worker_count < 1 )) && direct_trade_worker_count=1
  (( direct_trade_worker_count > 8 )) && direct_trade_worker_count=8
  direct_trade_worker_heap_mb=$(( (direct_trade_max_mb - 96) * 70 / 100 / direct_trade_worker_count ))
  (( direct_trade_worker_heap_mb < 128 )) && direct_trade_worker_heap_mb=128
  (( direct_trade_worker_heap_mb > 1024 )) && direct_trade_worker_heap_mb=1024

  upsert_env CTS_EFFECTIVE_MEMORY_MB "$total_mb"
  upsert_env CTS_AVAILABLE_MEMORY_MB "$available_mb"
  # The application must coordinate against its own systemd service ceiling,
  # not the larger host/cgroup total. Soft pressure serialises new Strategy
  # graphs; the hard value matches MemoryMax exactly.
  upsert_env CTS_MEMORY_LIMIT_MB "$runtime_max_mb"
  upsert_env CTS_RSS_SOFT_LIMIT_MB "$runtime_soft_mb"
  upsert_env CTS_RSS_HARD_LIMIT_MB "$runtime_max_mb"
  upsert_env CTS_NODE_HEAP_MB "$app_heap_mb"
  upsert_env CTS_SCHEDULER_NODE_HEAP_MB "$scheduler_heap_mb"
  upsert_env CTS_DIRECT_TRADE_NODE_HEAP_MB "$direct_trade_heap_mb"
  upsert_env CTS_DIRECT_TRADE_MAX_CONNECTION_WORKERS "$direct_trade_worker_count"
  upsert_env CTS_DIRECT_TRADE_WORKER_HEAP_MB "$direct_trade_worker_heap_mb"
  upsert_env CTS_RUNTIME_MEMORY_HIGH_MB "$runtime_high_mb"
  upsert_env CTS_RUNTIME_MEMORY_MAX_MB "$runtime_max_mb"
  upsert_env CTS_SCHEDULER_MEMORY_MAX_MB "$scheduler_max_mb"
  upsert_env CTS_DIRECT_TRADE_MEMORY_MAX_MB "$direct_trade_max_mb"
  ok "Memory watchdog: ${available_mb} MiB available → app ${runtime_max_mb} MiB, scheduler ${scheduler_max_mb} MiB, Direct-Trade ${direct_trade_max_mb} MiB (${direct_trade_worker_count} workers × ${direct_trade_worker_heap_mb} MiB heap)"
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
    case "$key" in NODE_OPTIONS|PATH|LD_*|BASH_ENV|ENV|SHELL|HOME|FORCE_LIVE|FORCE_SIMULATED|ALLOW_LIVE_ORDER_PLACEMENT) fatal "Blocked seed environment key: $key" ;; esac
    upsert_env "$key" "$value"
  done < "$SEED_ENV_FILE"
}

placeholder_secret() {
  local value="$1" lower
  lower="${value,,}"
  [[ -z "$value" || ${#value} -lt 16 || "$lower" =~ ^(replace|change|your)[_-]?me \
    || "$lower" =~ (placeholder|example|dummy|not[_-]?set|test[_-]?key|test[_-]?secret) ]]
}

configure_environment_and_redis() {
  section "Durable Redis and production environment"
  mkdir -p "$RUNTIME_DIR" "$PROJECT_ROOT/logs" "$PROJECT_ROOT/data/redis"
  local env_parent
  env_parent="$(dirname "$ENV_FILE")"
  if [[ ! -d "$env_parent" ]]; then
    run_root install -d -m 0750 -- "$env_parent"
  fi
  [[ -f "$ENV_FILE" ]] || run_root install -m 0600 /dev/null "$ENV_FILE"
  run_root chmod 600 "$ENV_FILE"
  merge_seed_env

  local redis_url redis_service_mode="external" inline_snapshot=0
  redis_url="${INSTALL_REDIS_URL:-$(env_value REDIS_URL)}"
  if [[ "$REDIS_MODE" == "snapshot" ]]; then
    section "Persistent InlineLocalRedis snapshot"
    inline_snapshot=1
    redis_url=""
    redis_service_mode="inline-snapshot"
    mkdir -p "$RUNTIME_DIR/redis-data"
    upsert_env CTS_REDIS_SERVICE_MODE inline-snapshot
    upsert_env CTS_INLINE_REDIS_PERSISTENT_VOLUME 1
    upsert_env V0_REDIS_SNAPSHOT_PATH "$RUNTIME_DIR/redis-data/redis-snapshot.json"
  fi
  if [[ "$inline_snapshot" == "0" && -z "$redis_url" ]]; then
    if [[ "$REDIS_MODE" == "auto" || "$REDIS_MODE" == "native" ]]; then
      if command -v systemctl >/dev/null 2>&1; then
        run_root systemctl enable --now redis-server 2>/dev/null || run_root systemctl enable --now redis || true
      elif command -v service >/dev/null 2>&1; then
        run_root service redis-server start 2>/dev/null || run_root service redis start 2>/dev/null || true
      fi
    fi
    redis_url="redis://127.0.0.1:6379"
  fi

  if [[ "$inline_snapshot" == "0" ]] && ! REDIS_URL="$redis_url" node "$PROJECT_ROOT/scripts/verify-redis-endpoint.mjs" >/dev/null 2>&1; then
    [[ "$REDIS_MODE" != "native" ]] || fatal "Native Redis is not reachable"
    [[ -z "${INSTALL_REDIS_URL:-}" && -z "$(env_value REDIS_URL)" ]] || fatal "Configured Redis is not reachable"
    section "npm Redis fallback"
    command -v npm >/dev/null 2>&1 || fatal "npm is required for the local Redis fallback"
    local npm_redis_root="$RUNTIME_DIR/npm-redis"
    if (( REINSTALL == 1 )); then rm -rf -- "$npm_redis_root"; fi
    mkdir -p "$npm_redis_root" "$RUNTIME_DIR/redis-data"
    if [[ ! -f "$npm_redis_root/node_modules/redis-memory-server/package.json" ]]; then
      REDISMS_DISABLE_POSTINSTALL=true npm --cache "$RUNTIME_DIR/npm-cache" --prefix "$npm_redis_root" install --no-save --no-audit --no-fund redis-memory-server@0.17.0 \
        || fatal "Native Redis is unavailable and npm redis-memory-server installation failed"
    fi
    node "$PROJECT_ROOT/scripts/prepare-npm-redis.mjs" "$npm_redis_root/node_modules/redis-memory-server" \
      || fatal "The npm Redis provider has an unsupported compiler layout"
    redis_service_mode="npm"
    redis_url="redis://127.0.0.1:6379"
    upsert_env CTS_REDIS_SERVICE_MODE npm
    upsert_env CTS_NPM_REDIS_ROOT "$npm_redis_root/node_modules"
    upsert_env CTS_REDIS_DATA_DIR "$RUNTIME_DIR/redis-data"
    upsert_env CTS_REDIS_PORT 6379
    upsert_env REDISMS_DOWNLOAD_DIR "$RUNTIME_DIR/redis-binaries"
    node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
      env CTS_NPM_REDIS_ROOT="$npm_redis_root/node_modules" CTS_REDIS_DATA_DIR="$RUNTIME_DIR/redis-data" CTS_REDIS_PORT=6379 REDISMS_DOWNLOAD_DIR="$RUNTIME_DIR/redis-binaries" \
      node "$PROJECT_ROOT/scripts/npm-redis-service.mjs" >"$RUNTIME_DIR/redis.log" 2>&1 &
    echo $! > "$RUNTIME_DIR/redis.pid"
    for _ in {1..30}; do REDIS_URL="$redis_url" node "$PROJECT_ROOT/scripts/verify-redis-endpoint.mjs" >/dev/null 2>&1 && break; sleep 1; done
    REDIS_URL="$redis_url" node "$PROJECT_ROOT/scripts/verify-redis-endpoint.mjs" >/dev/null 2>&1 || fatal "npm Redis service did not become ready"
  fi
  if [[ "$inline_snapshot" == "0" ]] && command -v redis-cli >/dev/null 2>&1; then
    redis-cli -u "$redis_url" --no-auth-warning ping >/dev/null 2>&1 || fatal "Redis verification failed"
  fi
  if [[ "$inline_snapshot" == "0" && "$redis_url" =~ ^redis://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?(/[0-9]+)?/?$ ]]; then
    if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -u "$redis_url" --no-auth-warning CONFIG SET appendonly yes >/dev/null
    redis-cli -u "$redis_url" --no-auth-warning CONFIG SET appendfsync everysec >/dev/null
    redis-cli -u "$redis_url" --no-auth-warning CONFIG SET protected-mode yes >/dev/null
    redis-cli -u "$redis_url" --no-auth-warning CONFIG SET maxmemory-policy noeviction >/dev/null
    redis-cli -u "$redis_url" --no-auth-warning CONFIG SET save "900 1 300 10 60 10000" >/dev/null
    redis-cli -u "$redis_url" --no-auth-warning CONFIG REWRITE >/dev/null 2>&1 || true
    [[ "$(redis-cli -u "$redis_url" --no-auth-warning CONFIG GET appendonly | tail -n 1)" == "yes" ]] \
      || fatal "Local Redis AOF persistence could not be enabled"
    [[ "$(redis-cli -u "$redis_url" --no-auth-warning CONFIG GET appendfsync | tail -n 1)" == "everysec" ]] \
      || fatal "Local Redis AOF fsync policy could not be enabled"
    [[ "$(redis-cli -u "$redis_url" --no-auth-warning CONFIG GET protected-mode | tail -n 1)" == "yes" ]] \
      || fatal "Local Redis protected mode could not be enabled"
    [[ "$(redis-cli -u "$redis_url" --no-auth-warning CONFIG GET maxmemory-policy | tail -n 1)" == "noeviction" ]] \
      || fatal "Local Redis no-eviction policy could not be enabled"
    fi
  fi

  upsert_env NODE_ENV production
  upsert_env HOST 0.0.0.0
  upsert_env PORT "$APP_PORT"
  upsert_env REDIS_URL "$redis_url"
  [[ "$redis_service_mode" == "npm" || "$redis_service_mode" == "inline-snapshot" ]] || upsert_env CTS_REDIS_SERVICE_MODE native
  if [[ "$inline_snapshot" == "1" ]]; then
    upsert_env ALLOW_PROD_INLINE_REDIS 1
    upsert_env DISABLE_IN_PROCESS_CONTINUITY 0
  else
    upsert_env ALLOW_PROD_INLINE_REDIS 0
    upsert_env DISABLE_IN_PROCESS_CONTINUITY 1
  fi
  if (( SAFE_SIMULATION == 1 )); then
    # This mode is intended for a complete long-lived owner/debug deployment.
    # It wins over any preserved settings and credentials, so every exchange
    # connector remains simulated and no real order path can become available
    # after a restart.
    upsert_env ALLOW_INLINE_REDIS_LIVE_TRADING 0
    upsert_env FORCE_SIMULATED 1
    upsert_env FORCE_LIVE 0
    upsert_env ALLOW_PROD_SIMULATED 1
    upsert_env ALLOW_LIVE_ORDER_PLACEMENT 0
    upsert_env CTS_REQUIRE_LIVE_TRADE_READY 0
    upsert_env DISABLE_BINGX_SDK_ORDERS 1
  else
    upsert_env ALLOW_INLINE_REDIS_LIVE_TRADING 1
    # A long-lived Linux install is the authoritative live-order owner. Do not
    # inherit a paper-only flag from a prior preview build: the control-plane
    # still requires credentials, a selected Live mode, a worker lease and a
    # per-request confirmation before any actual exchange call.
    upsert_env FORCE_SIMULATED 0
    upsert_env FORCE_LIVE 1
    upsert_env ALLOW_PROD_SIMULATED 0
    upsert_env ALLOW_LIVE_ORDER_PLACEMENT 1
    upsert_env CTS_REQUIRE_LIVE_TRADE_READY 1
    upsert_env DISABLE_BINGX_SDK_ORDERS 0
  fi
  configure_cpu_parallelism
  configure_memory_watchdog
  upsert_env ENABLE_PRODUCTION_MIGRATIONS 1
  upsert_env AUTO_MIGRATE_ON_STARTUP 1
  [[ "$inline_snapshot" == "1" ]] || upsert_env DISABLE_IN_PROCESS_CONTINUITY 1
  upsert_env DISABLE_TRADE_ENGINE_IN_PROCESS 0
  upsert_env SCHEDULER_BASE_URL "http://127.0.0.1:$APP_PORT"
  upsert_env NEXT_PUBLIC_APP_URL "${NEXT_PUBLIC_APP_URL:-$(env_value NEXT_PUBLIC_APP_URL)}"
  [[ -n "$(env_value NEXT_PUBLIC_APP_URL)" ]] || upsert_env NEXT_PUBLIC_APP_URL "http://127.0.0.1:$APP_PORT"

  local bingx_key="${BINGX_API_KEY:-${BINGX_APIKEY:-$(env_value BINGX_API_KEY)}}"
  local bingx_secret="${BINGX_API_SECRET:-${BINGX_SECRET_KEY:-${BINGX_SECRET:-$(env_value BINGX_API_SECRET)}}}"
  local bingx_vst_key="${BINGX_X02_API_KEY:-$(env_value BINGX_X02_API_KEY)}"
  local bingx_vst_secret="${BINGX_X02_API_SECRET:-$(env_value BINGX_X02_API_SECRET)}"
  local bingx_vst_origin="${BINGX_VST_ORIGIN:-$(env_value BINGX_VST_ORIGIN)}"
  [[ -n "$bingx_vst_origin" ]] || bingx_vst_origin="https://open-api-vst.bingx.com"
  local bingx_environment="${BINGX_ENVIRONMENT:-$(env_value BINGX_ENVIRONMENT)}"
  # New long-lived deployments start on BingX's virtual-funds endpoint.  A
  # real-funds target must always be selected explicitly via prod-live.
  [[ -n "$bingx_environment" ]] || bingx_environment="prod-vst"
  case "${bingx_environment,,}" in
    prod-live|live|mainnet|production)
      bingx_environment="prod-live"
      upsert_env BINGX_PUBLIC_ORIGIN "https://open-api.bingx.com"
      upsert_env BINGX_PUBLIC_FALLBACK_ORIGIN "https://open-api.bingx.pro"
      ;;
    prod-vst|vst|demo|testnet)
      bingx_environment="prod-vst"
      case "$bingx_vst_origin" in
        https://open-api-vst.bingx.com|https://open-api-vst.bingx.pro) ;;
        *) fatal "Unsupported BINGX_VST_ORIGIN '$bingx_vst_origin'; expected official .com or .pro Prod-VST origin" ;;
      esac
      upsert_env BINGX_PUBLIC_ORIGIN "https://open-api-vst.bingx.com"
      upsert_env BINGX_PUBLIC_FALLBACK_ORIGIN "https://open-api-vst.bingx.pro"
      # Authenticated requests are pinned to one explicit host; never retry an
      # ambiguous order write automatically across .com/.pro.
      upsert_env BINGX_VST_ORIGIN "$bingx_vst_origin"
      ;;
    *)
      fatal "Unsupported BINGX_ENVIRONMENT '$bingx_environment'; expected prod-live or prod-vst"
      ;;
  esac
  # This variable is authoritative for the Redis boot repair. Credentials are
  # valid for both environments and must never be used to infer mainnet.
  upsert_env BINGX_ENVIRONMENT "$bingx_environment"
  local bybit_key="${BYBIT_API_KEY:-${BYBIT_APIKEY:-$(env_value BYBIT_API_KEY)}}"
  local bybit_secret="${BYBIT_API_SECRET:-${BYBIT_SECRET_KEY:-${BYBIT_SECRET:-$(env_value BYBIT_API_SECRET)}}}"
  local pionex_key="${PIONEX_API_KEY:-$(env_value PIONEX_API_KEY)}"
  local pionex_secret="${PIONEX_API_SECRET:-$(env_value PIONEX_API_SECRET)}"
  local orangex_key="${ORANGEX_API_KEY:-$(env_value ORANGEX_API_KEY)}"
  local orangex_secret="${ORANGEX_API_SECRET:-$(env_value ORANGEX_API_SECRET)}"
  local live_venues=()
  if ! placeholder_secret "$bingx_key" && ! placeholder_secret "$bingx_secret"; then
    upsert_env BINGX_API_KEY "$bingx_key"
    upsert_env BINGX_API_SECRET "$bingx_secret"
    live_venues+=("BingX X01 Prod-Live")
  fi
  if ! placeholder_secret "$bingx_vst_key" && ! placeholder_secret "$bingx_vst_secret"; then
    upsert_env BINGX_X02_API_KEY "$bingx_vst_key"
    upsert_env BINGX_X02_API_SECRET "$bingx_vst_secret"
    live_venues+=("BingX X02 Prod-VST (virtual funds)")
  fi
  if ! placeholder_secret "$bybit_key" && ! placeholder_secret "$bybit_secret"; then
    upsert_env BYBIT_API_KEY "$bybit_key"
    upsert_env BYBIT_API_SECRET "$bybit_secret"
    live_venues+=("Bybit")
  fi
  if ! placeholder_secret "$pionex_key" && ! placeholder_secret "$pionex_secret"; then
    upsert_env PIONEX_API_KEY "$pionex_key"
    upsert_env PIONEX_API_SECRET "$pionex_secret"
    live_venues+=("Pionex")
  fi
  if ! placeholder_secret "$orangex_key" && ! placeholder_secret "$orangex_secret"; then
    upsert_env ORANGEX_API_KEY "$orangex_key"
    upsert_env ORANGEX_API_SECRET "$orangex_secret"
    live_venues+=("OrangeX")
  fi
  if (( SAFE_SIMULATION == 1 )); then
    ok "Safe simulation mode is active; preserved exchange credentials cannot place orders"
  elif (( ${#live_venues[@]} > 0 )); then
    ok "Authenticated exchange execution is configured for ${live_venues[*]}; readiness is verified without submitting an order"
  else
    fatal "Production server installation requires valid credentials for at least one supported exchange; supply them via --seed-env-file or the existing environment file"
  fi

  local admin_secret cron_secret encryption_key jwt_secret direct_trade_processor_token
  admin_secret="$(env_value ADMIN_SECRET)"; cron_secret="$(env_value CRON_SECRET)"
  encryption_key="$(env_value ENCRYPTION_KEY)"; jwt_secret="$(env_value JWT_SECRET)"
  direct_trade_processor_token="$(env_value DIRECT_TRADE_PROCESSOR_TOKEN)"
  if placeholder_secret "$admin_secret"; then upsert_env ADMIN_SECRET "$(openssl rand -hex 32)"; fi
  if placeholder_secret "$cron_secret"; then upsert_env CRON_SECRET "$(openssl rand -hex 32)"; fi
  if placeholder_secret "$encryption_key"; then upsert_env ENCRYPTION_KEY "$(openssl rand -hex 32)"; fi
  if placeholder_secret "$jwt_secret"; then upsert_env JWT_SECRET "$(openssl rand -hex 32)"; fi
  if placeholder_secret "$direct_trade_processor_token"; then upsert_env DIRECT_TRADE_PROCESSOR_TOKEN "$(openssl rand -hex 32)"; fi
  ok "Network Redis is reachable, AOF/fsync/protected-mode/no-eviction are configured, and secrets/gates are configured"
}

resolve_runtime() {
  if [[ "$RUNTIME" == "auto" ]]; then
    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then RUNTIME="systemd"; else RUNTIME="pm2"; fi
  fi
  upsert_env CTS_DEPLOYMENT_RUNTIME "$RUNTIME"
  ok "Runtime owner: $RUNTIME (one app + one external minute scheduler + one Direct-Trade lease worker)"
}

stop_runtime() {
  touch "$RUNTIME_DIR/maintenance-stop"
  if [[ "$RUNTIME" == "systemd" ]] && command -v systemctl >/dev/null 2>&1; then
    run_root systemctl stop "$APP_NAME-direct-trade" "$APP_NAME-scheduler" "$APP_NAME" "$APP_NAME-redis" 2>/dev/null || true
  elif [[ "$RUNTIME" == "pm2" ]] && command -v pm2 >/dev/null 2>&1; then
    run_as_service pm2 stop "$APP_NAME-direct-trade" "$APP_NAME-scheduler" "$APP_NAME" "$APP_NAME-recovery" "$APP_NAME-redis" >/dev/null 2>&1 || true
  fi
}

start_runtime() {
  rm -f -- "$RUNTIME_DIR/maintenance-stop"
  if [[ "$RUNTIME" == "systemd" ]]; then
    if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then
      run_root systemctl restart "$APP_NAME-redis"
    fi
    run_root systemctl restart "$APP_NAME"
    run_root systemctl reset-failed "$APP_NAME-scheduler" 2>/dev/null || true
    run_root systemctl restart "$APP_NAME-scheduler"
    run_root systemctl reset-failed "$APP_NAME-direct-trade" 2>/dev/null || true
    run_root systemctl restart "$APP_NAME-direct-trade"
    run_root systemctl start "$APP_NAME-recovery.timer" 2>/dev/null || true
  else
    if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then
      run_as_service pm2 restart "$APP_NAME-redis" --update-env >/dev/null 2>&1 || true
    fi
    run_as_service pm2 restart "$APP_NAME" --update-env >/dev/null 2>&1 || true
    run_as_service pm2 restart "$APP_NAME-scheduler" --update-env >/dev/null 2>&1 || true
    run_as_service pm2 restart "$APP_NAME-direct-trade" --update-env >/dev/null 2>&1 || true
    run_as_service pm2 restart "$APP_NAME-recovery" --update-env >/dev/null 2>&1 || true
  fi
}

stage_existing_runtime() {
  section "Existing installation handoff"
  if existing_runtime_active; then
    info "Stopping the existing $APP_NAME service and scheduler before replacement"
    stop_runtime
  else
    info "No active $APP_NAME service was found"
  fi

  # Do not let stale route chunks or a half-written previous output mix with
  # the next build. Keep one recoverable backup until every install, migration,
  # scheduler and restart check has completed successfully.
  if [[ -d "$PROJECT_ROOT/.next" ]]; then
    BUILD_BACKUP="$RUNTIME_DIR/previous-next-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$PROJECT_ROOT/.next" "$BUILD_BACKUP"
    ROLLBACK_ARMED=1
    ok "Stopped existing runtime and staged its production artifact"
  fi
}

install_dependencies_and_validate() {
  section "Locked dependencies and full release validation"
  cd "$PROJECT_ROOT"
  if (( REINSTALL == 1 )); then
    info "--reinstall requested: removing only this checkout's node_modules and reinstalling the lockfile"
    rm -rf -- "$PROJECT_ROOT/node_modules"
    pnpm store prune >/dev/null 2>&1 || true
    pnpm install --frozen-lockfile --force
  else
    pnpm install --frozen-lockfile
  fi
  local next_version react_version
  next_version="$(node -p "require('$PROJECT_ROOT/node_modules/next/package.json').version" 2>/dev/null || true)"
  react_version="$(node -p "require('$PROJECT_ROOT/node_modules/react/package.json').version" 2>/dev/null || true)"
  [[ -n "$next_version" && -n "$react_version" ]] || fatal "Next.js and React are not installed in the locked dependency tree"
  pnpm exec next --version >/dev/null 2>&1 || fatal "Next.js CLI is not usable"
  node -e "const r=require('react'); if(!r||typeof r.createElement!=='function') process.exit(1)" \
    || fatal "React runtime is not usable"
  ok "Application dependencies: Next.js $next_version and React $react_version"
  pnpm exec tsc --noEmit
  pnpm exec eslint .
  if (( SKIP_TESTS == 0 )); then
    pnpm exec jest --runInBand --detectOpenHandles --passWithNoTests
  else
    warn "Jest was explicitly skipped"
  fi

  mkdir -p "$RUNTIME_DIR"
  # Turbopack in Next 15.3+ expects server-external-packages.jsonc but pnpm
  # hoisting only provides server-external-packages.json. Ensure the .jsonc file
  # exists to avoid build failures.
  node "$PROJECT_ROOT/scripts/prepare-turbopack.mjs" 2>/dev/null || true
  if ! node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- pnpm run build; then
    [[ -z "$BUILD_BACKUP" || ! -d "$BUILD_BACKUP" ]] || mv "$BUILD_BACKUP" "$PROJECT_ROOT/.next"
    ROLLBACK_ARMED=0
    start_runtime || true
    fatal "Production build failed; previous build restored"
  fi
  [[ -f "$PROJECT_ROOT/.next/BUILD_ID" ]] || fatal "Production build did not create BUILD_ID"
  ok "All static checks/tests and the optimized production build passed"
}

write_install_values() {
  local values_file="$RUNTIME_DIR/install-values.env" repository branch
  repository="$(git -C "$PROJECT_ROOT" remote get-url origin 2>/dev/null || true)"
  branch="$(git -C "$PROJECT_ROOT" symbolic-ref --short HEAD 2>/dev/null || true)"
  repository="${repository//$'\n'/}"
  branch="${branch//$'\n'/}"
  cat > "$values_file" <<EOF
# Generated by scripts/install.sh. Used by scripts/start.sh and scripts/stop.sh.
CTS_INSTALLED_APP_NAME=$APP_NAME
CTS_INSTALLED_APP_PORT=$APP_PORT
CTS_INSTALLED_RUNTIME=$RUNTIME
CTS_INSTALLED_SERVICE_USER=$SERVICE_USER
CTS_INSTALLED_PROJECT_ROOT=$PROJECT_ROOT
CTS_INSTALLED_ENV_FILE=$ENV_FILE
CTS_INSTALLED_ENV_MANAGED=$ENV_FILE_MANAGED
CTS_INSTALLED_REPOSITORY=$repository
CTS_INSTALLED_BRANCH=$branch
EOF
  if (( SERVICE_USER_CREATED == 1 )); then
    printf '%s\n' "$SERVICE_USER" > "$RUNTIME_DIR/managed-service-user"
    chmod 600 "$RUNTIME_DIR/managed-service-user"
  elif [[ -f "$RUNTIME_DIR/managed-service-user" ]] \
    && [[ "$(<"$RUNTIME_DIR/managed-service-user")" != "$SERVICE_USER" ]]; then
    rm -f -- "$RUNTIME_DIR/managed-service-user"
  fi
  chmod 640 "$values_file"
  ok "Recorded installed service defaults in $values_file"
}

write_runtime_wrappers() {
  local bun_bin node_bin app_heap_mb scheduler_heap_mb direct_trade_heap_mb
  bun_bin="/usr/local/bin/bun"
  [[ -x "$bun_bin" ]] || bun_bin="$(command -v bun)"
  node_bin="$(command -v node)"
  app_heap_mb="$(env_value CTS_NODE_HEAP_MB)"
  scheduler_heap_mb="$(env_value CTS_SCHEDULER_NODE_HEAP_MB)"
  direct_trade_heap_mb="$(env_value CTS_DIRECT_TRADE_NODE_HEAP_MB)"
  [[ "$app_heap_mb" =~ ^[0-9]+$ ]] || app_heap_mb=1024
  [[ "$scheduler_heap_mb" =~ ^[0-9]+$ ]] || scheduler_heap_mb=256
  [[ "$direct_trade_heap_mb" =~ ^[0-9]+$ ]] || direct_trade_heap_mb=256
  cat > "$RUNTIME_DIR/start-app.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
exec env NODE_OPTIONS="--max-old-space-size=$app_heap_mb --max-semi-space-size=128 --expose-gc" ${bun_bin@Q} scripts/run-with-env.mjs ${ENV_FILE@Q} -- ${node_bin@Q} scripts/start-production.mjs
EOF
  cat > "$RUNTIME_DIR/start-scheduler.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
exec env NODE_OPTIONS="--max-old-space-size=$scheduler_heap_mb --max-semi-space-size=64" ${node_bin@Q} scripts/run-with-env.mjs ${ENV_FILE@Q} -- ${node_bin@Q} scripts/run-minute-scheduler.mjs
EOF
  cat > "$RUNTIME_DIR/start-direct-trade.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
exec env NODE_OPTIONS="--max-old-space-size=128 --max-semi-space-size=32" ${node_bin@Q} scripts/run-with-env.mjs ${ENV_FILE@Q} -- ${node_bin@Q} scripts/direct-trade-supervisor.mjs --port ${APP_PORT@Q}
EOF
  cat > "$RUNTIME_DIR/start-recovery.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
while true; do
  "$PROJECT_ROOT/scripts/runtime-recovery.sh" --name "$APP_NAME" --port "$APP_PORT" --runtime-dir "$RUNTIME_DIR" --runtime "$RUNTIME" --service-user "$SERVICE_USER" || true
  sleep 60
done
EOF
  chmod 750 "$RUNTIME_DIR/start-app.sh" "$RUNTIME_DIR/start-scheduler.sh" "$RUNTIME_DIR/start-direct-trade.sh" "$RUNTIME_DIR/start-recovery.sh"
  if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then
    cat > "$RUNTIME_DIR/start-redis.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
exec ${node_bin@Q} ${PROJECT_ROOT@Q}/scripts/npm-redis-service.mjs
EOF
    chmod 750 "$RUNTIME_DIR/start-redis.sh"
  fi
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
  # lib must stay group-readable: the Direct-Trade processor service imports
  # lib/*.cjs helpers directly (not through the standalone Next build), so the
  # service user needs read/traverse access to the whole directory.
  # Next's production runtime still loads tsconfig.json to resolve project
  # aliases. Keep it readable by the service identity as well; otherwise the
  # app starts but emits EACCES on every type-config lookup after a clean
  # installer run with a restrictive umask.
  for runtime_path in node_modules .next scripts lib package.json tsconfig.json pnpm-lock.yaml pnpm-workspace.yaml next.config.js next.config.mjs next.config.ts; do
    [[ -e "$PROJECT_ROOT/$runtime_path" ]] || continue
    run_root chown -R "$install_owner:$service_group" "$PROJECT_ROOT/$runtime_path"
    run_root chmod -R g+rX "$PROJECT_ROOT/$runtime_path"
  done
  run_root chmod 750 "$PROJECT_ROOT/scripts/runtime-recovery.sh" "$PROJECT_ROOT/scripts/service-control.sh" "$PROJECT_ROOT/scripts/start.sh" "$PROJECT_ROOT/scripts/stop.sh" "$PROJECT_ROOT/scripts/restart.sh"
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
  run_as_service test -r "$PROJECT_ROOT/tsconfig.json" || fatal "Service user cannot read tsconfig.json"
  run_as_service test -x "$RUNTIME_DIR/start-app.sh" || fatal "Service user cannot execute the app wrapper"
  run_as_service test -x "$RUNTIME_DIR/start-direct-trade.sh" || fatal "Service user cannot execute the Direct-Trade wrapper"
  run_as_service test -x "$RUNTIME_DIR/start-recovery.sh" || fatal "Service user cannot execute the recovery wrapper"
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
  local direct_trade_unit="/etc/systemd/system/$APP_NAME-direct-trade.service"
  local recovery_unit="/etc/systemd/system/$APP_NAME-recovery.service"
  local recovery_timer="/etc/systemd/system/$APP_NAME-recovery.timer"
  local redis_unit="/etc/systemd/system/$APP_NAME-redis.service"
  local runtime_high_mb runtime_max_mb scheduler_max_mb direct_trade_max_mb
  runtime_high_mb="$(env_value CTS_RUNTIME_MEMORY_HIGH_MB)"
  runtime_max_mb="$(env_value CTS_RUNTIME_MEMORY_MAX_MB)"
  [[ "$runtime_high_mb" =~ ^[0-9]+$ ]] || runtime_high_mb=768
  [[ "$runtime_max_mb" =~ ^[0-9]+$ ]] || runtime_max_mb=1024
  (( runtime_max_mb > runtime_high_mb )) || runtime_max_mb=$(( runtime_high_mb + 128 ))
  scheduler_max_mb="$(env_value CTS_SCHEDULER_MEMORY_MAX_MB)"
  direct_trade_max_mb="$(env_value CTS_DIRECT_TRADE_MEMORY_MAX_MB)"
  [[ "$scheduler_max_mb" =~ ^[0-9]+$ ]] || scheduler_max_mb=384
  [[ "$direct_trade_max_mb" =~ ^[0-9]+$ ]] || direct_trade_max_mb=384

  if [[ -f "$RUNTIME_DIR/redis.pid" ]]; then
    local bootstrap_pid
    bootstrap_pid="$(cat "$RUNTIME_DIR/redis.pid" 2>/dev/null || true)"
    if [[ "$bootstrap_pid" =~ ^[0-9]+$ ]] && kill -0 "$bootstrap_pid" 2>/dev/null; then
      kill "$bootstrap_pid" 2>/dev/null || true
      for _ in {1..20}; do kill -0 "$bootstrap_pid" 2>/dev/null || break; sleep 0.25; done
    fi
    rm -f -- "$RUNTIME_DIR/redis.pid"
  fi

  if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then
    run_root tee "$redis_unit" >/dev/null <<EOF
[Unit]
Description=CTS-K-N local Redis compatibility service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_ROOT
EnvironmentFile=$ENV_FILE
Environment=CTS_NPM_REDIS_ROOT=$RUNTIME_DIR/npm-redis/node_modules
Environment=CTS_REDIS_DATA_DIR=$RUNTIME_DIR/redis-data
Environment=CTS_REDIS_PORT=6379
Environment=REDISMS_DOWNLOAD_DIR=$RUNTIME_DIR/redis-binaries
ExecStart=$RUNTIME_DIR/start-redis.sh
Restart=always
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  else
    # A previous npm-Redis install may have left an enabled compatibility unit.
    # Remove that exact app-owned unit when the new environment uses native or
    # external Redis so it cannot return after reboot and contend for the port.
    run_root systemctl disable --now "$APP_NAME-redis" 2>/dev/null || true
    run_root rm -f -- "$redis_unit"
  fi

  run_root tee "$app_unit" >/dev/null <<EOF
[Unit]
Description=CTS-K-N production application and trade-engine owner
After=network-online.target redis-server.service redis.service $APP_NAME-redis.service
Wants=network-online.target
$(if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then printf 'Requires=%s-redis.service\n' "$APP_NAME"; fi)

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
MemoryHigh=${runtime_high_mb}M
MemoryMax=${runtime_max_mb}M

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
MemoryMax=${scheduler_max_mb}M

[Install]
WantedBy=multi-user.target
EOF

  run_root tee "$direct_trade_unit" >/dev/null <<EOF
[Unit]
Description=CTS-K-N Direct-Trade leased processor
After=network-online.target $APP_NAME.service
Requires=$APP_NAME.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_ROOT
ExecStart=$RUNTIME_DIR/start-direct-trade.sh
Restart=always
RestartSec=5
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true
MemoryMax=${direct_trade_max_mb}M

[Install]
WantedBy=multi-user.target
EOF
  run_root tee "$recovery_unit" >/dev/null <<EOF
[Unit]
Description=CTS-K-N coordinated runtime recovery check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
WorkingDirectory=$PROJECT_ROOT
ExecStart=$PROJECT_ROOT/scripts/runtime-recovery.sh --name $APP_NAME --port $APP_PORT --runtime-dir $RUNTIME_DIR --runtime systemd --service-user $SERVICE_USER
TimeoutStartSec=25
EOF
  run_root tee "$recovery_timer" >/dev/null <<EOF
[Unit]
Description=CTS-K-N minute recovery timer

[Timer]
# Deployment and installer lifecycles can restart this timer long after the
# host booted. OnBootSec is already elapsed in that case and leaves an active
# timer with no next trigger; OnActiveSec always arms the first recovery pass.
OnActiveSec=2min
OnUnitActiveSec=60s
Persistent=true
Unit=$APP_NAME-recovery.service

[Install]
WantedBy=timers.target
EOF
  run_root systemctl daemon-reload
  if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then
    run_root systemctl enable "$APP_NAME-redis"
    run_root systemctl restart "$APP_NAME-redis"
  fi
  run_root systemctl enable "$APP_NAME" "$APP_NAME-scheduler" "$APP_NAME-direct-trade" "$APP_NAME-recovery.timer"
  run_root systemctl restart "$APP_NAME"
  run_root systemctl reset-failed "$APP_NAME-scheduler" 2>/dev/null || true
  run_root systemctl restart "$APP_NAME-scheduler"
  run_root systemctl reset-failed "$APP_NAME-direct-trade" 2>/dev/null || true
  run_root systemctl restart "$APP_NAME-direct-trade"
  run_root systemctl start "$APP_NAME-recovery.timer"
  ok "systemd services and minute recovery timer enabled for boot and restart continuity"
}

install_pm2_runtime() {
  section "PM2 app and minute-scheduler processes"
  if (( REINSTALL == 1 )) || ! command -v pm2 >/dev/null 2>&1; then
    run_root npm install -g pm2 --no-audit --no-fund --loglevel=error
  fi
  local home runtime_max_mb scheduler_max_mb direct_trade_max_mb
  home="$(service_home)"
  # NOTE: PM2's --max-memory-restart is measured against RSS, while
  # lib/startup-coordinator.ts configures the in-process memory manager's
  # soft-warning ceiling against V8 heapUsed (2048MB in production). RSS is
  # always >= heapUsed (native buffers, sockets, Redis client, BingX HTTP
  # keep-alives all add on top of the heap), so a 1024MB PM2 ceiling
  # guarantees PM2 hard-kills and restarts the app long before the app's own
  # memory management ever gets a chance to warn or GC. That mismatch was the
  # root cause of the process "regularly restarting" in production. Default
  # to 2560MB (2048MB heap ceiling + ~512MB RSS overhead headroom) so PM2 only
  # intervenes as a true last resort, and keep it operator-configurable.
  runtime_max_mb="$(env_value CTS_RUNTIME_MEMORY_MAX_MB)"
  [[ "$runtime_max_mb" =~ ^[0-9]+$ ]] || runtime_max_mb=2560
  scheduler_max_mb="$(env_value CTS_SCHEDULER_MEMORY_MAX_MB)"
  direct_trade_max_mb="$(env_value CTS_DIRECT_TRADE_MEMORY_MAX_MB)"
  [[ "$scheduler_max_mb" =~ ^[0-9]+$ ]] || scheduler_max_mb=384
  [[ "$direct_trade_max_mb" =~ ^[0-9]+$ ]] || direct_trade_max_mb=384
  if [[ -f "$RUNTIME_DIR/redis.pid" ]]; then
    local bootstrap_pid
    bootstrap_pid="$(cat "$RUNTIME_DIR/redis.pid" 2>/dev/null || true)"
    if [[ "$bootstrap_pid" =~ ^[0-9]+$ ]] && kill -0 "$bootstrap_pid" 2>/dev/null; then
      kill "$bootstrap_pid" 2>/dev/null || true
      for _ in {1..20}; do kill -0 "$bootstrap_pid" 2>/dev/null || break; sleep 0.25; done
    fi
    rm -f -- "$RUNTIME_DIR/redis.pid"
  fi
  run_root install -d -m 0750 -o "$SERVICE_USER" -g "$(id -gn "$SERVICE_USER")" "$home" "$home/.pm2"
  run_as_service pm2 delete "$APP_NAME" "$APP_NAME-scheduler" "$APP_NAME-direct-trade" "$APP_NAME-recovery" "$APP_NAME-redis" >/dev/null 2>&1 || true
  if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then
    run_as_service pm2 start "$RUNTIME_DIR/start-redis.sh" --name "$APP_NAME-redis" --time --restart-delay 3000
  fi
  run_as_service pm2 start "$RUNTIME_DIR/start-app.sh" --name "$APP_NAME" --time --restart-delay 5000 --max-memory-restart "${runtime_max_mb}M"
  run_as_service pm2 start "$RUNTIME_DIR/start-scheduler.sh" --name "$APP_NAME-scheduler" --time --restart-delay 5000 --max-memory-restart "${scheduler_max_mb}M"
  run_as_service pm2 start "$RUNTIME_DIR/start-direct-trade.sh" --name "$APP_NAME-direct-trade" --time --restart-delay 5000 --max-memory-restart "${direct_trade_max_mb}M"
  run_as_service pm2 start "$RUNTIME_DIR/start-recovery.sh" --name "$APP_NAME-recovery" --time --restart-delay 5000
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

public_access_url() {
  local configured host
  configured="$(env_value PUBLIC_ACCESS_URL)"
  [[ -n "$configured" ]] && { printf '%s' "${configured%/}"; return; }
  configured="$(env_value NEXT_PUBLIC_APP_URL)"
  if [[ -n "$configured" && ! "$configured" =~ ^https?://(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|/|$) ]]; then
    printf '%s' "${configured%/}"; return
  fi
  host="$(hostname -I 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i !~ /^127\./ && $i !~ /:/) {print $i; exit}}')"
  [[ -n "$host" ]] && printf 'http://%s:%s' "$host" "$APP_PORT" || printf 'http://127.0.0.1:%s' "$APP_PORT"
}

verify_and_restart() {
  section "Migrations, scheduler, persistence, and restart recovery"
  local base_url="http://127.0.0.1:$APP_PORT" before_id after_id
  wait_for_health 90 || return 1

  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env REQUIRE_SHARED_PERSISTENCE="$([[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "inline-snapshot" ]] && echo 0 || echo 1)" DEPLOYMENT_URL="$base_url" node "$PROJECT_ROOT/scripts/production-deploy-init.mjs" \
    || return 1
  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env NODE_ENV=production SCHEDULER_BASE_URL="$base_url" \
    node "$PROJECT_ROOT/scripts/run-minute-scheduler.mjs" --once \
    || return 1
  before_id="$(site_instance_id)" || return 1

  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env REQUIRE_SHARED_PERSISTENCE="$([[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "inline-snapshot" ]] && echo 0 || echo 1)" REQUIRE_FRESH_CONTINUITY=1 DEPLOYMENT_URL="$base_url" \
    bash "$PROJECT_ROOT/scripts/post-deploy-verify.sh" \
    || return 1

  start_runtime || return 1
  wait_for_health 90 || return 1
  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env NODE_ENV=production SCHEDULER_BASE_URL="$base_url" \
    node "$PROJECT_ROOT/scripts/run-minute-scheduler.mjs" --once \
    || return 1
  after_id="$(site_instance_id)" || return 1
  if [[ -n "$before_id" && "$before_id" == "$after_id" ]]; then
    ok "Durable site identity survived restart"
  else
    warn "Site identity changed after restart (previous=${before_id:-"(empty)"} current=${after_id:-"(empty)"})"
    return 1
  fi
  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env REQUIRE_SHARED_PERSISTENCE="$([[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "inline-snapshot" ]] && echo 0 || echo 1)" REQUIRE_FRESH_CONTINUITY=1 DEPLOYMENT_URL="$base_url" \
    bash "$PROJECT_ROOT/scripts/post-deploy-verify.sh" \
    || return 1

  if [[ "$RUNTIME" == "systemd" ]]; then
    run_root systemctl is-active --quiet "$APP_NAME" && run_root systemctl is-active --quiet "$APP_NAME-scheduler" \
      && run_root systemctl is-active --quiet "$APP_NAME-direct-trade" && run_root systemctl is-active --quiet "$APP_NAME-recovery.timer" || return 1
  else
    run_as_service pm2 describe "$APP_NAME" >/dev/null && run_as_service pm2 describe "$APP_NAME-scheduler" >/dev/null \
      && run_as_service pm2 describe "$APP_NAME-direct-trade" >/dev/null && run_as_service pm2 describe "$APP_NAME-recovery" >/dev/null || return 1
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
ensure_python_pip_and_bun
mkdir -p "$RUNTIME_DIR"
configure_environment_and_redis
resolve_runtime
stage_existing_runtime
install_dependencies_and_validate
write_install_values
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
ok "Project $APP_NAME is ready locally at http://127.0.0.1:$APP_PORT"
ok "Public access URL: $(public_access_url)"
ok "Schema, shared Redis, one-minute continuity, engine ownership, and restart persistence are verified"
info "App service: $APP_NAME"
info "Scheduler service: $APP_NAME-scheduler"
info "Direct-Trade processor service: $APP_NAME-direct-trade"
info "Environment: $ENV_FILE (owner/group-only; secrets were not printed)"
info "Live exchange execution is credentialed and verified; order placement remains controlled by the explicit live-control state."
