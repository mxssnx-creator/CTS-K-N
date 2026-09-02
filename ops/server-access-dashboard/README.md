# Server access dashboard

This is the versioned, read-only dashboard served at the server root by nginx.
It is intentionally separate from the trading UI and does not expose exchange
credentials, Redis URLs, request payloads, or control actions.

The metrics endpoint is:

    GET /__server/api/metrics

It reports:

- exact kernel memory counters in bytes and MiB/GiB, including used,
  available, cache, buffers, reclaimable memory, committed memory, dirty
  pages, writeback, and swap used/free/total;
- aggregate CPU plus sampled user/system/idle/I/O-wait/steal percentages for
  every CPU core;
- load average, exact network byte totals and transfer rates;
- dashboard and systemd process RSS, virtual memory, threads, CPU time,
  task counts, restart counts, exit status, and activation time;
- CTS-K-N and CTS-G health/probe status, Redis health when reported, engine
  connection IDs, progression lanes, cycle counts, latency, and per-project
  failure/state-change activity;
- dashboard request rates, status distribution, p50/p95/max latency, recent
  state-change events, and stability counters.

## Controlled installation

Run only from the merged main checkout, after the required remote backup has
been verified. Remote access must use the managed Chisel activator and the
local forwarded SSH endpoint documented in the project context. Do not copy
environment files or credentials into this directory.

    cd /workspace/CTS-K-N
    sudo install -d -m 755 /opt/server-access/server /opt/server-access/public
    sudo install -m 644 ops/server-access-dashboard/server/access-dashboard.mjs /opt/server-access/server/
    sudo install -m 644 ops/server-access-dashboard/public/index.html /opt/server-access/public/
    sudo install -m 644 ops/server-access-dashboard/public/dashboard.js /opt/server-access/public/
    sudo install -m 644 ops/server-access-dashboard/deploy/server-access-dashboard.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now server-access-dashboard.service
    sudo nginx -t
    sudo systemctl reload nginx

The service binds to 127.0.0.1:3004; nginx maps / and /__server/ to it.
Project base URLs and the service list are configurable with
CTS_KN_BASE_URL, CTS_G_BASE_URL, and SERVER_DASHBOARD_SERVICES.

## Persistent 18 GiB swap

ensure-swap-18g.sh is idempotent and refuses to overwrite an existing file
with an unexpected size or format. It checks free disk space, creates
/swapfile-cts-kn at exactly 18 GiB, enables it, persists it in /etc/fstab,
and applies conservative memory-pressure settings.

    sudo bash ops/server-access-dashboard/deploy/ensure-swap-18g.sh

Verify with swapon --show, free -h, and the dashboard's Swap cards. If an
active swap file already exists with a different size, stop and review it
instead of resizing live memory infrastructure.
