#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

REPOSITORY="${CTS_REPOSITORY:-https://github.com/mxssnx-creator/CTS-K-N.git}"
BRANCH="${CTS_BRANCH:-main}"
INSTALL_DIR="${CTS_INSTALL_DIR:-/opt/cts-k-n}"
PROJECT_NAME="${CTS_PROJECT_NAME:-}"
PORT="${CTS_PORT:-3002}"
INSTALL_DIR_SET=0
PROJECT_NAME_SET=0
PORT_SET=0
PUBLIC_URL="${CTS_PUBLIC_URL:-${NEXT_PUBLIC_APP_URL:-}}"
UNINSTALL=0
INSTALL_ARGS=()

[[ -n "${CTS_INSTALL_DIR:-}" ]] && INSTALL_DIR_SET=1
[[ -n "${CTS_PROJECT_NAME:-}" ]] && PROJECT_NAME_SET=1
[[ -n "${CTS_PORT:-}" ]] && PORT_SET=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?--dir requires a value}"; INSTALL_DIR_SET=1; shift 2;;
    --branch) BRANCH="${2:?--branch requires a value}"; shift 2;;
    --repository) REPOSITORY="${2:?--repository requires a value}"; shift 2;;
    --name) PROJECT_NAME="${2:?--name requires a value}"; PROJECT_NAME_SET=1; shift 2;;
    --port) PORT="${2:?--port requires a value}"; PORT_SET=1; shift 2;;
    --public-url) PUBLIC_URL="${2:?--public-url requires a value}"; shift 2;;
    --uninstall) UNINSTALL=1; shift;;
    --) shift; INSTALL_ARGS+=("$@"); break;;
    -h|--help) echo "Usage: bootstrap-install.sh [--dir PATH] [--branch NAME] [--repository URL] [--name NAME] [--port PORT] [--public-url URL] [--uninstall] [-- installer-options]"; exit 0;;
    *) echo "Unknown bootstrap option: $1" >&2; exit 2;;
  esac
done

as_root() { if [[ "$(id -u)" == 0 ]]; then "$@"; elif command -v sudo >/dev/null 2>&1; then sudo "$@"; else echo "Run as root or install sudo" >&2; exit 1; fi; }

EXISTING_APP_NAME=""
EXISTING_APP_PORT=""
EXISTING_RUNTIME=""
EXISTING_SERVICE_USER=""
PRESERVED_STATE_DIR=""

valid_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }

