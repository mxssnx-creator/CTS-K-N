#!/usr/bin/env bash
# One bounded, lock-coordinated recovery tick for installed CTS services.
#
# Invoked once per minute by a systemd timer (or by the PM2 recovery wrapper).
# It never touches exchange APIs or Redis. The Direct-Trade worker remains the
# sole lease owner; this script merely asks the configured service manager to
# restart a missing or stale worker and gives it a short cooldown to avoid a
# restart storm during an upstream outage.

set -Eeuo pipefail

APP_NAME=""
APP_PORT=""
RUNTIME_DIR=""
RUNTIME=""
SERVICE_USER=""
COOLDOWN_SECONDS="${CTS_RECOVERY_COOLDOWN_SECONDS:-120}"
CRON_STALE_SECONDS="${CTS_RECOVERY_CRON_STALE_SECONDS:-150}"

usage() {
  echo "Usage: runtime-recovery.sh --name NAME --port PORT --runtime-dir PATH --runtime systemd|pm2 [--service-user USER]" >&2
}

valid_name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }
valid_runtime_dir() { [[ "$1" =~ ^/[A-Za-z0-9._/-]+$ && "$1" != "/" && "$1" != *"//"* && "$1" != *"/../"* ]]; }
valid_user() { [[ -z "$1" || "$1" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]]; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) APP_NAME="${2:?--name requires a value}"; shift 2 ;;
    --port) APP_PORT="${2:?--port requires a value}"; shift 2 ;;
    --runtime-dir) RUNTIME_DIR="${2:?--runtime-dir requires a value}"; shift 2 ;;
    --runtime) RUNTIME="${2:?--runtime requires a value}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:?--service-user requires a value}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

valid_name "$APP_NAME" && valid_port "$APP_PORT" && valid_runtime_dir "$RUNTIME_DIR" \
  && [[ "$RUNTIME" =~ ^(systemd|pm2)$ ]] && valid_user "$SERVICE_USER" \
  || { echo "Invalid runtime recovery configuration" >&2; exit 2; }
[[ "$COOLDOWN_SECONDS" =~ ^[0-9]+$ ]] || COOLDOWN_SECONDS=120
[[ "$CRON_STALE_SECONDS" =~ ^[0-9]+$ ]] || CRON_STALE_SECONDS=150
(( CRON_STALE_SECONDS >= 90 )) || CRON_STALE_SECONDS=90

# A deliberate `service-control stop` creates this marker. Self-healing must
# never turn a maintenance stop into an unexpected live restart.
[[ ! -e "$RUNTIME_DIR/maintenance-stop" ]] || { echo "[runtime-recovery] maintenance stop is active"; exit 0; }

mkdir -p "$RUNTIME_DIR"
exec 9>"$RUNTIME_DIR/runtime-recovery.lock"
flock -n 9 || exit 0

now_epoch="$(date +%s)"

can_restart() {
  local service="$1" stamp="$RUNTIME_DIR/recovery-${service}.epoch" previous=0
  [[ -r "$stamp" ]] && previous="$(<"$stamp")"
  [[ "$previous" =~ ^[0-9]+$ ]] || previous=0
  (( now_epoch - previous >= COOLDOWN_SECONDS )) || return 1
  printf '%s\n' "$now_epoch" > "$stamp"
  chmod 600 "$stamp" 2>/dev/null || true
  return 0
}

pm2_as_service() {
  local home
  home="$(awk -F: -v user="$SERVICE_USER" '$1 == user { print $6; exit }' /etc/passwd 2>/dev/null || true)"
  [[ -n "$home" && "$home" != "/" ]] || home="/var/lib/$APP_NAME"
  if [[ "$(id -un)" == "$SERVICE_USER" ]]; then
    env HOME="$home" PM2_HOME="$home/.pm2" pm2 "$@"
  elif (( EUID == 0 )); then
    runuser -u "$SERVICE_USER" -- env HOME="$home" PM2_HOME="$home/.pm2" pm2 "$@"
  else
    sudo -u "$SERVICE_USER" env HOME="$home" PM2_HOME="$home/.pm2" pm2 "$@"
  fi
}

service_active() {
  local service="$1"
  if [[ "$RUNTIME" == "systemd" ]]; then
    systemctl is-active --quiet "$service"
  else
    pm2_as_service describe "$service" >/dev/null 2>&1
  fi
}

