#!/usr/bin/env bash
# Installs the live health monitor as a systemd timer (every 15 minutes).
#
# The monitor is copied to /opt/cts-monitor on purpose: a deploy removes and
# rebuilds /opt/cts-kn, and the monitor must keep running while that happens.
# Re-run this script after changing scripts/monitor-live-health.mjs.
#
#   sudo bash scripts/install-monitor.sh [--uninstall]
set -euo pipefail

TARGET_DIR="${CTS_MONITOR_DIR:-/opt/cts-monitor}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/monitor-live-health.mjs"

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl disable --now cts-kn-monitor.timer 2>/dev/null || true
  rm -f /etc/systemd/system/cts-kn-monitor.service /etc/systemd/system/cts-kn-monitor.timer
  systemctl daemon-reload
  echo "cts-kn-monitor removed (history stays in Redis under monitor:live-health:*)"
  exit 0
fi

[[ -f "$SRC" ]] || { echo "missing $SRC" >&2; exit 1; }
command -v node >/dev/null && command -v redis-cli >/dev/null || { echo "node and redis-cli are required" >&2; exit 1; }

install -d -m 0755 "$TARGET_DIR"
install -m 0755 "$SRC" "$TARGET_DIR/monitor-live-health.mjs"

cat > /etc/systemd/system/cts-kn-monitor.service <<UNIT
[Unit]
Description=CTS-K-N live health monitor (read-only, writes monitor:live-health:* to Redis)
After=cts-kn.service redis-server.service

[Service]
Type=oneshot
ExecStart=/usr/bin/node ${TARGET_DIR}/monitor-live-health.mjs
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=120
MemoryMax=300M
UNIT

cat > /etc/systemd/system/cts-kn-monitor.timer <<UNIT
[Unit]
Description=CTS-K-N live health monitor, every 15 minutes

[Timer]
OnBootSec=180s
OnUnitActiveSec=15min
AccuracySec=30s
RandomizedDelaySec=15s
Unit=cts-kn-monitor.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now cts-kn-monitor.timer
echo "installed: $TARGET_DIR/monitor-live-health.mjs, timer every 15 min"
echo "  journalctl -u cts-kn-monitor -p warning      findings only"
echo "  node $TARGET_DIR/monitor-live-health.mjs --report 8    last runs"
echo "  node $TARGET_DIR/monitor-live-health.mjs --latest      last verdict"
