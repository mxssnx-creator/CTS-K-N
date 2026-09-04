#!/usr/bin/env bash
# Start, stop, restart, or inspect an installed CTS-K-N service using the
# authoritative values recorded by scripts/install.sh.

set -Eeuo pipefail

ACTION="${1:-}"
case "$ACTION" in
  start|stop|restart|resolve) shift ;;
  *) echo "Usage: service-control.sh <start|stop|restart|resolve> [--name NAME] [--port PORT]" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$PROJECT_ROOT/.cts-runtime"
VALUES_FILE="$RUNTIME_DIR/install-values.env"
STATE_DIR="/var/lib/cts/instances/cts-kn"
ENV_FILE="$STATE_DIR/.env.production.local"
REDIS_DB="0"
REDIS_PORT="6379"
REDIS_MODE="auto"
EXECUTION_MODE="live"
APP_NAME="cts-kn"
APP_PORT="3002"
RUNTIME="auto"
SERVICE_USER=""
ENV_FILE_MANAGED="0"
SAVED_APP_NAME=""
SAVED_APP_PORT=""
SAVED_PROJECT_ROOT=""
NAME_SET=0
PORT_SET=0

usage() {
  cat <<'EOF'
Usage: scripts/{start,stop,restart}.sh [--name NAME] [--port PORT]
       scripts/service-control.sh resolve

Saved values from .cts-runtime/install-values.env are authoritative. `--name`
must match the installed service. `--port` persists the new port before a
start/restart. `resolve` prints the exact target without changing the system.
EOF
}

