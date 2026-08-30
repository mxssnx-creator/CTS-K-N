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
SEED_ENV_FILE=""
PUBLIC_URL="${CTS_PUBLIC_URL:-${NEXT_PUBLIC_APP_URL:-}}"
INSTALL_SEARCH_ROOT="${CTS_INSTALL_SEARCH_ROOT:-/opt}"
INSTALL_DIR_SET=0
PROJECT_NAME_SET=0
PORT_SET=0
RUNTIME_SET=0
SERVICE_USER_SET=0
ENV_FILE_SET=0
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
  --seed-env-file PATH Merge KEY=VALUE entries before installation
  --branch NAME        Git branch (default: main)
  --repository URL     Git repository URL
  --public-url URL     Public application URL
  --skip-tests         Skip Jest tests (typecheck, lint, build still run)
  --safe-simulation    Force paper mode and disable all real exchange orders
  --enable-live        Explicitly opt into the guarded live path; disabled by default
  --resolve-only       Print the exact resolved target without changing it
  --uninstall          Remove the exact resolved installation

Existing installs are discovered from /opt/*/.cts-runtime/install-values.env
or a named systemd service WorkingDirectory. Explicit options always win, but
must not conflict with the saved identity during uninstall.
EOF
}

SKIP_TESTS=0
SAFE_SIMULATION=0
LIVE_OPT_IN=0
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
    --seed-env-file) SEED_ENV_FILE="${2:?--seed-env-file requires a value}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:?--public-url requires a value}"; shift 2 ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --safe-simulation) SAFE_SIMULATION=1; shift ;;
    --enable-live) LIVE_OPT_IN=1; shift ;;
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
EXISTING_REPOSITORY=""
EXISTING_BRANCH=""
EXISTING_MANAGED_SERVICE_USER=0
PRESERVED_STATE=""
CLEAN_INSTALL_WORK_DIR=""

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
  if (( REPOSITORY_SET == 0 )) && [[ -n "$EXISTING_REPOSITORY" ]]; then REPOSITORY="$EXISTING_REPOSITORY"; fi
  if (( BRANCH_SET == 0 )) && [[ -n "$EXISTING_BRANCH" ]]; then BRANCH="$EXISTING_BRANCH"; fi
}

assert_cts_checkout() {
  [[ "$INSTALL_DIR" = /* && "$INSTALL_DIR" != "/" && -d "$INSTALL_DIR" \
    && -f "$INSTALL_DIR/package.json" && -f "$INSTALL_DIR/scripts/install.sh" ]] \
    || { echo "Refusing to replace/remove a directory that is not a CTS-K-N checkout: $INSTALL_DIR" >&2; exit 1; }
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
    # Direct-Trade worker or recovery timer alive lets an old binary continue
    # writing to shared Redis while the new schema/build is installed.
    as_root systemctl stop "$name-recovery.timer" "$name-recovery" \
      "$name-direct-trade" "$name-scheduler" "$name" "$name-redis" 2>/dev/null || true
    for unit in "$name-recovery.timer" "$name-recovery" "$name-direct-trade" \
      "$name-scheduler" "$name" "$name-redis"; do
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
}

preserve_existing_install_state() {
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
    if [[ -d "$INSTALL_DIR/$state_dir" ]]; then
      as_root cp -a -- "$INSTALL_DIR/$state_dir" "$PRESERVED_STATE/$state_dir"
    fi
  done
  echo "Saved persistent CTS state outside the target directory: $PRESERVED_STATE" >&2
}

# A failed clean install deliberately leaves the state archive beside the
# removed target.  The most common recovery action is to run this bootstrap
# command again; requiring an operator to find and move that archive would
# turn an otherwise safe failure into an apparent data loss.  When there is
# no target checkout, resume the newest archive for this *exact* target name.
# The archive name is timestamped, so lexical glob order is chronological.
resume_preserved_state_after_failed_clean_install() {
  [[ ! -e "$INSTALL_DIR" && -z "$PRESERVED_STATE" ]] || return 0
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
  echo "Resuming preserved CTS state from failed clean install: $PRESERVED_STATE" >&2
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
      "$name-direct-trade" "$name-scheduler" "$name" "$name-redis" 2>/dev/null || true
    as_root rm -f -- "/etc/systemd/system/$name.service" \
      "/etc/systemd/system/$name-scheduler.service" \
      "/etc/systemd/system/$name-direct-trade.service" \
      "/etc/systemd/system/$name-recovery.service" \
      "/etc/systemd/system/$name-recovery.timer" \
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
[[ -n "$ENV_FILE" ]] || ENV_FILE="$INSTALL_DIR/.env.production.local"

valid_absolute_path "$INSTALL_DIR" || { echo "Install directory must be a safe absolute non-root path" >&2; exit 2; }
valid_name "$PROJECT_NAME" || { echo "Invalid service name" >&2; exit 2; }
valid_user "$SERVICE_USER" || { echo "Invalid service user" >&2; exit 2; }
valid_port "$PORT" || { echo "Invalid port" >&2; exit 2; }
[[ "$RUNTIME" =~ ^(auto|systemd|pm2)$ ]] || { echo "Invalid runtime" >&2; exit 2; }
valid_absolute_path "$ENV_FILE" || { echo "Environment file must be a safe absolute non-root path" >&2; exit 2; }
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
    --name|--project-name|--project|--port|--runtime|--service-user|--env-file|--seed-env-file|--uninstall)
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
prepare_clean_install_workspace
remove_existing_install_target
as_root mkdir -p "$(dirname "$INSTALL_DIR")"
as_root git clone --branch "$BRANCH" --single-branch --depth=1 "$REPOSITORY" "$INSTALL_DIR"
as_root chown -R "$(id -u):$(id -g)" "$INSTALL_DIR" 2>/dev/null || true
restore_install_state_into_clone

cd "$INSTALL_DIR"
chmod 750 scripts/install.sh
INSTALL_ARGS+=(
  --name "$PROJECT_NAME"
  --port "$PORT"
  --runtime "$RUNTIME"
  --service-user "$SERVICE_USER"
  --env-file "$ENV_FILE"
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
    as_root userdel --remove "$EXISTING_SERVICE_USER" 2>/dev/null || as_root userdel "$EXISTING_SERVICE_USER" || true
  fi
fi
trap - EXIT
echo "CTS-K-N installation verified: $PROJECT_NAME at $INSTALL_DIR on port $PORT" >&2
