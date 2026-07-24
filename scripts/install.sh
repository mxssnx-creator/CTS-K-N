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
SERVICE_USER_CREATED=0
DEFAULT_PASSWORD="${CTS_INSTALL_DEFAULT_PASSWORD:-00998877}"
SAVED_APP_NAME=""
SAVED_APP_PORT=""
SAVED_RUNTIME=""
SAVED_SERVICE_USER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version" 2>/dev/null || true)"
[[ "$PACKAGE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || PACKAGE_VERSION="0.1.1"
DEFAULT_PROJECT_NAME="ctsv$PACKAGE_VERSION"
[[ -n "$APP_NAME" ]] || APP_NAME="$DEFAULT_PROJECT_NAME"
[[ -n "$APP_PORT" ]] || APP_PORT="3002"
ENV_FILE="$PROJECT_ROOT/.env.production.local"
RUNTIME_DIR="$PROJECT_ROOT/.cts-runtime"
BUILD_BACKUP=""
ROLLBACK_ARMED=0
ROLLBACK_RUNNING=0

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh [PROJECT_NAME] [PORT] [options]

Options:
  --name NAME             Service/process name (default: ctsv<package-version>)
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
  --uninstall             Stop/remove CTS services, CTS-owned runtime data, and this checkout
  --help                  Show this help

Sensitive values should be supplied in --seed-env-file or the existing env
file, never as command-line arguments. The installer generates ADMIN_SECRET,
CRON_SECRET, ENCRYPTION_KEY, and JWT_SECRET when they are absent, but never
enables FORCE_LIVE automatically.
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
    --env-file) ENV_FILE="${2:?--env-file requires a value}"; shift 2 ;;
    --seed-env-file) SEED_ENV_FILE="${2:?--seed-env-file requires a value}"; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --skip-system-packages) SKIP_SYSTEM_PACKAGES=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --redis-mode) REDIS_MODE="${2:?--redis-mode requires a value}"; shift 2 ;;
    --reinstall) REINSTALL=1; shift ;;
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
    esac
  done < "$values_file"
}

# A repeat install must target the already installed service even when the
# operator omits --name/--port. Explicit command-line values always win.
load_installed_defaults

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
  APP_NAME="$SAVED_APP_NAME"
  [[ "$SAVED_APP_PORT" =~ ^[0-9]+$ ]] && APP_PORT="$SAVED_APP_PORT"
  [[ "$SAVED_RUNTIME" =~ ^(systemd|pm2)$ ]] && RUNTIME="$SAVED_RUNTIME"
  [[ "$SAVED_SERVICE_USER" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]] && SERVICE_USER="$SAVED_SERVICE_USER"
