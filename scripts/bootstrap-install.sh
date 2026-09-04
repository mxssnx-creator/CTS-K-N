#!/usr/bin/env bash
# Resolve, replace, install, or uninstall one exact CTS-K-N server checkout.

set -Eeuo pipefail
umask 027

REPOSITORY="${CTS_REPOSITORY:-https://github.com/mxssnx-creator/CTS-K-N.git}"
BRANCH="${CTS_BRANCH:-main}"
INSTALL_DIR="${CTS_INSTALL_DIR:-}"
PROJECT_NAME="${CTS_PROJECT_NAME:-}"
PORT="${CTS_PORT:-3002}"
RUNTIME="${CTS_RUNTIME:-auto}"
SERVICE_USER="${CTS_SERVICE_USER:-}"
ENV_FILE="${CTS_ENV_FILE:-}"
STATE_DIR="${CTS_STATE_DIR:-}"
REDIS_DB="${CTS_REDIS_DB:-}"
REDIS_PORT="${CTS_REDIS_PORT:-}"
REDIS_MODE="${CTS_REDIS_MODE:-}"
SEED_ENV_FILE=""
PUBLIC_URL="${CTS_PUBLIC_URL:-${NEXT_PUBLIC_APP_URL:-}}"
INSTALL_SEARCH_ROOT="${CTS_INSTALL_SEARCH_ROOT:-/opt}"
INSTALL_DIR_SET=0
PROJECT_NAME_SET=0
PORT_SET=0
RUNTIME_SET=0
SERVICE_USER_SET=0
ENV_FILE_SET=0
STATE_DIR_SET=0
REDIS_DB_SET=0
REDIS_PORT_SET=0
REDIS_MODE_SET=0
REPOSITORY_SET=0
BRANCH_SET=0
UNINSTALL=0
RESOLVE_ONLY=0
INSTALL_ARGS=()

[[ -n "${CTS_INSTALL_DIR:-}" ]] && INSTALL_DIR_SET=1
[[ -n "${CTS_PROJECT_NAME:-}" ]] && PROJECT_NAME_SET=1
[[ -n "${CTS_PORT:-}" ]] && PORT_SET=1
[[ -n "${CTS_RUNTIME:-}" ]] && RUNTIME_SET=1
[[ -n "${CTS_SERVICE_USER:-}" ]] && SERVICE_USER_SET=1
[[ -n "${CTS_ENV_FILE:-}" ]] && ENV_FILE_SET=1
[[ -n "${CTS_STATE_DIR:-}" ]] && STATE_DIR_SET=1
[[ -n "${CTS_REDIS_DB:-}" ]] && REDIS_DB_SET=1
[[ -n "${CTS_REDIS_PORT:-}" ]] && REDIS_PORT_SET=1
[[ -n "${CTS_REDIS_MODE:-}" ]] && REDIS_MODE_SET=1
[[ -n "${CTS_REPOSITORY:-}" ]] && REPOSITORY_SET=1
[[ -n "${CTS_BRANCH:-}" ]] && BRANCH_SET=1

usage() {
  cat <<'EOF'
Usage: bootstrap-install.sh [options] [-- installer-options]

Options:
  --dir PATH           Exact checkout path (default: /opt/<name>)
  --name NAME          Stable app/service name (default: cts-kn)
  --port PORT          HTTP port (default: 3002)
  --runtime MODE       auto, systemd, or pm2
  --service-user USER  Unprivileged runtime user (default: app name)
  --env-file PATH      Production environment file
  --state-dir PATH     Durable per-instance state (default: /var/lib/cts/instances/<name>)
  --redis-db NUMBER    Redis logical DB, 0..15 (derived from HTTP port)
  --redis-port PORT    Per-instance npm Redis fallback port
  --redis-mode MODE    auto, native, npm, or snapshot (preserved on update)
  --seed-env-file PATH Merge KEY=VALUE entries before installation
  --branch NAME        Git branch (default: main)
  --repository URL     Git repository URL
  --public-url URL     Public application URL
  --skip-tests         Skip Jest tests (typecheck, lint, build still run)
  --safe-simulation    Force paper mode and disable all real exchange orders
  --enable-live        Enable the guarded live path (default: enabled)
  --resolve-only       Print the exact resolved target without changing it
  --uninstall          Remove the exact resolved installation

Existing installs are discovered from /opt/*/.cts-runtime/install-values.env
or a named systemd service WorkingDirectory. Explicit options always win, but
must not conflict with the saved identity during uninstall.
EOF
}

SKIP_TESTS=0
SAFE_SIMULATION=0
EXECUTION_MODE_SET=0
# Match install.sh: guarded live execution is the server-install default.
# --safe-simulation is still the explicit paper-mode override.
LIVE_OPT_IN=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?--dir requires a value}"; INSTALL_DIR_SET=1; shift 2 ;;
    --branch) BRANCH="${2:?--branch requires a value}"; BRANCH_SET=1; shift 2 ;;
    --repository) REPOSITORY="${2:?--repository requires a value}"; REPOSITORY_SET=1; shift 2 ;;
    --name) PROJECT_NAME="${2:?--name requires a value}"; PROJECT_NAME_SET=1; shift 2 ;;
    --port) PORT="${2:?--port requires a value}"; PORT_SET=1; shift 2 ;;
    --runtime) RUNTIME="${2:?--runtime requires a value}"; RUNTIME_SET=1; shift 2 ;;
    --service-user) SERVICE_USER="${2:?--service-user requires a value}"; SERVICE_USER_SET=1; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file requires a value}"; ENV_FILE_SET=1; shift 2 ;;
    --state-dir) STATE_DIR="${2:?--state-dir requires a value}"; STATE_DIR_SET=1; shift 2 ;;
    --redis-db) REDIS_DB="${2:?--redis-db requires a value}"; REDIS_DB_SET=1; shift 2 ;;
    --redis-port) REDIS_PORT="${2:?--redis-port requires a value}"; REDIS_PORT_SET=1; shift 2 ;;
    --redis-mode) REDIS_MODE="${2:?--redis-mode requires a value}"; REDIS_MODE_SET=1; shift 2 ;;
    --seed-env-file) SEED_ENV_FILE="${2:?--seed-env-file requires a value}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:?--public-url requires a value}"; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --safe-simulation) SAFE_SIMULATION=1; LIVE_OPT_IN=0; EXECUTION_MODE_SET=1; shift ;;
    --enable-live) SAFE_SIMULATION=0; LIVE_OPT_IN=1; EXECUTION_MODE_SET=1; shift ;;
    --resolve-only) RESOLVE_ONLY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --) shift; INSTALL_ARGS+=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown bootstrap option: $1" >&2; exit 2 ;;
  esac
done

as_root() {
  if (( EUID == 0 )); then "$@"
  elif [[ -n "${CTS_TEST_TARGET:-}" || -n "${CTS_TEST_INSTALLER:-}" ]]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else echo "Run as root or install sudo" >&2; exit 1
  fi
}

as_service_user() {
  local user="$1"; shift
  if [[ "$(id -un)" == "$user" ]]; then "$@"
  elif (( EUID == 0 )); then runuser -u "$user" -- "$@"
  else sudo -u "$user" "$@"
  fi
}

valid_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; }
valid_user() { [[ "$1" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
valid_absolute_path() {
  [[ "$1" =~ ^/[a-zA-Z0-9._/-]+$ && "$1" != "/" && "$1" != *"//"* \
    && "$1" != *"/./"* && "$1" != */. && "$1" != *"/../"* && "$1" != */.. ]]
}

