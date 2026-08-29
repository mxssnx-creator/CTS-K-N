#!/usr/bin/env bash
# Deterministic supervisor contract tests. Only commands in a private temporary
# PATH are invoked; neither a real service, Redis instance nor exchange is
# touched.
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/cts-runtime-recovery.XXXXXX)"
MOCK_BIN="$TEST_ROOT/bin"
RUNTIME_DIR="$TEST_ROOT/runtime"
RESTART_LOG="$TEST_ROOT/restarts.log"
STATUS_CALLS="$TEST_ROOT/status-calls"
cleanup() {
  if [[ "${CTS_RUNTIME_RECOVERY_TEST_KEEP:-0}" == "1" ]]; then
    printf '[test-runtime-recovery] retained %s\n' "$TEST_ROOT" >&2
  else
    rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT
mkdir -p "$MOCK_BIN" "$RUNTIME_DIR"
: > "$RESTART_LOG"
: > "$STATUS_CALLS"

cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
url="${!#}"
case "$url" in
  */api/health/liveness)
    [[ "${CTS_RECOVERY_TEST_LIVENESS:-up}" == "up" ]] || exit 22
    printf '%s' '{"alive":true}'
    ;;
  */api/system/init-status)
    if [[ "${CTS_RECOVERY_TEST_CRON:-healthy}" == "stale" ]]; then
      printf '%s' '{"system":{"continuity":{"last_tick_age_ms":200000,"last_tick_result":"ok","live_recovery":{"last_tick_age_ms":1000,"last_tick_result":"ok"},"direct_trade":{"last_tick_age_ms":1000,"recovery_requested":true}}}}'
    else
      printf '%s' '{"system":{"continuity":{"last_tick_age_ms":1000,"last_tick_result":"ok","live_recovery":{"last_tick_age_ms":1000,"last_tick_result":"ok"},"direct_trade":{"last_tick_age_ms":1000,"recovery_requested":false}}}}'
    fi
    ;;
  */api/trade-engine/direct-trade/status*)
    mode="${CTS_RECOVERY_TEST_DIRECT:-fresh}"
    calls="$(wc -l < "${CTS_RECOVERY_TEST_STATUS_CALLS:?}")"
    printf '.\n' >> "${CTS_RECOVERY_TEST_STATUS_CALLS:?}"
    if [[ "$mode" == "recover" && "$calls" -ge 1 ]]; then mode="fresh"; fi
    case "$mode" in
      fresh)
        printf '%s' '{"state":{"enabled":true},"openPositions":1,"processor":{"isHealthy":true,"heartbeatHealthy":true,"progressHealthy":true}}'
        ;;
      stale-progress)
        printf '%s' '{"state":{"enabled":true},"openPositions":1,"processor":{"isHealthy":true,"heartbeatHealthy":true,"progressHealthy":false}}'
        ;;
      stale|recover)
        printf '%s' '{"state":{"enabled":true},"openPositions":1,"processor":{"isHealthy":false,"heartbeatHealthy":false,"progressHealthy":false},"connections":[{"required":true,"processor":{"recalculationInFlight":true}}]}'
        ;;
      *) exit 22 ;;
    esac
    ;;
  *) exit 22 ;;
esac
EOF

cat > "$MOCK_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  is-active)
    exit 0
    ;;
  show)
    if [[ "${CTS_RECOVERY_TEST_SERVICE_AGE:-old}" == "young" ]]; then
      awk '{ value = ($1 * 1000000) - 500000; if (value < 1) value = 1; printf "%.0f\n", value }' /proc/uptime
    else
      printf '%s\n' '1'
    fi
    ;;
  restart)
    printf '%s\n' "$*" >> "${CTS_RECOVERY_TEST_LOG:?}"
    ;;
  reset-failed)
    ;;
esac
EOF

cat > "$MOCK_BIN/sleep" <<'EOF'
#!/usr/bin/env bash
# Confirmation sampling is intentionally immediate in this deterministic test.
exit 0
EOF

chmod 700 "$MOCK_BIN/curl" "$MOCK_BIN/systemctl" "$MOCK_BIN/sleep"
for wrapper in start-app.sh start-scheduler.sh start-direct-trade.sh; do
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$RUNTIME_DIR/$wrapper"
  chmod 700 "$RUNTIME_DIR/$wrapper"
done

clear_scenario() {
  : > "$RESTART_LOG"
  : > "$STATUS_CALLS"
  rm -f -- \
    "$RUNTIME_DIR/recovery-cts-selfheal.epoch" \
    "$RUNTIME_DIR/recovery-cts-selfheal-scheduler.epoch" \
    "$RUNTIME_DIR/recovery-cts-selfheal-direct-trade.epoch" \
    "$RUNTIME_DIR/maintenance-stop"
  TEST_LIVENESS=up
  TEST_CRON=healthy
  TEST_DIRECT=fresh
  TEST_SERVICE_AGE=old
  TEST_BOOT_GRACE=0
}

