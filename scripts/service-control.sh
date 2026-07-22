#!/usr/bin/env bash
# Start, stop, or restart an installed CTS-K-N service using its saved values.

set -Eeuo pipefail

ACTION="${1:-}"
case "$ACTION" in start|stop|restart) shift ;; *) echo "Usage: service-control.sh <start|stop|restart> [--name NAME] [--port PORT]" >&2; exit 2 ;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$PROJECT_ROOT/.cts-runtime"
VALUES_FILE="$RUNTIME_DIR/install-values.env"
ENV_FILE="$PROJECT_ROOT/.env.production.local"
APP_NAME="ctsv0.1.1"
APP_PORT="3002"
RUNTIME="auto"
SERVICE_USER=""
NAME_SET=0
PORT_SET=0

usage() {
  cat <<'EOF'
Usage: scripts/{start,stop,restart}.sh [--name NAME] [--port PORT]

Without arguments, saved values from .cts-runtime/install-values.env are used.
`--port` persists the new port before start/restart. For stop it is displayed
only, because no runtime configuration needs to change.
EOF
}

read_saved_values() {
  [[ -r "$VALUES_FILE" ]] || return 0
  local key value
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    case "$key" in
      CTS_INSTALLED_APP_NAME) [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] && APP_NAME="$value" ;;
      CTS_INSTALLED_APP_PORT) [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1 && value <= 65535 )) && APP_PORT="$value" ;;
      CTS_INSTALLED_RUNTIME) [[ "$value" =~ ^(systemd|pm2)$ ]] && RUNTIME="$value" ;;
      CTS_INSTALLED_SERVICE_USER) [[ "$value" =~ ^[a-zA-Z_][a-zA-Z0-9._-]*$ ]] && SERVICE_USER="$value" ;;
    esac
  done < "$VALUES_FILE"
}

read_saved_values
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
      shift ;;
  esac
done

[[ "$APP_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ ]] || { echo "Invalid service name" >&2; exit 2; }
[[ "$APP_PORT" =~ ^[0-9]+$ ]] && (( APP_PORT >= 1 && APP_PORT <= 65535 )) || { echo "Port must be 1..65535" >&2; exit 2; }
[[ -d "$PROJECT_ROOT" && -r "$VALUES_FILE" ]] || { echo "No CTS-K-N installation values found at $VALUES_FILE" >&2; exit 1; }

run_root() {
  if (( EUID == 0 )); then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else echo "sudo/root is required to control the installed service" >&2; exit 1; fi
}

run_as_service() {
  [[ -n "$SERVICE_USER" ]] || { echo "Saved service user is missing" >&2; exit 1; }
  local home
  home="$(awk -F: -v user="$SERVICE_USER" '$1 == user { print $6; exit }' /etc/passwd 2>/dev/null || true)"
  [[ -n "$home" && "$home" != "/" ]] || home="/var/lib/$APP_NAME"
  if [[ "$(id -un)" == "$SERVICE_USER" ]]; then
    env HOME="$home" PM2_HOME="$home/.pm2" "$@"
  else
    run_root -u "$SERVICE_USER" env HOME="$home" PM2_HOME="$home/.pm2" "$@"
  fi
}

update_value() {
  local file="$1" key="$2" value="$3" tmp
  [[ -f "$file" ]] || { echo "Required install file is missing: $file" >&2; exit 1; }
  tmp="$(mktemp)"
  awk -v wanted="$key" -v replacement="$value" '
    BEGIN { found = 0 }
    index($0, wanted "=") == 1 { print wanted "=" replacement; found = 1; next }
    { print }
    END { if (!found) print wanted "=" replacement }
  ' "$file" > "$tmp"
  run_root cp "$tmp" "$file"
  rm -f -- "$tmp"
}

if (( PORT_SET == 1 && ACTION != "stop" )); then
  update_value "$ENV_FILE" "PORT" "$APP_PORT"
  update_value "$ENV_FILE" "SCHEDULER_BASE_URL" "http://127.0.0.1:$APP_PORT"
  update_value "$VALUES_FILE" "CTS_INSTALLED_APP_PORT" "$APP_PORT"
  echo "Updated installed CTS port to $APP_PORT"
fi

case "$RUNTIME" in
  systemd|auto)
    command -v systemctl >/dev/null 2>&1 || { echo "systemctl is unavailable" >&2; exit 1; }
    if [[ "$ACTION" == "stop" ]]; then
      run_root systemctl stop "$APP_NAME-scheduler" "$APP_NAME" 2>/dev/null || true
      run_root systemctl stop "$APP_NAME-redis" 2>/dev/null || true
      echo "Stopped $APP_NAME (port $APP_PORT)"
    else
      run_root systemctl "$ACTION" "$APP_NAME"
      run_root systemctl "$ACTION" "$APP_NAME-scheduler"
      echo "${ACTION^}ed $APP_NAME on port $APP_PORT"
    fi
    ;;
  pm2)
    command -v pm2 >/dev/null 2>&1 || { echo "pm2 is unavailable" >&2; exit 1; }
    if [[ "$ACTION" == "stop" ]]; then
      run_as_service pm2 stop "$APP_NAME-scheduler" "$APP_NAME" "$APP_NAME-redis" >/dev/null 2>&1 || true
      echo "Stopped $APP_NAME (port $APP_PORT)"
    else
      run_as_service pm2 restart "$APP_NAME" "$APP_NAME-scheduler" --update-env
      echo "${ACTION^}ed $APP_NAME on port $APP_PORT"
    fi
    ;;
  *) echo "Unknown saved runtime: $RUNTIME" >&2; exit 1 ;;
esac