elif (( APP_NAME_SET == 1 )) && [[ -n "$SAVED_APP_NAME" && "$SAVED_APP_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ && "$APP_NAME" != "$SAVED_APP_NAME" ]]; then
  fatal "This checkout is installed as '$SAVED_APP_NAME'; use bootstrap-install.sh to replace it under a new --name safely"
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
    run_root systemctl disable --now "$APP_NAME" "$APP_NAME-scheduler" "$APP_NAME-redis" 2>/dev/null || true
    run_root rm -f -- "/etc/systemd/system/$APP_NAME.service" "/etc/systemd/system/$APP_NAME-scheduler.service" "/etc/systemd/system/$APP_NAME-redis.service"
    run_root systemctl daemon-reload 2>/dev/null || true
    run_root systemctl reset-failed "$APP_NAME" "$APP_NAME-scheduler" "$APP_NAME-redis" 2>/dev/null || true
  fi
  if command -v pm2 >/dev/null 2>&1 && id "$SERVICE_USER" >/dev/null 2>&1; then
    run_as_service pm2 delete "$APP_NAME" "$APP_NAME-scheduler" "$APP_NAME-redis" >/dev/null 2>&1 || true
    run_as_service pm2 save --force >/dev/null 2>&1 || true
  fi

  # Redis, Node, pnpm, and Bun can be shared by unrelated applications. Remove
  # only CTS units/data and leave the shared runtime and external Redis keys intact.
  cd /
  run_root rm -rf -- "$PROJECT_ROOT"
  if (( remove_service_user == 1 )) && id "$SERVICE_USER" >/dev/null 2>&1; then
    run_root userdel --remove "$SERVICE_USER" 2>/dev/null || run_root userdel "$SERVICE_USER" || true
    ok "Removed CTS-managed service user: $SERVICE_USER"
  fi
  ok "Removed CTS services and checkout: $PROJECT_ROOT"
  info "Shared Bun/Node/Redis installations and externally managed Redis data were preserved."
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

  for file in package.json pnpm-lock.yaml pnpm-workspace.yaml scripts/run-minute-scheduler.mjs scripts/run-with-env.mjs scripts/start-production.mjs scripts/prepare-standalone-assets.mjs scripts/start.sh scripts/stop.sh scripts/restart.sh scripts/service-control.sh scripts/post-deploy-verify.sh scripts/production-deploy-init.mjs; do
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
    if command -v chpasswd >/dev/null 2>&1; then
      printf '%s:%s\n' "$SERVICE_USER" "$DEFAULT_PASSWORD" | run_root chpasswd
    fi
    ok "Created system service user: $SERVICE_USER"
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
    run_root chmod -R a+rX "$bun_install_dir"
  fi
  [[ -x "$global_bun" ]] || fatal "Global Bun is missing after installation"
  run_as_service "$global_bun" --version >/dev/null 2>&1 || fatal "The service user cannot execute global Bun"
  ok "Global Bun $($global_bun --version)"
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

configure_cpu_parallelism() {
  # CTS uses bounded symbol/config worker pools. Keep one process as the
  # authoritative engine owner (multiple independent engine processes would
  # duplicate exchange orders), but size the safe pools and Node's libuv pool
  # from the host's actual CPU capacity so production does not remain pinned
  # to the old single-worker defaults.
  local cpu_count=1 io_pool symbol_pool historic_pool
  if command -v nproc >/dev/null 2>&1; then
    cpu_count="$(nproc 2>/dev/null || printf '1')"
  elif [[ -r /proc/cpuinfo ]]; then
    cpu_count="$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || printf '1')"
  fi
  [[ "$cpu_count" =~ ^[0-9]+$ ]] || cpu_count=1
  (( cpu_count > 0 )) || cpu_count=1

  io_pool=$(( cpu_count * 2 ))
  (( io_pool < 4 )) && io_pool=4
  (( io_pool > 32 )) && io_pool=32
  symbol_pool=$(( cpu_count > 1 ? cpu_count - 1 : 1 ))
  # Keep one process as the engine owner, but allow bounded async pools to use
  # more host CPUs. Eight is the service safety ceiling; explicit env values
  # remain authoritative when operators need tighter limits.
  (( symbol_pool > 8 )) && symbol_pool=8
  (( symbol_pool < 1 )) && symbol_pool=1
  historic_pool=$symbol_pool

  [[ -n "$(env_value CTS_CPU_COUNT)" ]] || upsert_env CTS_CPU_COUNT "$cpu_count"
  [[ -n "$(env_value UV_THREADPOOL_SIZE)" ]] || upsert_env UV_THREADPOOL_SIZE "$io_pool"
  [[ -n "$(env_value ENGINE_SYMBOL_CONCURRENCY)" ]] || upsert_env ENGINE_SYMBOL_CONCURRENCY "$symbol_pool"
  [[ -n "$(env_value REALTIME_SYMBOL_CONCURRENCY)" ]] || upsert_env REALTIME_SYMBOL_CONCURRENCY "$symbol_pool"
  [[ -n "$(env_value PREHISTORIC_SYMBOL_CONCURRENCY)" ]] || upsert_env PREHISTORIC_SYMBOL_CONCURRENCY "$historic_pool"
  [[ -n "$(env_value STRATEGY_FLOW_SYMBOL_CONCURRENCY)" ]] || upsert_env STRATEGY_FLOW_SYMBOL_CONCURRENCY "$symbol_pool"
  [[ -n "$(env_value PRESET_SYMBOL_CONCURRENCY)" ]] || upsert_env PRESET_SYMBOL_CONCURRENCY "$symbol_pool"
  ok "CPU parallelism: ${cpu_count} cores, ${symbol_pool} symbol workers, libuv pool ${io_pool}"
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
  upsert_env ALLOW_INLINE_REDIS_LIVE_TRADING 0
  configure_cpu_parallelism
  upsert_env ENABLE_PRODUCTION_MIGRATIONS 1
  upsert_env AUTO_MIGRATE_ON_STARTUP 1
  [[ "$inline_snapshot" == "1" ]] || upsert_env DISABLE_IN_PROCESS_CONTINUITY 1
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
  ok "Network Redis is reachable, AOF/fsync/protected-mode/no-eviction are configured, and secrets/gates are configured"
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
    run_root systemctl stop "$APP_NAME-scheduler" "$APP_NAME" "$APP_NAME-redis" 2>/dev/null || true
  elif [[ "$RUNTIME" == "pm2" ]] && command -v pm2 >/dev/null 2>&1; then
    run_as_service pm2 stop "$APP_NAME-scheduler" "$APP_NAME" "$APP_NAME-redis" >/dev/null 2>&1 || true
  fi
}

start_runtime() {
  if [[ "$RUNTIME" == "systemd" ]]; then
    if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then
      run_root systemctl restart "$APP_NAME-redis"
    fi
    run_root systemctl restart "$APP_NAME"
    run_root systemctl restart "$APP_NAME-scheduler"
  else
    if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then
      run_as_service pm2 restart "$APP_NAME-redis" --update-env >/dev/null 2>&1 || true
    fi
    run_as_service pm2 restart "$APP_NAME" --update-env >/dev/null 2>&1 || true
    run_as_service pm2 restart "$APP_NAME-scheduler" --update-env >/dev/null 2>&1 || true
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
  local values_file="$RUNTIME_DIR/install-values.env"
  cat > "$values_file" <<EOF
# Generated by scripts/install.sh. Used by scripts/start.sh and scripts/stop.sh.
CTS_INSTALLED_APP_NAME=$APP_NAME
CTS_INSTALLED_APP_PORT=$APP_PORT
CTS_INSTALLED_RUNTIME=$RUNTIME
CTS_INSTALLED_SERVICE_USER=$SERVICE_USER
CTS_INSTALLED_PROJECT_ROOT=$PROJECT_ROOT
EOF
  if (( SERVICE_USER_CREATED == 1 )); then
    printf '%s\n' "$SERVICE_USER" > "$RUNTIME_DIR/managed-service-user"
    chmod 600 "$RUNTIME_DIR/managed-service-user"
  fi
  chmod 640 "$values_file"
  ok "Recorded installed service defaults in $values_file"
}

write_runtime_wrappers() {
  local bun_bin node_bin
  bun_bin="/usr/local/bin/bun"
  [[ -x "$bun_bin" ]] || bun_bin="$(command -v bun)"
  node_bin="$(command -v node)"
  cat > "$RUNTIME_DIR/start-app.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
exec ${bun_bin@Q} scripts/run-with-env.mjs ${ENV_FILE@Q} -- ${node_bin@Q} scripts/start-production.mjs
EOF
  cat > "$RUNTIME_DIR/start-scheduler.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
exec ${node_bin@Q} scripts/run-with-env.mjs ${ENV_FILE@Q} -- ${node_bin@Q} scripts/run-minute-scheduler.mjs
EOF
  chmod 750 "$RUNTIME_DIR/start-app.sh" "$RUNTIME_DIR/start-scheduler.sh"
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
  for runtime_path in node_modules .next scripts package.json pnpm-lock.yaml pnpm-workspace.yaml next.config.js next.config.mjs next.config.ts; do
    [[ -e "$PROJECT_ROOT/$runtime_path" ]] || continue
    run_root chown -R "$install_owner:$service_group" "$PROJECT_ROOT/$runtime_path"
    run_root chmod -R g+rX "$PROJECT_ROOT/$runtime_path"
  done
  run_root chmod 750 "$PROJECT_ROOT/scripts/service-control.sh" "$PROJECT_ROOT/scripts/start.sh" "$PROJECT_ROOT/scripts/stop.sh" "$PROJECT_ROOT/scripts/restart.sh"
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
  local redis_unit="/etc/systemd/system/$APP_NAME-redis.service"

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
  if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then
    run_root systemctl enable "$APP_NAME-redis"
    run_root systemctl restart "$APP_NAME-redis"
  fi
  run_root systemctl enable "$APP_NAME" "$APP_NAME-scheduler"
  run_root systemctl restart "$APP_NAME"
  run_root systemctl restart "$APP_NAME-scheduler"
  ok "systemd services enabled for boot and restart-always continuity"
}

install_pm2_runtime() {
  section "PM2 app and minute-scheduler processes"
  if (( REINSTALL == 1 )) || ! command -v pm2 >/dev/null 2>&1; then
    run_root npm install -g pm2 --no-audit --no-fund --loglevel=error
  fi
  local home
  home="$(service_home)"
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
  run_as_service pm2 delete "$APP_NAME" "$APP_NAME-scheduler" "$APP_NAME-redis" >/dev/null 2>&1 || true
  if [[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "npm" ]]; then
    run_as_service pm2 start "$RUNTIME_DIR/start-redis.sh" --name "$APP_NAME-redis" --time --restart-delay 3000
  fi
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
    env REQUIRE_SHARED_PERSISTENCE="$([[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "inline-snapshot" ]] && echo 0 || echo 1)" DEPLOYMENT_URL="$base_url" node "$PROJECT_ROOT/scripts/production-deploy-init.mjs"
  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env NODE_ENV=production SCHEDULER_BASE_URL="$base_url" \
    node "$PROJECT_ROOT/scripts/run-minute-scheduler.mjs" --once
  before_id="$(site_instance_id)"

  node "$PROJECT_ROOT/scripts/run-with-env.mjs" "$ENV_FILE" -- \
    env REQUIRE_SHARED_PERSISTENCE="$([[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "inline-snapshot" ]] && echo 0 || echo 1)" REQUIRE_FRESH_CONTINUITY=1 DEPLOYMENT_URL="$base_url" \
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
    env REQUIRE_SHARED_PERSISTENCE="$([[ "$(env_value CTS_REDIS_SERVICE_MODE)" == "inline-snapshot" ]] && echo 0 || echo 1)" REQUIRE_FRESH_CONTINUITY=1 DEPLOYMENT_URL="$base_url" \
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
info "Environment: $ENV_FILE (owner/group-only; secrets were not printed)"
warn "Real exchange order placement remains disabled until the operator explicitly enables the hardened live gates."