# The app's init-status view is deliberately small and reads only persisted
# coordinator hashes.  That gives this root-owned supervisor a safe, local
# view of completed cron work without granting it Redis or exchange access.
read_cron_health() {
  local status
  status="$(curl -fsS --max-time 5 "http://127.0.0.1:$APP_PORT/api/system/init-status" 2>/dev/null || true)"
  [[ -n "$status" ]] || return 1
  printf '%s' "$status" | CTS_RECOVERY_CRON_STALE_SECONDS="$CRON_STALE_SECONDS" node -e '
    let raw = "";
    process.stdin.on("data", chunk => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(raw);
        const continuity = value?.system?.continuity || {};
        const direct = continuity?.direct_trade || {};
        const maxAge = Number(process.env.CTS_RECOVERY_CRON_STALE_SECONDS || 150) * 1000;
        const fresh = (age) => Number.isFinite(Number(age)) && Number(age) >= 0 && Number(age) <= maxAge;
        const coreFresh = fresh(continuity.last_tick_age_ms);
        const liveFresh = fresh(continuity?.live_recovery?.last_tick_age_ms);
        const directFresh = fresh(direct.last_tick_age_ms);
        const coreGood = !continuity.last_tick_result || continuity.last_tick_result === "ok";
        const liveGood = !continuity?.live_recovery?.last_tick_result || continuity.live_recovery.last_tick_result === "ok";
        process.stdout.write([
          coreFresh && coreGood ? "1" : "0",
          liveFresh && liveGood ? "1" : "0",
          directFresh ? "1" : "0",
          direct.recovery_requested === true ? "1" : "0",
        ].join(" ") + String.fromCharCode(10));
      } catch { process.exitCode = 1; }
    });
  '
}

restart_service() {
  local service="$1" reason="$2"
  if ! can_restart "$service"; then
    echo "[runtime-recovery] cooldown active for $service ($reason)"
    return 0
  fi
  echo "[runtime-recovery] restarting $service: $reason"
  if [[ "${CTS_RECOVERY_DRY_RUN:-0}" == "1" ]]; then return 0; fi
  if [[ "$RUNTIME" == "systemd" ]]; then
    systemctl reset-failed "$service" 2>/dev/null || true
    systemctl restart "$service"
  else
    pm2_as_service restart "$service" --update-env
  fi
}

app_service="$APP_NAME"
scheduler_service="$APP_NAME-scheduler"
direct_service="$APP_NAME-direct-trade"

if ! curl -fsS --max-time 5 "http://127.0.0.1:$APP_PORT/api/health/liveness" >/dev/null 2>&1; then
  restart_service "$app_service" "liveness endpoint unavailable"
  exit 0
fi

# A running scheduler process alone is not sufficient: it can be stuck while
# systemd/PM2 still reports it active.  Require completed core and live
# recovery ticks, then restart only the scheduler.  The Direct-Trade cron
# must also report even when it currently has no entry worker to supervise.
read -r core_cron_healthy live_recovery_healthy direct_cron_fresh direct_recovery_requested < <(read_cron_health || printf '0 0 0 0')
if [[ "$core_cron_healthy" != "1" || "$live_recovery_healthy" != "1" || "$direct_cron_fresh" != "1" ]]; then
  restart_service "$scheduler_service" "cron continuity is stale or degraded"
fi

if ! service_active "$scheduler_service"; then
  restart_service "$scheduler_service" "scheduler is inactive"
fi
if ! service_active "$direct_service"; then
  restart_service "$direct_service" "Direct-Trade worker is inactive"
  exit 0
fi

status="$(curl -fsS --max-time 5 "http://127.0.0.1:$APP_PORT/api/trade-engine/direct-trade/status" || true)"
[[ -n "$status" ]] || { restart_service "$direct_service" "Direct-Trade status unavailable"; exit 0; }

read -r direct_required direct_healthy < <(
  printf '%s' "$status" | node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const status = JSON.parse(raw);
        const required = status?.state?.enabled === true || Number(status?.openPositions || 0) > 0;
        process.stdout.write(`${required ? "1" : "0"} ${status?.processor?.isHealthy === true ? "1" : "0"}` + String.fromCharCode(10));
      } catch { process.stdout.write("1 0" + String.fromCharCode(10)); }
    });
  '
)

if [[ "$direct_required" == "1" && "$direct_healthy" != "1" ]]; then
  if [[ "$direct_recovery_requested" == "1" ]]; then
    restart_service "$direct_service" "Direct-Trade continuity requested recovery"
  else
    restart_service "$direct_service" "Direct-Trade heartbeat is stale"
  fi
fi