EXISTING_APP_NAME=""
EXISTING_APP_PORT=""
EXISTING_RUNTIME=""
EXISTING_SERVICE_USER=""
EXISTING_PROJECT_ROOT=""
EXISTING_ENV_FILE=""
EXISTING_ENV_MANAGED=""
EXISTING_STATE_DIR=""
EXISTING_REDIS_DB=""
EXISTING_REDIS_PORT=""
EXISTING_REDIS_MODE=""
EXISTING_EXECUTION_MODE=""
EXISTING_REPOSITORY=""
EXISTING_BRANCH=""
EXISTING_MANAGED_SERVICE_USER=0
PRESERVED_STATE=""
CLEAN_INSTALL_WORK_DIR=""
PERMANENT_BACKUP=""

discover_install_dir_from_name() {
  (( INSTALL_DIR_SET == 0 )) || return 0
  [[ -n "$PROJECT_NAME" ]] || return 0
  command -v systemctl >/dev/null 2>&1 || return 0
  local working_dir
  working_dir="$(systemctl show --property=WorkingDirectory --value "$PROJECT_NAME" 2>/dev/null || true)"
  if [[ "$working_dir" == /* && "$working_dir" != "/" ]]; then
    INSTALL_DIR="$working_dir"
  fi
}

discover_saved_install_from_name() {
  (( INSTALL_DIR_SET == 0 )) || return 0
  [[ -z "$INSTALL_DIR" && -n "$PROJECT_NAME" ]] || return 0
  local -a candidates=()
  local values
  shopt -s nullglob
  for values in "$INSTALL_SEARCH_ROOT"/*/.cts-runtime/install-values.env; do
    [[ -r "$values" ]] || continue
    if grep -Fqx "CTS_INSTALLED_APP_NAME=$PROJECT_NAME" "$values"; then
      candidates+=("${values%/.cts-runtime/install-values.env}")
    fi
  done
  shopt -u nullglob
  if (( ${#candidates[@]} == 1 )); then
    INSTALL_DIR="${candidates[0]}"
  elif (( ${#candidates[@]} > 1 )); then
    printf "Multiple CTS-K-N installs named '%s' were found under %s; specify --dir:\n" \
      "$PROJECT_NAME" "$INSTALL_SEARCH_ROOT" >&2
    printf '  %s\n' "${candidates[@]}" >&2
    exit 2
  fi
}

discover_single_saved_install() {
  (( INSTALL_DIR_SET == 0 )) || return 0
  [[ -z "$INSTALL_DIR" && -z "$PROJECT_NAME" ]] || return 0
  local -a candidates=()
  local values
  shopt -s nullglob
  for values in "$INSTALL_SEARCH_ROOT"/*/.cts-runtime/install-values.env; do
    [[ -r "$values" ]] && candidates+=("${values%/.cts-runtime/install-values.env}")
  done
  shopt -u nullglob
  if (( ${#candidates[@]} == 1 )); then
    INSTALL_DIR="${candidates[0]}"
  elif (( ${#candidates[@]} > 1 )); then
    printf 'Multiple CTS-K-N installs were found under %s; specify --dir or --name:\n' \
      "$INSTALL_SEARCH_ROOT" >&2
    printf '  %s\n' "${candidates[@]}" >&2
    exit 2
  fi
}

read_existing_install_values() {
  [[ -n "$INSTALL_DIR" ]] || return 0
  local values_file="$INSTALL_DIR/.cts-runtime/install-values.env" key value
  [[ -r "$values_file" ]] || return 0
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    case "$key" in
      CTS_INSTALLED_APP_NAME)
        valid_name "$value" && EXISTING_APP_NAME="$value"
        ;;
      CTS_INSTALLED_APP_PORT)
        valid_port "$value" && EXISTING_APP_PORT="$value"
        ;;
      CTS_INSTALLED_RUNTIME)
        [[ "$value" =~ ^(systemd|pm2)$ ]] && EXISTING_RUNTIME="$value"
        ;;
      CTS_INSTALLED_SERVICE_USER)
        valid_user "$value" && EXISTING_SERVICE_USER="$value"
        ;;
      CTS_INSTALLED_PROJECT_ROOT)
        EXISTING_PROJECT_ROOT="$value"
        ;;
      CTS_INSTALLED_ENV_FILE)
        [[ "$value" == /* && "$value" != "/" ]] && EXISTING_ENV_FILE="$value"
        ;;
      CTS_INSTALLED_ENV_MANAGED)
        [[ "$value" =~ ^[01]$ ]] && EXISTING_ENV_MANAGED="$value"
        ;;
      CTS_INSTALLED_STATE_DIR)
        valid_absolute_path "$value" && EXISTING_STATE_DIR="$value"
        ;;
      CTS_INSTALLED_REDIS_DB)
        [[ "$value" =~ ^([0-9]|1[0-5])$ ]] && EXISTING_REDIS_DB="$value"
        ;;
      CTS_INSTALLED_REDIS_PORT)
        valid_port "$value" && EXISTING_REDIS_PORT="$value"
        ;;
      CTS_INSTALLED_REDIS_MODE)
        [[ "$value" =~ ^(native|npm|inline-snapshot|external)$ ]] && EXISTING_REDIS_MODE="$value"
        ;;
      CTS_INSTALLED_EXECUTION_MODE)
        [[ "$value" =~ ^(live|safe-simulation)$ ]] && EXISTING_EXECUTION_MODE="$value"
        ;;
      CTS_INSTALLED_REPOSITORY)
        [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *[[:space:]]* ]] \
          && EXISTING_REPOSITORY="$value"
        ;;
      CTS_INSTALLED_BRANCH)
        [[ "$value" =~ ^[A-Za-z0-9._/-]+$ && "$value" != *".."* && "$value" != *"//"* ]] \
          && EXISTING_BRANCH="$value"
        ;;
    esac
  done < "$values_file"
  [[ ! -f "$INSTALL_DIR/.cts-runtime/managed-service-user" ]] \
    || [[ "$(<"$INSTALL_DIR/.cts-runtime/managed-service-user")" != "$EXISTING_SERVICE_USER" ]] \
    || EXISTING_MANAGED_SERVICE_USER=1

  if (( PROJECT_NAME_SET == 0 )) && [[ -n "$EXISTING_APP_NAME" ]]; then PROJECT_NAME="$EXISTING_APP_NAME"; fi
  if (( PORT_SET == 0 )) && [[ -n "$EXISTING_APP_PORT" ]]; then PORT="$EXISTING_APP_PORT"; fi
  if (( RUNTIME_SET == 0 )) && [[ -n "$EXISTING_RUNTIME" ]]; then RUNTIME="$EXISTING_RUNTIME"; fi
  if (( SERVICE_USER_SET == 0 )) && [[ -n "$EXISTING_SERVICE_USER" ]]; then SERVICE_USER="$EXISTING_SERVICE_USER"; fi
  if (( ENV_FILE_SET == 0 )) && [[ -n "$EXISTING_ENV_FILE" ]]; then ENV_FILE="$EXISTING_ENV_FILE"; fi
  if (( STATE_DIR_SET == 0 )) && [[ -n "$EXISTING_STATE_DIR" ]]; then STATE_DIR="$EXISTING_STATE_DIR"; fi
  if (( REDIS_DB_SET == 0 )) && [[ -n "$EXISTING_REDIS_DB" ]]; then REDIS_DB="$EXISTING_REDIS_DB"; fi
  if (( REDIS_PORT_SET == 0 )) && [[ -n "$EXISTING_REDIS_PORT" ]]; then REDIS_PORT="$EXISTING_REDIS_PORT"; fi
  if (( REDIS_MODE_SET == 0 )) && [[ -n "$EXISTING_REDIS_MODE" ]]; then
    case "$EXISTING_REDIS_MODE" in
      inline-snapshot) REDIS_MODE="snapshot" ;;
      external) REDIS_MODE="auto" ;;
      *) REDIS_MODE="$EXISTING_REDIS_MODE" ;;
    esac
  fi
  if (( EXECUTION_MODE_SET == 0 )) && [[ "$EXISTING_EXECUTION_MODE" == "safe-simulation" ]]; then
    SAFE_SIMULATION=1
    LIVE_OPT_IN=0
  fi
  if (( REPOSITORY_SET == 0 )) && [[ -n "$EXISTING_REPOSITORY" ]]; then REPOSITORY="$EXISTING_REPOSITORY"; fi
  if (( BRANCH_SET == 0 )) && [[ -n "$EXISTING_BRANCH" ]]; then BRANCH="$EXISTING_BRANCH"; fi
}

assert_cts_checkout() {
  [[ "$INSTALL_DIR" = /* && "$INSTALL_DIR" != "/" && -d "$INSTALL_DIR" \
    && -f "$INSTALL_DIR/package.json" && -f "$INSTALL_DIR/scripts/install.sh" ]] \
    || { echo "Refusing to replace/remove a directory that is not a CTS-K-N checkout: $INSTALL_DIR" >&2; exit 1; }
}

stop_stale_cts_processes() {
  local proc pid cwd cmdline attempt state
  local -a matched=() alive=()
  shopt -s nullglob
  for proc in /proc/[0-9]*; do
    pid="${proc##*/}"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    (( pid != $$ && pid != PPID )) || continue
    [[ -r "$proc/cmdline" ]] || continue
    cwd="$(readlink "$proc/cwd" 2>/dev/null || true)"
    cmdline="$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
    # Never kill by executable name alone. A process must resolve to this exact
    # checkout (including Linux's deleted-cwd suffix) and run one of the known
    # CTS owners/wrappers. Unrelated listeners remain a hard preflight error.
    if [[ "$cwd" == "$INSTALL_DIR" || "$cwd" == "$INSTALL_DIR"/* \
      || "$cwd" == "$INSTALL_DIR (deleted)" || "$cmdline" == *"$INSTALL_DIR/"* ]]; then
      case "$cmdline" in
        *scripts/run-with-env.mjs*|*scripts/start-production.mjs*|*scripts/run-minute-scheduler.mjs*|\
        *scripts/direct-trade-supervisor.mjs*|*scripts/direct-trade-processor.mjs*|\
        *scripts/runtime-recovery.sh*|*scripts/npm-redis-service.mjs*|\
        *scripts/start.sh*|*scripts/restart.sh*|*.next/standalone/server.js*|\
        *node_modules/next/dist/bin/next*dev*|*node_modules/next/dist/bin/next*start*)
          matched+=("$pid")
          ;;
      esac
    fi
  done
  shopt -u nullglob
  (( ${#matched[@]} > 0 )) || return 0

  printf 'Stopping %d stale CTS-K-N process(es) scoped to %s\n' "${#matched[@]}" "$INSTALL_DIR" >&2
  as_root kill -TERM "${matched[@]}" 2>/dev/null || true
  for attempt in {1..50}; do
    alive=()
    for pid in "${matched[@]}"; do
      state="$(awk '{ print $3; exit }' "/proc/$pid/stat" 2>/dev/null || true)"
      [[ -d "/proc/$pid" && "$state" != "Z" ]] && alive+=("$pid")
    done
    (( ${#alive[@]} == 0 )) && return 0
    sleep 0.1
  done
  as_root kill -KILL "${alive[@]}" 2>/dev/null || true
  sleep 0.2
  for pid in "${alive[@]}"; do
    state="$(awk '{ print $3; exit }' "/proc/$pid/stat" 2>/dev/null || true)"
    [[ ! -d "/proc/$pid" || "$state" == "Z" ]] \
      || { echo "Refusing checkout removal while scoped CTS process $pid remains alive" >&2; exit 1; }
  done
}

stop_existing_installation() {
  [[ -d "$INSTALL_DIR" ]] || return 0
  assert_cts_checkout
  if [[ -x "$INSTALL_DIR/scripts/service-control.sh" && -r "$INSTALL_DIR/.cts-runtime/install-values.env" ]]; then
    echo "Stopping saved CTS-K-N services for $INSTALL_DIR" >&2
    as_root bash "$INSTALL_DIR/scripts/service-control.sh" stop || true
  fi
  local name="${EXISTING_APP_NAME:-$PROJECT_NAME}"
  local runtime="${EXISTING_RUNTIME:-$RUNTIME}"
  local user="${EXISTING_SERVICE_USER:-$SERVICE_USER}"
  if [[ "$runtime" == "systemd" || "$runtime" == "auto" ]] && command -v systemctl >/dev/null 2>&1; then
    # Stop every CTS owner before replacing its checkout. Leaving the leased
    # Direct-Trade, recovery, or memory-governor owners left alive can execute
    # scripts from the checkout while it is being replaced.
    as_root systemctl stop "$name-recovery.timer" "$name-recovery" \
      "$name-redis-governor.timer" "$name-redis-governor" \
      "$name-redis-memory.timer" "$name-redis-memory" \
      "$name-direct-trade" "$name-scheduler" "$name" "$name-redis" 2>/dev/null || true
    for unit in "$name-recovery.timer" "$name-recovery" \
      "$name-redis-governor.timer" "$name-redis-governor" \
      "$name-redis-memory.timer" "$name-redis-memory" \
      "$name-direct-trade" "$name-scheduler" "$name" "$name-redis"; do
      if systemctl is-active --quiet "$unit" 2>/dev/null; then
        echo "Refusing to remove $INSTALL_DIR while service $unit is still active" >&2
        exit 1
      fi
    done
  fi
  if [[ "$runtime" == "pm2" || "$runtime" == "auto" ]] \
    && valid_user "$user" && id "$user" >/dev/null 2>&1 \
    && command -v pm2 >/dev/null 2>&1; then
    local home pm2_name pm2_pid
    home="$(awk -F: -v wanted="$user" '$1 == wanted { print $6; exit }' /etc/passwd 2>/dev/null || true)"
    [[ -n "$home" && "$home" != "/" ]] || home="/var/lib/$name"
    as_service_user "$user" env HOME="$home" PM2_HOME="$home/.pm2" \
      pm2 stop "$name-recovery" "$name-direct-trade" "$name-scheduler" "$name" "$name-redis" >/dev/null 2>&1 || true
    for pm2_name in "$name-recovery" "$name-direct-trade" "$name-scheduler" "$name" "$name-redis"; do
      pm2_pid="$(as_service_user "$user" env HOME="$home" PM2_HOME="$home/.pm2" \
        pm2 pid "$pm2_name" 2>/dev/null || true)"
      # PM2 may print status/log text containing digits even when its daemon
      # failed to start (for example, "PM2 version 7.0.3"). Only a PID that
      # is exclusively numeric represents an active managed process.
      if [[ "$pm2_pid" =~ ^[[:space:]]*[1-9][0-9]*[[:space:]]*$ ]]; then
        echo "Refusing to remove $INSTALL_DIR while PM2 process $pm2_name is still active" >&2
        exit 1
      fi
    done
  fi
  stop_stale_cts_processes
}

preserve_existing_install_state() {
  # A retry may already have selected the archive from the failed attempt while
  # an uninitialized replacement clone still occupies INSTALL_DIR. Keep that
  # authoritative archive and let the normal replacement step remove the
  # incomplete clone; creating a second archive here would lose the first one.
  [[ -z "$PRESERVED_STATE" ]] || return 0
  [[ -e "$INSTALL_DIR" ]] || return 0
  assert_cts_checkout
  stop_existing_installation
  local parent base
  parent="$(dirname "$INSTALL_DIR")"
  base="$(basename "$INSTALL_DIR")"
  PRESERVED_STATE="$parent/.${base}.cts-state.$(date -u +%Y%m%dT%H%M%SZ).$$"
  [[ ! -e "$PRESERVED_STATE" ]] || { echo "State archive already exists: $PRESERVED_STATE" >&2; exit 1; }
  as_root install -d -m 0700 "$PRESERVED_STATE"

  if [[ "$ENV_FILE" == "$INSTALL_DIR"/* && -f "$ENV_FILE" ]]; then
    as_root cp -a -- "$ENV_FILE" "$PRESERVED_STATE/environment"
  fi
  if [[ -f "$INSTALL_DIR/.cts-runtime/install-values.env" ]]; then
    as_root cp -a -- "$INSTALL_DIR/.cts-runtime/install-values.env" \
      "$PRESERVED_STATE/install-values.env"
  fi
  if [[ -n "$SEED_ENV_FILE" && "$SEED_ENV_FILE" == "$INSTALL_DIR"/* ]]; then
    [[ -r "$SEED_ENV_FILE" ]] || { echo "Seed env file is not readable: $SEED_ENV_FILE" >&2; exit 1; }
    as_root cp -a -- "$SEED_ENV_FILE" "$PRESERVED_STATE/seed-env"
    SEED_ENV_FILE="$PRESERVED_STATE/seed-env"
  fi
  if [[ -d "$INSTALL_DIR/.cts-runtime/redis-data" ]]; then
    as_root cp -a -- "$INSTALL_DIR/.cts-runtime/redis-data" "$PRESERVED_STATE/redis-data"
  fi
  if (( EXISTING_MANAGED_SERVICE_USER == 1 )) \
    && [[ -f "$INSTALL_DIR/.cts-runtime/managed-service-user" ]]; then
    as_root cp -a -- "$INSTALL_DIR/.cts-runtime/managed-service-user" "$PRESERVED_STATE/managed-service-user"
  fi
  for state_dir in data logs; do
    if [[ -d "$INSTALL_DIR/$state_dir" && ! -L "$INSTALL_DIR/$state_dir" ]]; then
      as_root cp -a -- "$INSTALL_DIR/$state_dir" "$PRESERVED_STATE/$state_dir"
    fi
  done
  echo "Saved persistent CTS state outside the target directory: $PRESERVED_STATE" >&2
}

create_permanent_backup() {
  [[ -d "$INSTALL_DIR" ]] || return 0
  local timestamp backup commit manifest_tmp redis_status_tmp backup_info_tmp legacy_root
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$BACKUP_ROOT/$PROJECT_NAME/$timestamp"
  [[ ! -e "$backup" ]] || backup="$backup.$$"
  as_root install -d -m 0700 -- "$backup"
  backup_info_tmp="$(mktemp)"
  printf 'project=%s\ninstall_dir=%s\ncreated_at=%s\n' \
    "$PROJECT_NAME" "$INSTALL_DIR" "$timestamp" > "$backup_info_tmp"
  as_root install -m 0600 -- "$backup_info_tmp" "$backup/backup-info"
  rm -f -- "$backup_info_tmp"

  if [[ -n "$PRESERVED_STATE" && -d "$PRESERVED_STATE" ]]; then
    as_root cp -a --reflink=auto -- "$PRESERVED_STATE" "$backup/recovery-state"
  fi
  if [[ -d "$STATE_DIR" ]]; then
    as_root cp -a --reflink=auto -- "$STATE_DIR" "$backup/instance-state"
  fi
  legacy_root="/var/lib/$PROJECT_NAME"
  if [[ "$legacy_root" != "$STATE_DIR" && -d "$legacy_root" ]]; then
    as_root cp -a --reflink=auto -- "$legacy_root" "$backup/legacy-instance-state"
  fi
  if [[ -f "$ENV_FILE" && "$ENV_FILE" != "$STATE_DIR"/* && "$ENV_FILE" != "$legacy_root"/* ]]; then
    as_root cp -a -- "$ENV_FILE" "$backup/environment"
  fi

  commit="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$commit" =~ ^[0-9a-fA-F]{40}$ ]]; then
    as_root git -c safe.directory="$INSTALL_DIR" -C "$INSTALL_DIR" bundle create "$backup/source.bundle" HEAD \
      || { echo "Could not create the required source bundle backup" >&2; exit 1; }
    # `git bundle verify` resolves prerequisite objects against the current
    # repository. Bootstrap may be launched by systemd with WorkingDirectory=/,
    # so always anchor verification in the still-present source checkout.
    as_root git -c safe.directory="$INSTALL_DIR" -C "$INSTALL_DIR" \
      bundle verify "$backup/source.bundle" >/dev/null \
      || { echo "Source bundle backup verification failed" >&2; exit 1; }
  fi

  if [[ -f "$INSTALL_DIR/scripts/run-with-env.mjs" && -f "$INSTALL_DIR/scripts/backup-local-redis.mjs" \
    && -f "$ENV_FILE" && -d "$INSTALL_DIR/node_modules/redis" ]]; then
    redis_status_tmp="$(mktemp)"
    as_root node "$INSTALL_DIR/scripts/run-with-env.mjs" "$ENV_FILE" -- \
      node "$INSTALL_DIR/scripts/backup-local-redis.mjs" "$backup/redis.rdb" \
      > "$redis_status_tmp"
    as_root install -m 0600 -- "$redis_status_tmp" "$backup/redis-backup.status"
    rm -f -- "$redis_status_tmp"
  fi

  manifest_tmp="$(mktemp)"
  as_root bash -c 'cd "$1" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 -r sha256sum' \
    _ "$backup" > "$manifest_tmp"
  as_root install -m 0600 -- "$manifest_tmp" "$backup/SHA256SUMS"
  rm -f -- "$manifest_tmp"
  as_root test -s "$backup/SHA256SUMS" \
    || { echo "Permanent backup manifest is empty" >&2; exit 1; }
  PERMANENT_BACKUP="$backup"
  echo "Verified permanent pre-reinstall backup: $PERMANENT_BACKUP" >&2
}

# A failed clean install deliberately leaves the state archive beside the
# removed target.  The most common recovery action is to run this bootstrap
# command again; requiring an operator to find and move that archive would
# turn an otherwise safe failure into an apparent data loss.  When there is
# no target checkout, resume the newest archive for this *exact* target name.
# The archive name is timestamped, so lexical glob order is chronological.
resume_preserved_state_after_failed_clean_install() {
  [[ -z "$PRESERVED_STATE" ]] || return 0
  # A failure can happen after clone but before install-values.env is written.
  # Such a checkout contains no authoritative runtime state and must not hide
  # the recovery archive from the immediately preceding clean attempt.
  if [[ -e "$INSTALL_DIR" && -f "$INSTALL_DIR/.cts-runtime/install-values.env" ]]; then
    return 0
  fi
  [[ ! -e "$INSTALL_DIR" ]] || assert_cts_checkout
  local parent base candidate latest=""
  parent="$(dirname "$INSTALL_DIR")"
  base="$(basename "$INSTALL_DIR")"
  shopt -s nullglob
  for candidate in "$parent/.${base}.cts-state."*; do
    [[ -d "$candidate" ]] || continue
    latest="$candidate"
  done
  shopt -u nullglob
  [[ -n "$latest" ]] || return 0
  PRESERVED_STATE="$latest"
  if [[ -e "$INSTALL_DIR" ]]; then
    echo "Resuming preserved CTS state past an incomplete replacement clone: $PRESERVED_STATE" >&2
  else
    echo "Resuming preserved CTS state from failed clean install: $PRESERVED_STATE" >&2
  fi
}

read_preserved_install_values() {
  [[ -n "$PRESERVED_STATE" && -r "$PRESERVED_STATE/install-values.env" ]] || return 0
  local values_file="$PRESERVED_STATE/install-values.env" key value
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    case "$key" in
      CTS_INSTALLED_APP_NAME)
        valid_name "$value" && EXISTING_APP_NAME="$value"
        ;;
      CTS_INSTALLED_APP_PORT)
        valid_port "$value" && EXISTING_APP_PORT="$value"
        ;;
      CTS_INSTALLED_RUNTIME)
        [[ "$value" =~ ^(systemd|pm2)$ ]] && EXISTING_RUNTIME="$value"
        ;;
      CTS_INSTALLED_SERVICE_USER)
        valid_user "$value" && EXISTING_SERVICE_USER="$value"
        ;;
      CTS_INSTALLED_PROJECT_ROOT)
        EXISTING_PROJECT_ROOT="$value"
        ;;
      CTS_INSTALLED_ENV_FILE)
        [[ "$value" == /* && "$value" != "/" ]] && EXISTING_ENV_FILE="$value"
        ;;
      CTS_INSTALLED_ENV_MANAGED)
        [[ "$value" =~ ^[01]$ ]] && EXISTING_ENV_MANAGED="$value"
        ;;
      CTS_INSTALLED_STATE_DIR)
        valid_absolute_path "$value" && EXISTING_STATE_DIR="$value"
        ;;
      CTS_INSTALLED_REDIS_DB)
        [[ "$value" =~ ^([0-9]|1[0-5])$ ]] && EXISTING_REDIS_DB="$value"
        ;;
      CTS_INSTALLED_REDIS_PORT)
        valid_port "$value" && EXISTING_REDIS_PORT="$value"
        ;;
      CTS_INSTALLED_REDIS_MODE)
        [[ "$value" =~ ^(native|npm|inline-snapshot|external)$ ]] && EXISTING_REDIS_MODE="$value"
        ;;
      CTS_INSTALLED_EXECUTION_MODE)
        [[ "$value" =~ ^(live|safe-simulation)$ ]] && EXISTING_EXECUTION_MODE="$value"
        ;;
      CTS_INSTALLED_REPOSITORY)
        [[ "$value" != *$'\n'* && "$value" != *$'\r'* && "$value" != *[[:space:]]* ]] \
          && EXISTING_REPOSITORY="$value"
        ;;
      CTS_INSTALLED_BRANCH)
        [[ "$value" =~ ^[A-Za-z0-9._/-]+$ && "$value" != *".."* && "$value" != *"//"* ]] \
          && EXISTING_BRANCH="$value"
        ;;
    esac
  done < "$values_file"

  if (( PROJECT_NAME_SET == 0 )) && [[ -n "$EXISTING_APP_NAME" ]]; then PROJECT_NAME="$EXISTING_APP_NAME"; fi
  if (( PORT_SET == 0 )) && [[ -n "$EXISTING_APP_PORT" ]]; then PORT="$EXISTING_APP_PORT"; fi
  if (( RUNTIME_SET == 0 )) && [[ -n "$EXISTING_RUNTIME" ]]; then RUNTIME="$EXISTING_RUNTIME"; fi
  if (( SERVICE_USER_SET == 0 )) && [[ -n "$EXISTING_SERVICE_USER" ]]; then SERVICE_USER="$EXISTING_SERVICE_USER"; fi
  if (( ENV_FILE_SET == 0 )) && [[ -n "$EXISTING_ENV_FILE" ]]; then ENV_FILE="$EXISTING_ENV_FILE"; fi
  if (( STATE_DIR_SET == 0 )) && [[ -n "$EXISTING_STATE_DIR" ]]; then STATE_DIR="$EXISTING_STATE_DIR"; fi
  if (( REDIS_DB_SET == 0 )) && [[ -n "$EXISTING_REDIS_DB" ]]; then REDIS_DB="$EXISTING_REDIS_DB"; fi
  if (( REDIS_PORT_SET == 0 )) && [[ -n "$EXISTING_REDIS_PORT" ]]; then REDIS_PORT="$EXISTING_REDIS_PORT"; fi
  if (( REDIS_MODE_SET == 0 )) && [[ -n "$EXISTING_REDIS_MODE" ]]; then
    case "$EXISTING_REDIS_MODE" in
      inline-snapshot) REDIS_MODE="snapshot" ;;
      external) REDIS_MODE="auto" ;;
      *) REDIS_MODE="$EXISTING_REDIS_MODE" ;;
    esac
  fi
  if (( EXECUTION_MODE_SET == 0 )) && [[ "$EXISTING_EXECUTION_MODE" == "safe-simulation" ]]; then
    SAFE_SIMULATION=1
    LIVE_OPT_IN=0
  fi
  if (( REPOSITORY_SET == 0 )) && [[ -n "$EXISTING_REPOSITORY" ]]; then REPOSITORY="$EXISTING_REPOSITORY"; fi
  if (( BRANCH_SET == 0 )) && [[ -n "$EXISTING_BRANCH" ]]; then BRANCH="$EXISTING_BRANCH"; fi
  [[ ! -f "$PRESERVED_STATE/managed-service-user" ]] || EXISTING_MANAGED_SERVICE_USER=1
}

remove_existing_install_target() {
  [[ -e "$INSTALL_DIR" ]] || return 0
  assert_cts_checkout
  as_root rm -rf -- "$INSTALL_DIR"
  [[ ! -e "$INSTALL_DIR" ]] || { echo "Target directory was not removed: $INSTALL_DIR" >&2; exit 1; }
  echo "Removed stopped CTS-K-N target directory: $INSTALL_DIR" >&2
}

# bootstrap-install.sh is often launched from the checkout it is about to
# replace (for example: `cd /opt/cts-kn && bash scripts/bootstrap-install.sh`).
# A shell retains that current working directory even after `rm -rf` removes
# it.  Git then fails before cloning with "Unable to read current working
# directory".  Move the coordinator into a dedicated sibling directory before
# deletion so the clean lifecycle is independent of its launch location.
prepare_clean_install_workspace() {
  local parent base requested
  parent="$(dirname "$INSTALL_DIR")"
  base="$(basename "$INSTALL_DIR")"
  requested="${CTS_BOOTSTRAP_WORK_DIR:-$parent/.${base}.bootstrap-work}"
  valid_absolute_path "$requested" \
    || { echo "CTS_BOOTSTRAP_WORK_DIR must be a safe absolute non-root path" >&2; exit 2; }
  [[ "$requested" != "$INSTALL_DIR" && "$requested" != "$INSTALL_DIR"/* ]] \
    || { echo "CTS_BOOTSTRAP_WORK_DIR must be outside the installation target" >&2; exit 2; }
  CLEAN_INSTALL_WORK_DIR="$requested"
  as_root install -d -m 0750 "$CLEAN_INSTALL_WORK_DIR"
  # Make the coordinator usable for a non-root invocation after sudo created
  # it, while the checkout itself is still owned by the caller after clone.
  as_root chown "$(id -u):$(id -g)" "$CLEAN_INSTALL_WORK_DIR" 2>/dev/null || true
  cd "$CLEAN_INSTALL_WORK_DIR"
  [[ "$PWD" != "$INSTALL_DIR" && "$PWD" != "$INSTALL_DIR"/* ]] \
    || { echo "Refusing to delete target from inside itself: $INSTALL_DIR" >&2; exit 1; }
  echo "Using safe bootstrap workspace outside target directory: $CLEAN_INSTALL_WORK_DIR" >&2
}

restore_install_state_into_clone() {
  [[ -n "$PRESERVED_STATE" && -d "$PRESERVED_STATE" ]] || return 0
  if [[ -f "$PRESERVED_STATE/environment" ]]; then
    as_root install -d -m 0750 "$(dirname "$ENV_FILE")"
    as_root cp -a -- "$PRESERVED_STATE/environment" "$ENV_FILE"
  fi
  if [[ -d "$PRESERVED_STATE/redis-data" ]]; then
    as_root install -d -m 0750 "$INSTALL_DIR/.cts-runtime"
    as_root cp -a -- "$PRESERVED_STATE/redis-data" "$INSTALL_DIR/.cts-runtime/redis-data"
  fi
  if (( EXISTING_MANAGED_SERVICE_USER == 1 )) \
    && [[ -f "$PRESERVED_STATE/managed-service-user" ]]; then
    as_root install -d -m 0750 "$INSTALL_DIR/.cts-runtime"
    as_root cp -a -- "$PRESERVED_STATE/managed-service-user" \
      "$INSTALL_DIR/.cts-runtime/managed-service-user"
  fi
  for state_dir in data logs; do
    if [[ -d "$PRESERVED_STATE/$state_dir" ]]; then
      as_root rm -rf -- "$INSTALL_DIR/$state_dir"
      as_root cp -a -- "$PRESERVED_STATE/$state_dir" "$INSTALL_DIR/$state_dir"
    fi
  done
}

remove_runtime_identity() {
  local name="$1" runtime="$2" user="$3"
  valid_name "$name" || return 0
  if [[ "$runtime" == "systemd" || "$runtime" == "auto" ]] \
    && command -v systemctl >/dev/null 2>&1; then
    as_root systemctl disable --now "$name-recovery.timer" "$name-recovery" \
      "$name-redis-governor.timer" "$name-redis-governor" \
      "$name-redis-memory.timer" "$name-redis-memory" \
      "$name-direct-trade" "$name-scheduler" "$name" "$name-redis" 2>/dev/null || true
    as_root rm -f -- "/etc/systemd/system/$name.service" \
      "/etc/systemd/system/$name-scheduler.service" \
      "/etc/systemd/system/$name-direct-trade.service" \
      "/etc/systemd/system/$name-recovery.service" \
      "/etc/systemd/system/$name-recovery.timer" \
      "/etc/systemd/system/$name-redis-governor.service" \
      "/etc/systemd/system/$name-redis-governor.timer" \
      "/etc/systemd/system/$name-redis-memory.service" \
      "/etc/systemd/system/$name-redis-memory.timer" \
      "/etc/systemd/system/$name-redis.service"
    as_root systemctl daemon-reload 2>/dev/null || true
  fi
  if [[ "$runtime" == "pm2" || "$runtime" == "auto" ]] \
    && valid_user "$user" && id "$user" >/dev/null 2>&1 && command -v pm2 >/dev/null 2>&1; then
    local home
    home="$(awk -F: -v wanted="$user" '$1 == wanted { print $6; exit }' /etc/passwd 2>/dev/null || true)"
    [[ -n "$home" && "$home" != "/" ]] || home="/var/lib/$name"
    as_service_user "$user" env HOME="$home" PM2_HOME="$home/.pm2" \
      pm2 delete "$name" "$name-scheduler" "$name-direct-trade" "$name-recovery" "$name-redis" >/dev/null 2>&1 || true
  fi
}

clean_install_failure() {
  local status=$?
  trap - EXIT
  if (( status != 0 )) && [[ -n "$PRESERVED_STATE" && -d "$PRESERVED_STATE" ]]; then
    set +e
    echo "Clean installation failed after the target was removed; preserved state remains at $PRESERVED_STATE" >&2
    echo "Retry with bootstrap-install.sh --dir '$INSTALL_DIR' so the archived state can be restored." >&2
  fi
  exit "$status"
}
trap clean_install_failure EXIT

valid_absolute_path "$INSTALL_SEARCH_ROOT" \
  || { echo "CTS_INSTALL_SEARCH_ROOT must be a safe absolute non-root path" >&2; exit 2; }
discover_install_dir_from_name
discover_saved_install_from_name
discover_single_saved_install
if [[ -n "$INSTALL_DIR" ]]; then read_existing_install_values; fi
[[ -n "$PROJECT_NAME" ]] || PROJECT_NAME="cts-kn"
if [[ -z "$INSTALL_DIR" ]]; then INSTALL_DIR="$INSTALL_SEARCH_ROOT/$PROJECT_NAME"; fi
# Name-only installs without a registered systemd unit still resolve through
# <search-root>/<name>. Read that directory's saved identity before defaults.
read_existing_install_values
# If a prior clean install removed the target before clone/install completed,
# load its archived identity before final defaults and validation are applied.
resume_preserved_state_after_failed_clean_install
read_preserved_install_values
if [[ -z "$SERVICE_USER" ]]; then
  if valid_user "$PROJECT_NAME"; then SERVICE_USER="$PROJECT_NAME"; else SERVICE_USER="cts-kn"; fi
fi
default_redis_db_for_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] || { printf '0'; return; }
  if (( port >= 3002 )); then printf '%s' "$(( (port - 3002) % 16 ))"; else printf '%s' "$(( port % 16 ))"; fi
}
[[ -n "$STATE_DIR" ]] || STATE_DIR="/var/lib/cts/instances/$PROJECT_NAME"
[[ -n "$ENV_FILE" ]] || ENV_FILE="$STATE_DIR/.env.production.local"
if (( ENV_FILE_SET == 0 )) && [[ "$ENV_FILE" == "/var/lib/$PROJECT_NAME/.env.production.local" ]] \
  && [[ "$STATE_DIR" != "/var/lib/$PROJECT_NAME" ]]; then
  ENV_FILE="$STATE_DIR/.env.production.local"
fi
[[ -n "$REDIS_DB" ]] || REDIS_DB="$(default_redis_db_for_port "$PORT")"
if [[ -z "$REDIS_PORT" ]]; then
  if [[ "$REDIS_DB" =~ ^([0-9]|1[0-5])$ ]]; then REDIS_PORT="$(( 6379 + REDIS_DB ))"; else REDIS_PORT=6379; fi
fi
[[ -n "$REDIS_MODE" ]] || REDIS_MODE="auto"
BACKUP_ROOT="${CTS_BACKUP_ROOT:-/var/backups/cts}"
if [[ -n "${CTS_TEST_TARGET:-}${CTS_TEST_INSTALLER:-}" && -z "${CTS_BACKUP_ROOT:-}" ]]; then
  BACKUP_ROOT="$(dirname "$INSTALL_DIR")/.cts-backups"
fi

valid_absolute_path "$INSTALL_DIR" || { echo "Install directory must be a safe absolute non-root path" >&2; exit 2; }
valid_name "$PROJECT_NAME" || { echo "Invalid service name" >&2; exit 2; }
valid_user "$SERVICE_USER" || { echo "Invalid service user" >&2; exit 2; }
valid_port "$PORT" || { echo "Invalid port" >&2; exit 2; }
[[ "$RUNTIME" =~ ^(auto|systemd|pm2)$ ]] || { echo "Invalid runtime" >&2; exit 2; }
valid_absolute_path "$ENV_FILE" || { echo "Environment file must be a safe absolute non-root path" >&2; exit 2; }
valid_absolute_path "$STATE_DIR" || { echo "State directory must be a safe absolute non-root path" >&2; exit 2; }
valid_absolute_path "$BACKUP_ROOT" || { echo "Backup root must be a safe absolute non-root path" >&2; exit 2; }
[[ "$BACKUP_ROOT" != "$STATE_DIR" && "$BACKUP_ROOT" != "$STATE_DIR"/* ]] \
  || { echo "Backup root must be outside the durable state directory" >&2; exit 2; }
[[ "$REDIS_DB" =~ ^([0-9]|1[0-5])$ ]] || { echo "Redis DB must be 0..15" >&2; exit 2; }
valid_port "$REDIS_PORT" || { echo "Invalid Redis port" >&2; exit 2; }
[[ "$REDIS_MODE" =~ ^(auto|native|npm|snapshot)$ ]] || { echo "Invalid Redis mode" >&2; exit 2; }
[[ -z "$SEED_ENV_FILE" || -r "$SEED_ENV_FILE" ]] \
  || { echo "Seed env file is not readable: $SEED_ENV_FILE" >&2; exit 2; }
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ && "$BRANCH" != *".."* && "$BRANCH" != *"//"* ]] || { echo "Invalid branch" >&2; exit 2; }
[[ "$REPOSITORY" != *$'\n'* && "$REPOSITORY" != *$'\r'* && "$REPOSITORY" != *[[:space:]]* ]] || { echo "Invalid repository URL" >&2; exit 2; }
if [[ -n "$EXISTING_PROJECT_ROOT" && "$EXISTING_PROJECT_ROOT" != "$INSTALL_DIR" ]]; then
  echo "Saved project root '$EXISTING_PROJECT_ROOT' does not match resolved directory '$INSTALL_DIR'" >&2
  exit 2
fi
if [[ -n "$PUBLIC_URL" ]]; then
  [[ "$PUBLIC_URL" =~ ^https?://[^[:space:]]+$ ]] || { echo "Public URL must include http:// or https://" >&2; exit 2; }
  export NEXT_PUBLIC_APP_URL="$PUBLIC_URL" DEPLOYMENT_URL="$PUBLIC_URL" PUBLIC_ACCESS_URL="$PUBLIC_URL"
fi

if (( RESOLVE_ONLY == 1 )); then
  printf 'CTS_INSTALL_DIR=%s\n' "$INSTALL_DIR"
  printf 'CTS_PROJECT_NAME=%s\n' "$PROJECT_NAME"
  printf 'CTS_PORT=%s\n' "$PORT"
  printf 'CTS_RUNTIME=%s\n' "$RUNTIME"
  printf 'CTS_SERVICE_USER=%s\n' "$SERVICE_USER"
  printf 'CTS_ENV_FILE=%s\n' "$ENV_FILE"
  printf 'CTS_STATE_DIR=%s\n' "$STATE_DIR"
  printf 'CTS_REDIS_DB=%s\n' "$REDIS_DB"
  printf 'CTS_REDIS_PORT=%s\n' "$REDIS_PORT"
  printf 'CTS_REDIS_MODE=%s\n' "$REDIS_MODE"
  if (( SAFE_SIMULATION == 1 || LIVE_OPT_IN == 0 )); then
    printf 'CTS_EXECUTION_MODE=safe-simulation\n'
  else
    printf 'CTS_EXECUTION_MODE=live\n'
  fi
  printf 'CTS_BACKUP_ROOT=%s\n' "$BACKUP_ROOT"
  printf 'CTS_REPOSITORY=%s\n' "$REPOSITORY"
  printf 'CTS_BRANCH=%s\n' "$BRANCH"
  exit 0
fi

if (( UNINSTALL == 1 )); then
  assert_cts_checkout
  if (( PROJECT_NAME_SET == 1 )) && [[ -n "$EXISTING_APP_NAME" && "$PROJECT_NAME" != "$EXISTING_APP_NAME" ]]; then
    echo "--name '$PROJECT_NAME' does not match installed service '$EXISTING_APP_NAME'" >&2
    exit 2
  fi
  if (( PORT_SET == 1 )) && [[ -n "$EXISTING_APP_PORT" && "$PORT" != "$EXISTING_APP_PORT" ]]; then
    echo "--port '$PORT' does not match installed port '$EXISTING_APP_PORT'" >&2
    exit 2
  fi
  exec bash "$INSTALL_DIR/scripts/install.sh" --uninstall --non-interactive
fi

for installer_arg in "${INSTALL_ARGS[@]}"; do
  case "$installer_arg" in
    --name|--project-name|--project|--port|--runtime|--service-user|--env-file|--state-dir|--redis-db|--redis-port|--redis-mode|--seed-env-file|--safe-simulation|--enable-live|--uninstall)
      echo "Pass $installer_arg before -- so bootstrap can resolve one authoritative target" >&2
      exit 2
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update -y
    as_root apt-get install -y git ca-certificates curl
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y git ca-certificates curl
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y git ca-certificates curl
  else
    echo "No supported package manager found (apt-get, dnf, or yum)" >&2
    exit 1
  fi
fi

resume_preserved_state_after_failed_clean_install
preserve_existing_install_state
create_permanent_backup
prepare_clean_install_workspace
remove_existing_install_target
as_root mkdir -p "$(dirname "$INSTALL_DIR")"
as_root git clone --branch "$BRANCH" --single-branch --depth=1 "$REPOSITORY" "$INSTALL_DIR"
as_root chown -R "$(id -u):$(id -g)" "$INSTALL_DIR" 2>/dev/null || true
restore_install_state_into_clone

cd "$INSTALL_DIR"
# Invoke the installer through Bash below. Changing a tracked script's mode
# here leaves every otherwise exact deployment dirty (Git records 100644 vs
# 100755), which breaks exact-head verification and future update safety.
INSTALL_ARGS+=(
  --name "$PROJECT_NAME"
  --port "$PORT"
  --runtime "$RUNTIME"
  --service-user "$SERVICE_USER"
  --env-file "$ENV_FILE"
  --state-dir "$STATE_DIR"
  --redis-db "$REDIS_DB"
  --redis-port "$REDIS_PORT"
  --redis-mode "$REDIS_MODE"
  --create-service-user
  --non-interactive
)
if [[ -n "$SEED_ENV_FILE" ]]; then
  INSTALL_ARGS+=(--seed-env-file "$SEED_ENV_FILE")
fi
if (( SKIP_TESTS == 1 )); then
  INSTALL_ARGS+=(--skip-tests)
fi
if (( SAFE_SIMULATION == 1 )); then
  INSTALL_ARGS+=(--safe-simulation)
fi
if (( LIVE_OPT_IN == 1 )); then
  INSTALL_ARGS+=(--enable-live)
fi
  if [[ -n "$EXISTING_ENV_MANAGED" ]]; then
  CTS_BOOTSTRAP_CLEAN_INSTALL=1 CTS_PRESERVE_ENV_MANAGED="$EXISTING_ENV_MANAGED" \
    CTS_TEST_TARGET="${CTS_TEST_TARGET:-}" bash scripts/install.sh "${INSTALL_ARGS[@]}"
  else
  CTS_BOOTSTRAP_CLEAN_INSTALL=1 CTS_TEST_TARGET="${CTS_TEST_TARGET:-}" \
    bash scripts/install.sh "${INSTALL_ARGS[@]}"
  fi

if [[ -n "$PRESERVED_STATE" && -d "$PRESERVED_STATE" ]]; then
  NEW_RUNTIME=""
  NEW_SERVICE_USER=""
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    case "$key" in
      CTS_INSTALLED_RUNTIME) [[ "$value" =~ ^(systemd|pm2)$ ]] && NEW_RUNTIME="$value" ;;
      CTS_INSTALLED_SERVICE_USER) valid_user "$value" && NEW_SERVICE_USER="$value" ;;
    esac
  done < "$INSTALL_DIR/.cts-runtime/install-values.env"
  if [[ -n "$EXISTING_APP_NAME" ]] \
    && { [[ "$EXISTING_APP_NAME" != "$PROJECT_NAME" ]] \
      || [[ -n "$EXISTING_RUNTIME" && "$EXISTING_RUNTIME" != "$NEW_RUNTIME" ]] \
      || [[ "$EXISTING_RUNTIME" == "pm2" && -n "$EXISTING_SERVICE_USER" && "$EXISTING_SERVICE_USER" != "$NEW_SERVICE_USER" ]]; }; then
    remove_runtime_identity "$EXISTING_APP_NAME" "$EXISTING_RUNTIME" "$EXISTING_SERVICE_USER"
  fi
  as_root rm -rf -- "$PRESERVED_STATE"
  PRESERVED_STATE=""
  if (( EXISTING_MANAGED_SERVICE_USER == 1 )) && [[ -n "$EXISTING_SERVICE_USER" && "$EXISTING_SERVICE_USER" != "$SERVICE_USER" ]] \
    && id "$EXISTING_SERVICE_USER" >/dev/null 2>&1; then
    # Preserve the old service home because it may contain operator-owned
    # credential archives used to recover or audit the replaced installation.
    as_root userdel "$EXISTING_SERVICE_USER" 2>/dev/null || true
  fi
fi
trap - EXIT
echo "CTS-K-N installation verified: $PROJECT_NAME at $INSTALL_DIR on port $PORT" >&2
[[ -z "$PERMANENT_BACKUP" ]] || echo "Permanent rollback backup retained at: $PERMANENT_BACKUP" >&2
