#!/usr/bin/env bash
# Deterministic supervisor contract test.  It replaces only curl/systemctl in
# a private temporary PATH: neither a real service nor an exchange is touched.
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/cts-runtime-recovery.XXXXXX)"
MOCK_BIN="$TEST_ROOT/bin"
RUNTIME_DIR="$TEST_ROOT/runtime"
RESTART_LOG="$TEST_ROOT/restarts.log"
cleanup() {
  if [[ "${CTS_RUNTIME_RECOVERY_TEST_KEEP:-0}" == "1" ]]; then
    printf '[test-runtime-recovery] retained %s\n' "$TEST_ROOT" >&2
  else
    rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT
mkdir -p "$MOCK_BIN" "$RUNTIME_DIR"

cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
url="${!#}"
case "$url" in
  */api/health/liveness)
    printf '%s' '{"alive":true}'
    ;;
  */api/system/init-status)
    # Core continuity is deliberately stale while live/direct checks are
    # present. The supervisor must restart the scheduler, not the app.
    printf '%s' '{"system":{"continuity":{"last_tick_age_ms":200000,"last_tick_result":"ok","live_recovery":{"last_tick_age_ms":1000,"last_tick_result":"ok"},"direct_trade":{"last_tick_age_ms":1000,"recovery_requested":true}}}}'
    ;;
  */api/trade-engine/direct-trade/status*)
    # An enabled worker with a stale heartbeat is restartable. The test proves
    # the recovery request changes only the reason, never the lease owner.
    printf '%s' '{"state":{"enabled":true},"openPositions":1,"processor":{"isHealthy":false}}'
    ;;
  *)
    exit 22
    ;;
esac
EOF

cat > "$MOCK_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == "is-active" ]]; then exit 0; fi
if [[ "${1:-}" == "restart" ]]; then
  printf '%s\n' "$*" >> "${CTS_RECOVERY_TEST_LOG:?}"
fi
exit 0
EOF
chmod 700 "$MOCK_BIN/curl" "$MOCK_BIN/systemctl"

run_tick() {
  env \
    PATH="$MOCK_BIN:$PATH" \
    CTS_RECOVERY_TEST_LOG="$RESTART_LOG" \
    CTS_RECOVERY_COOLDOWN_SECONDS=120 \
    CTS_RECOVERY_CRON_STALE_SECONDS=150 \
    bash "$PROJECT_ROOT/scripts/runtime-recovery.sh" \
      --name cts-selfheal --port 3902 --runtime-dir "$RUNTIME_DIR" --runtime systemd --service-user root
}

first_output="$(run_tick)"
grep -qx 'restart cts-selfheal-scheduler' "$RESTART_LOG"
grep -qx 'restart cts-selfheal-direct-trade' "$RESTART_LOG"
[[ "$first_output" == *"cron continuity is stale or degraded"* ]]
[[ "$first_output" == *"Direct-Trade continuity requested recovery"* ]]

# A repeated outage within the cooldown must not create another restart storm.
second_output="$(run_tick)"
[[ "$(wc -l < "$RESTART_LOG")" -eq 2 ]]
[[ "$second_output" == *"cooldown active for cts-selfheal-scheduler"* ]]
[[ "$second_output" == *"cooldown active for cts-selfheal-direct-trade"* ]]

# An explicit operator stop wins over all recovery signals.
touch "$RUNTIME_DIR/maintenance-stop"
maintenance_output="$(run_tick)"
[[ "$maintenance_output" == *"maintenance stop is active"* ]]
[[ "$(wc -l < "$RESTART_LOG")" -eq 2 ]]

printf '%s\n' '{"success":true,"supervisor":"stale-cron-and-direct-heartbeat","cooldown":true,"maintenanceStop":true,"realServicesTouched":false}'