run_tick() {
  env \
    PATH="$MOCK_BIN:$PATH" \
    CTS_RECOVERY_TEST_LOG="$RESTART_LOG" \
    CTS_RECOVERY_TEST_STATUS_CALLS="$STATUS_CALLS" \
    CTS_RECOVERY_TEST_LIVENESS="$TEST_LIVENESS" \
    CTS_RECOVERY_TEST_CRON="$TEST_CRON" \
    CTS_RECOVERY_TEST_DIRECT="$TEST_DIRECT" \
    CTS_RECOVERY_TEST_SERVICE_AGE="$TEST_SERVICE_AGE" \
    CTS_RECOVERY_COOLDOWN_SECONDS=120 \
    CTS_RECOVERY_CRON_STALE_SECONDS=150 \
    CTS_RECOVERY_BOOT_GRACE_SECONDS="$TEST_BOOT_GRACE" \
    CTS_RECOVERY_DIRECT_STALE_SAMPLES=3 \
    CTS_RECOVERY_DIRECT_SAMPLE_DELAY_SECONDS=1 \
    bash "$PROJECT_ROOT/scripts/runtime-recovery.sh" \
      --name cts-selfheal --port 3902 --runtime-dir "$RUNTIME_DIR" --runtime systemd --service-user root
}

# A newly started application gets time to publish its first liveness response.
clear_scenario
TEST_LIVENESS=down
TEST_SERVICE_AGE=young
TEST_BOOT_GRACE=180
boot_output="$(run_tick)"
[[ "$boot_output" == *"boot grace active for cts-selfheal"* ]]
[[ ! -s "$RESTART_LOG" ]]

# Recovery must not enter systemd's failure loop when deployment wrappers are
# absent or non-executable.
clear_scenario
TEST_LIVENESS=down
chmod 600 "$RUNTIME_DIR/start-app.sh"
wrapper_output="$(run_tick)"
[[ "$wrapper_output" == *"restart blocked for cts-selfheal"* ]]
[[ ! -s "$RESTART_LOG" ]]
chmod 700 "$RUNTIME_DIR/start-app.sh"

# Stale continuity restarts only the scheduler; a Direct worker needs three
# consecutive stale heartbeat samples before its own isolated restart.
clear_scenario
TEST_CRON=stale
TEST_DIRECT=stale
stale_output="$(run_tick)"
grep -qx 'restart cts-selfheal-scheduler' "$RESTART_LOG"
grep -qx 'restart cts-selfheal-direct-trade' "$RESTART_LOG"
[[ "$stale_output" == *"cron continuity is stale or degraded"* ]]
[[ "$stale_output" == *"heartbeat stale for 3 consecutive samples"* ]]
[[ "$stale_output" == *"continuity requested recovery"* ]]
[[ "$stale_output" == *"recalculation was in flight"* ]]
[[ "$(wc -l < "$STATUS_CALLS")" -eq 3 ]]

# The same outage inside the cooldown cannot create a restart storm.
: > "$STATUS_CALLS"
cooldown_output="$(run_tick)"
[[ "$(wc -l < "$RESTART_LOG")" -eq 2 ]]
[[ "$cooldown_output" == *"cooldown active for cts-selfheal-scheduler"* ]]
[[ "$cooldown_output" == *"cooldown active for cts-selfheal-direct-trade"* ]]

# Slow useful work is diagnostic degradation. A fresh dedicated heartbeat is
# never restartable solely because lifecycle progress is old.
clear_scenario
TEST_DIRECT=stale-progress
progress_output="$(run_tick)"
[[ "$progress_output" == *"heartbeat is fresh; progress is degraded without restart"* ]]
[[ ! -s "$RESTART_LOG" ]]
[[ "$(wc -l < "$STATUS_CALLS")" -eq 1 ]]

# A worker that recovers during confirmation sampling is left untouched.
clear_scenario
TEST_DIRECT=recover
recover_output="$(run_tick)"
[[ "$recover_output" == *"heartbeat recovered during confirmation sampling"* ]]
[[ ! -s "$RESTART_LOG" ]]
[[ "$(wc -l < "$STATUS_CALLS")" -eq 2 ]]

# Explicit operator maintenance wins over every health signal.
clear_scenario
TEST_LIVENESS=down
touch "$RUNTIME_DIR/maintenance-stop"
maintenance_output="$(run_tick)"
[[ "$maintenance_output" == *"maintenance stop is active"* ]]
[[ ! -s "$RESTART_LOG" ]]

printf '%s\n' '{"success":true,"bootGrace":true,"wrapperGuard":true,"consecutiveHeartbeatSamples":3,"recoveredWithoutRestart":true,"progressDegradationOnly":true,"cooldown":true,"maintenanceStop":true,"realServicesTouched":false}'