valid_name() { [[ "$1" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]]; }
valid_user() { [[ "$1" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
valid_absolute_path() {
  [[ "$1" =~ ^/[a-zA-Z0-9._/-]+$ && "$1" != "/" && "$1" != *"//"* \
    && "$1" != *"/./"* && "$1" != */. && "$1" != *"/../"* && "$1" != */.. ]]
}

read_saved_values() {
  [[ -r "$VALUES_FILE" ]] || return 0
  local key value
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    case "$key" in
      CTS_INSTALLED_APP_NAME)
        valid_name "$value" && APP_NAME="$value" && SAVED_APP_NAME="$value"
        ;;
      CTS_INSTALLED_APP_PORT)
        valid_port "$value" && APP_PORT="$value" && SAVED_APP_PORT="$value"
        ;;
      CTS_INSTALLED_RUNTIME)
        [[ "$value" =~ ^(systemd|pm2)$ ]] && RUNTIME="$value"
        ;;
      CTS_INSTALLED_SERVICE_USER)
        valid_user "$value" && SERVICE_USER="$value"
        ;;
      CTS_INSTALLED_PROJECT_ROOT)
        SAVED_PROJECT_ROOT="$value"
        ;;
      CTS_INSTALLED_ENV_FILE)
        [[ "$value" == /* && "$value" != "/" ]] && ENV_FILE="$value"
        ;;
      CTS_INSTALLED_ENV_MANAGED)
        [[ "$value" =~ ^[01]$ ]] && ENV_FILE_MANAGED="$value"
        ;;
      CTS_INSTALLED_STATE_DIR)
        valid_absolute_path "$value" && STATE_DIR="$value"
        ;;
      CTS_INSTALLED_REDIS_DB)
        [[ "$value" =~ ^([0-9]|1[0-5])$ ]] && REDIS_DB="$value"
        ;;
      CTS_INSTALLED_REDIS_PORT)
        valid_port "$value" && REDIS_PORT="$value"
        ;;
      CTS_INSTALLED_REDIS_MODE)
        [[ "$value" =~ ^(native|npm|inline-snapshot|external)$ ]] && REDIS_MODE="$value"
        ;;
      CTS_INSTALLED_EXECUTION_MODE)
        [[ "$value" =~ ^(live|safe-simulation)$ ]] && EXECUTION_MODE="$value"
        ;;
    esac
  done < "$VALUES_FILE"
}

read_saved_values
if [[ ! -r "$VALUES_FILE" ]]; then
  echo "Missing authoritative install metadata: $VALUES_FILE" >&2
  echo "Run scripts/install.sh or bootstrap-install.sh before controlling this checkout." >&2
  exit 1
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) APP_NAME="${2:?--name requires a value}"; NAME_SET=1; shift 2 ;;
    --port) APP_PORT="${2:?--port requires a value}"; PORT_SET=1; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if (( NAME_SET == 0 )); then APP_NAME="$1"; NAME_SET=1
      elif (( PORT_SET == 0 )); then APP_PORT="$1"; PORT_SET=1
      else echo "Unexpected argument: $1" >&2; exit 2; fi
      shift
      ;;
  esac
done

valid_name "$APP_NAME" || { echo "Invalid service name" >&2; exit 2; }
valid_port "$APP_PORT" || { echo "Port must be 1..65535" >&2; exit 2; }
valid_absolute_path "$PROJECT_ROOT" || { echo "Invalid project root" >&2; exit 2; }
valid_absolute_path "$ENV_FILE" || { echo "Invalid installed environment path" >&2; exit 2; }
valid_absolute_path "$STATE_DIR" || { echo "Invalid installed state path" >&2; exit 2; }
if (( NAME_SET == 1 )) && [[ -n "$SAVED_APP_NAME" && "$APP_NAME" != "$SAVED_APP_NAME" ]]; then
  echo "Requested service '$APP_NAME' does not match installed service '$SAVED_APP_NAME'" >&2
  exit 2
fi
if (( PORT_SET == 1 )) && [[ "$ACTION" == "stop" || "$ACTION" == "resolve" ]] \
  && [[ -n "$SAVED_APP_PORT" && "$APP_PORT" != "$SAVED_APP_PORT" ]]; then
  echo "--port may change the installed port only during start/restart; saved port is '$SAVED_APP_PORT'" >&2
  exit 2
fi
if [[ -n "$SAVED_PROJECT_ROOT" && "$SAVED_PROJECT_ROOT" != "$PROJECT_ROOT" ]]; then
  echo "Saved project root '$SAVED_PROJECT_ROOT' does not match '$PROJECT_ROOT'" >&2
  exit 1
fi
if [[ "$RUNTIME" == "auto" ]]; then
  if [[ -f "/etc/systemd/system/$APP_NAME.service" ]]; then RUNTIME="systemd"
  elif command -v pm2 >/dev/null 2>&1; then RUNTIME="pm2"
  else RUNTIME="systemd"
  fi
fi

if [[ "$ACTION" == "resolve" ]]; then
  printf 'CTS_INSTALLED_APP_NAME=%s\n' "$APP_NAME"
  printf 'CTS_INSTALLED_APP_PORT=%s\n' "$APP_PORT"
  printf 'CTS_INSTALLED_RUNTIME=%s\n' "$RUNTIME"
  printf 'CTS_INSTALLED_SERVICE_USER=%s\n' "$SERVICE_USER"
  printf 'CTS_INSTALLED_PROJECT_ROOT=%s\n' "$PROJECT_ROOT"
  printf 'CTS_INSTALLED_ENV_FILE=%s\n' "$ENV_FILE"
  printf 'CTS_INSTALLED_ENV_MANAGED=%s\n' "$ENV_FILE_MANAGED"
  printf 'CTS_INSTALLED_STATE_DIR=%s\n' "$STATE_DIR"
  printf 'CTS_INSTALLED_REDIS_DB=%s\n' "$REDIS_DB"
  printf 'CTS_INSTALLED_REDIS_PORT=%s\n' "$REDIS_PORT"
  printf 'CTS_INSTALLED_REDIS_MODE=%s\n' "$REDIS_MODE"
  printf 'CTS_INSTALLED_EXECUTION_MODE=%s\n' "$EXECUTION_MODE"
  exit 0
fi

[[ -d "$PROJECT_ROOT" ]] || { echo "Project directory not found: $PROJECT_ROOT" >&2; exit 1; }

run_root() {
  if (( EUID == 0 )); then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else echo "sudo/root is required to control the installed service" >&2; exit 1
  fi
}

run_as_service() {
  valid_user "$SERVICE_USER" || { echo "Saved service user is missing or invalid" >&2; exit 1; }
  local home
  home="$(awk -F: -v user="$SERVICE_USER" '$1 == user { print $6; exit }' /etc/passwd 2>/dev/null || true)"
  [[ -n "$home" && "$home" != "/" ]] || home="/var/lib/$APP_NAME"
  if [[ "$(id -un)" == "$SERVICE_USER" ]]; then
    env HOME="$home" PM2_HOME="$home/.pm2" "$@"
  elif (( EUID == 0 )); then
    runuser -u "$SERVICE_USER" -- env HOME="$home" PM2_HOME="$home/.pm2" "$@"
  else
    sudo -u "$SERVICE_USER" env HOME="$home" PM2_HOME="$home/.pm2" "$@"
  fi
}

update_value() {
  local file="$1" key="$2" value="$3" tmp
  [[ -f "$file" ]] || { echo "Required install file is missing: $file" >&2; exit 1; }
  tmp="$(mktemp "$RUNTIME_DIR/tmp.XXXXXX")"
  run_root awk -v wanted="$key" -v replacement="$value" '
    BEGIN { found = 0 }
    index($0, wanted "=") == 1 { print wanted "=" replacement; found = 1; next }
    { print }
    END { if (!found) print wanted "=" replacement }
  ' "$file" > "$tmp"
  run_root cp "$tmp" "$file"
  rm -f -- "$tmp"
}

if (( PORT_SET == 1 )) && [[ "$ACTION" != "stop" ]]; then
  update_value "$ENV_FILE" "PORT" "$APP_PORT"
  update_value "$ENV_FILE" "SCHEDULER_BASE_URL" "http://127.0.0.1:$APP_PORT"
  update_value "$VALUES_FILE" "CTS_INSTALLED_APP_PORT" "$APP_PORT"
  echo "Updated installed CTS port to $APP_PORT"
fi

pm2_start_or_restart() {
  local name="$1" wrapper="$2"
  if run_as_service pm2 describe "$name" >/dev/null 2>&1; then
    run_as_service pm2 restart "$name" --update-env
  else
    [[ -x "$wrapper" ]] || { echo "Runtime wrapper is missing: $wrapper" >&2; exit 1; }
    run_as_service pm2 start "$wrapper" --name "$name" --time --restart-delay 5000
  fi
}

# Manual stops are an explicit maintenance action. The recovery supervisor
# respects this marker so it cannot restart a service the operator stopped.
if [[ "$ACTION" == "stop" ]]; then
  service_group="$(id -gn "$SERVICE_USER")"
  run_root chgrp "$service_group" "$RUNTIME_DIR"
  run_root chmod 750 "$RUNTIME_DIR"
  run_root touch "$RUNTIME_DIR/maintenance-stop"
  run_root chgrp "$service_group" "$RUNTIME_DIR/maintenance-stop"
  run_root chmod 640 "$RUNTIME_DIR/maintenance-stop"
  run_as_service test -e "$RUNTIME_DIR/maintenance-stop" \
    || { echo "Service user cannot inspect the runtime maintenance marker" >&2; exit 1; }
else
  run_root rm -f -- "$RUNTIME_DIR/maintenance-stop"
fi

case "$RUNTIME" in
  systemd)
    command -v systemctl >/dev/null 2>&1 || { echo "systemctl is unavailable" >&2; exit 1; }
    if [[ "$ACTION" == "stop" ]]; then
      run_root systemctl stop "$APP_NAME-direct-trade" "$APP_NAME-scheduler" "$APP_NAME" 2>/dev/null || true
      run_root systemctl stop "$APP_NAME-redis" 2>/dev/null || true
      echo "Stopped $APP_NAME (port $APP_PORT)"
    else
      if [[ -f "/etc/systemd/system/$APP_NAME-redis.service" ]]; then
        run_root systemctl "$ACTION" "$APP_NAME-redis"
      fi
      run_root systemctl "$ACTION" "$APP_NAME"
      run_root systemctl "$ACTION" "$APP_NAME-scheduler"
      if [[ -f "/etc/systemd/system/$APP_NAME-direct-trade.service" ]]; then
        run_root systemctl "$ACTION" "$APP_NAME-direct-trade"
      fi
      if [[ -f "/etc/systemd/system/$APP_NAME-recovery.timer" ]]; then
        run_root systemctl start "$APP_NAME-recovery.timer"
      fi
      echo "${ACTION^}ed $APP_NAME on port $APP_PORT"
    fi
    ;;
  pm2)
    command -v pm2 >/dev/null 2>&1 || { echo "pm2 is unavailable" >&2; exit 1; }
    if [[ "$ACTION" == "stop" ]]; then
      run_as_service pm2 stop "$APP_NAME-direct-trade" "$APP_NAME-scheduler" "$APP_NAME" "$APP_NAME-recovery" "$APP_NAME-redis" >/dev/null 2>&1 || true
      echo "Stopped $APP_NAME (port $APP_PORT)"
    else
      if [[ -x "$RUNTIME_DIR/start-redis.sh" ]]; then
        pm2_start_or_restart "$APP_NAME-redis" "$RUNTIME_DIR/start-redis.sh"
      fi
      pm2_start_or_restart "$APP_NAME" "$RUNTIME_DIR/start-app.sh"
      pm2_start_or_restart "$APP_NAME-scheduler" "$RUNTIME_DIR/start-scheduler.sh"
      if [[ -x "$RUNTIME_DIR/start-direct-trade.sh" ]]; then
        pm2_start_or_restart "$APP_NAME-direct-trade" "$RUNTIME_DIR/start-direct-trade.sh"
      fi
      if [[ -x "$RUNTIME_DIR/start-recovery.sh" ]]; then
        pm2_start_or_restart "$APP_NAME-recovery" "$RUNTIME_DIR/start-recovery.sh"
      fi
      run_as_service pm2 save --force >/dev/null
      echo "${ACTION^}ed $APP_NAME on port $APP_PORT"
    fi
    ;;
  *) echo "Unknown saved runtime: $RUNTIME" >&2; exit 1 ;;
esac