# A named systemd installation can be removed or upgraded without requiring the
# caller to remember the original directory. An explicit --dir always wins.
discover_install_dir_from_name() {
  (( INSTALL_DIR_SET == 0 )) || return 0
  [[ -n "$PROJECT_NAME" ]] || return 0
  command -v systemctl >/dev/null 2>&1 || return 0
  local working_dir
  working_dir="$(systemctl show --property=WorkingDirectory --value "$PROJECT_NAME" 2>/dev/null || true)"
  if [[ "$working_dir" == /* && "$working_dir" != "/" && -d "$working_dir" ]]; then
    INSTALL_DIR="$working_dir"
  fi
}

read_existing_install_values() {
  local values_file="$INSTALL_DIR/.cts-runtime/install-values.env" key value
  [[ -r "$values_file" ]] || return 0
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    case "$key" in
      CTS_INSTALLED_APP_NAME) valid_name "$value" && EXISTING_APP_NAME="$value" ;;
      CTS_INSTALLED_APP_PORT) valid_port "$value" && EXISTING_APP_PORT="$value" ;;
      CTS_INSTALLED_RUNTIME) [[ "$value" =~ ^(systemd|pm2)$ ]] && EXISTING_RUNTIME="$value" ;;
      CTS_INSTALLED_SERVICE_USER) [[ "$value" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]] && EXISTING_SERVICE_USER="$value" ;;
    esac
  done < "$values_file"

  # Saved values are authoritative for a target directory. They make a repeat
  # command use the same service/port even when callers omit all arguments.
  if (( PROJECT_NAME_SET == 0 )) && [[ -n "$EXISTING_APP_NAME" ]]; then PROJECT_NAME="$EXISTING_APP_NAME"; fi
  if (( PORT_SET == 0 )) && [[ -n "$EXISTING_APP_PORT" ]]; then PORT="$EXISTING_APP_PORT"; fi
}

assert_cts_checkout() {
  [[ "$INSTALL_DIR" = /* && "$INSTALL_DIR" != "/" && -d "$INSTALL_DIR" \
    && -f "$INSTALL_DIR/package.json" && -f "$INSTALL_DIR/scripts/install.sh" ]] \
    || { echo "Refusing to replace/remove a directory that is not a CTS-K-N checkout: $INSTALL_DIR" >&2; exit 1; }
}

stop_existing_installation() {
  [[ -d "$INSTALL_DIR" ]] || return 0
  assert_cts_checkout
  read_existing_install_values
  if [[ -x "$INSTALL_DIR/scripts/service-control.sh" && -r "$INSTALL_DIR/.cts-runtime/install-values.env" ]]; then
    echo "Stopping saved CTS-K-N services for $INSTALL_DIR" >&2
    as_root bash "$INSTALL_DIR/scripts/service-control.sh" stop || true
    return 0
  fi
  [[ -n "$EXISTING_APP_NAME" ]] || return 0
  if [[ "$EXISTING_RUNTIME" == "systemd" ]] && command -v systemctl >/dev/null 2>&1; then
    as_root systemctl stop "$EXISTING_APP_NAME-scheduler" "$EXISTING_APP_NAME" "$EXISTING_APP_NAME-redis" 2>/dev/null || true
  fi
}

preserve_and_remove_existing_checkout() {
  [[ -e "$INSTALL_DIR" ]] || return 0
  assert_cts_checkout
  stop_existing_installation

  local parent base
  parent="$(dirname "$INSTALL_DIR")"
  base="$(basename "$INSTALL_DIR")"
  PRESERVED_STATE_DIR="$(as_root mktemp -d "$parent/.${base}.cts-reinstall.XXXXXX")"

  # Delete the old checkout before cloning. Preserve only secrets and a local
  # npm-Redis data directory; native/external Redis is intentionally untouched.
  if [[ -f "$INSTALL_DIR/.env.production.local" ]]; then
    as_root mv "$INSTALL_DIR/.env.production.local" "$PRESERVED_STATE_DIR/environment"
  fi
  if [[ -d "$INSTALL_DIR/.cts-runtime/redis-data" ]]; then
    as_root mv "$INSTALL_DIR/.cts-runtime/redis-data" "$PRESERVED_STATE_DIR/redis-data"
  fi
  as_root rm -rf -- "$INSTALL_DIR"
  echo "Removed old CTS-K-N checkout at $INSTALL_DIR after stopping its saved services" >&2
}

restore_preserved_install_state() {
  [[ -n "$PRESERVED_STATE_DIR" && -d "$PRESERVED_STATE_DIR" ]] || return 0
  if [[ -f "$PRESERVED_STATE_DIR/environment" ]]; then
    as_root mv "$PRESERVED_STATE_DIR/environment" "$INSTALL_DIR/.env.production.local"
  fi
  if [[ -d "$PRESERVED_STATE_DIR/redis-data" ]]; then
    as_root install -d -m 0750 "$INSTALL_DIR/.cts-runtime"
    as_root mv "$PRESERVED_STATE_DIR/redis-data" "$INSTALL_DIR/.cts-runtime/redis-data"
  fi
  as_root chown -R "$(id -u):$(id -g)" "$INSTALL_DIR/.cts-runtime" "$INSTALL_DIR/.env.production.local" 2>/dev/null || true
  as_root rmdir "$PRESERVED_STATE_DIR" 2>/dev/null || true
  PRESERVED_STATE_DIR=""
}

discover_install_dir_from_name
[[ "$INSTALL_DIR" = /* && "$INSTALL_DIR" != "/" ]] || { echo "Install directory must be an absolute non-root path" >&2; exit 2; }
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "Invalid branch" >&2; exit 2; }
valid_port "$PORT" || { echo "Invalid port" >&2; exit 2; }
if [[ -n "$PUBLIC_URL" ]]; then
  [[ "$PUBLIC_URL" =~ ^https?://[^[:space:]]+$ ]] || { echo "Public URL must include http:// or https://" >&2; exit 2; }
  export NEXT_PUBLIC_APP_URL="$PUBLIC_URL" DEPLOYMENT_URL="$PUBLIC_URL" PUBLIC_ACCESS_URL="$PUBLIC_URL"
fi

if (( UNINSTALL == 1 )); then
  assert_cts_checkout
  read_existing_install_values
  UNINSTALL_ARGS=(--uninstall --non-interactive)
  (( PROJECT_NAME_SET == 1 )) && UNINSTALL_ARGS+=(--name "$PROJECT_NAME")
  (( PORT_SET == 1 )) && UNINSTALL_ARGS+=(--port "$PORT")
  exec bash "$INSTALL_DIR/scripts/install.sh" "${UNINSTALL_ARGS[@]}"
fi

if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then as_root apt-get update -y; as_root apt-get install -y git ca-certificates curl
  elif command -v dnf >/dev/null 2>&1; then as_root dnf install -y git ca-certificates curl
  elif command -v yum >/dev/null 2>&1; then as_root yum install -y git ca-certificates curl
  else echo "No supported package manager found (apt-get, dnf, or yum)" >&2; exit 1; fi
fi

read_existing_install_values
preserve_and_remove_existing_checkout
as_root mkdir -p "$(dirname "$INSTALL_DIR")"
as_root git clone --branch "$BRANCH" --single-branch --depth=1 "$REPOSITORY" "$INSTALL_DIR"
as_root chown -R "$(id -u):$(id -g)" "$INSTALL_DIR" 2>/dev/null || true
restore_preserved_install_state

cd "$INSTALL_DIR"
chmod 750 scripts/install.sh
[[ -n "$PROJECT_NAME" ]] && INSTALL_ARGS+=(--name "$PROJECT_NAME")
INSTALL_ARGS+=(--port "$PORT" --runtime auto --service-user cts-kn --create-service-user --non-interactive)
exec bash scripts/install.sh "${INSTALL_ARGS[@]}"
