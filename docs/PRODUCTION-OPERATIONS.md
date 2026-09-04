# CTS-K-N Production Operations and Continuity

This is the canonical handoff file for installation, recovery, verification,
and future work on CTS-K-N. It intentionally contains no secret values.

## Authoritative target

| Item | Value |
| --- | --- |
| Repository | `mxssnx-creator/CTS-K-N` |
| Production branch | `main` |
| Installation | `/opt/cts-kn` |
| Service name | `cts-kn` |
| Public application | `http://152.53.114.112:3002/` |
| Main environment | `/var/lib/cts/instances/cts-kn/.env.production.local` |
| Credential archive | `/var/lib/cts/instances/cts-kn/credentials` |
| Forex archive | `/var/lib/cts/instances/cts-kn/forex` |
| Backup root | `/var/backups/cts/cts-kn` |

The environment is outside the replaceable Git checkout. New installs default
to this location, existing install metadata remains authoritative, and clean
reinstalls preserve it. The installer creates the two archive directories as
root-only (`0700`). Normalized `runtime.env` fallback files in those directories
are read only by the root installer and fill missing credential values without
overwriting a non-empty value in the main environment. The application services
read only the main environment, normally `root:cts-kn` mode `0640`.

Never commit `.env*`, credential exports, exchange account responses, Redis
snapshots, private keys, or operator reports containing sensitive data.

## Runtime ownership

The production installation has one owner for each responsibility:

- `cts-kn.service`: web application and Main Trade Engine owner.
- `cts-kn-scheduler.service`: portable 60-second scheduler.
- `cts-kn-direct-trade.service`: leased Direct-Trade supervisor/workers.
- `cts-kn-recovery.timer`: convergence and health recovery.
- `cts-kn-redis-governor.timer`: host-relative Redis memory policy.
- native `redis-server` (or the installer-owned fallback): shared durable state.

The clean bootstrap stops every app, scheduler, Direct-Trade, recovery, and
Redis-governor unit (including the retired `redis-memory` timer) plus every PM2
owner, then terminates only stale processes proven to belong to `/opt/cts-kn`.
The fresh installer always re-arms maintenance even when those old services are
already inactive. An unrelated process on port 3002 is never killed;
installation fails with a clear port-ownership error.

## Exchange safety boundary

The installed application is live-capable by default (`--enable-live` is the
default), but capability is not permission to write everywhere. Production
pins `LIVE_ORDER_CONNECTION_IDS=bingx-x02`.

- BingX X02 uses the official Prod-VST virtual-funds origin and is the only
  connection authorized for supervised exchange writes.
- BingX X01, Bybit, and every other configured connection remain read-only for
  verification. Their credentials may be retained for account/status reads.
- InstaForex official HTTP access remains read-only. Live Forex execution needs
  a separately configured private MT4/MT5 bridge and is outside the X02 test.
- X02 tests use minimum valid virtual volume, CTS-owned client IDs, exact
  baseline snapshots, ownership checks, and complete cleanup.
- Existing external orders and pre-existing BTC/ETH positions are never adopted,
  cancelled, resized, or closed by a test.

The authenticated X02 verifier additionally requires its exact confirmation,
the maintenance marker, and inactive app/scheduler/Direct services before it
can read credentials or start a lifecycle child. See
`docs/BINGX-VST-ORCHESTRATED-VERIFIER.md`.

## Clean installation and update

Run from a temporary checkout so replacement is independent of the directory
being deleted:

```bash
bootstrap_dir="$(mktemp -d)"
git clone --depth 1 --branch main https://github.com/mxssnx-creator/CTS-K-N.git "$bootstrap_dir"
sudo bash "$bootstrap_dir/scripts/bootstrap-install.sh" \
  --dir /opt/cts-kn \
  --name cts-kn \
  --port 3002 \
  --runtime systemd \
  --service-user cts-kn \
  --state-dir /var/lib/cts/instances/cts-kn \
  --public-url http://152.53.114.112:3002 \
  --branch main \
  --repository https://github.com/mxssnx-creator/CTS-K-N.git \
  --redis-mode native \
  --redis-db 0 \
  --enable-live \
  -- --reinstall
```

The installer performs host preflight, pinned package installation, frozen
dependency installation, tests, typecheck, lint, production build, migrations,
service installation, restart-persistence verification, scheduler continuity,
deployment-contract checks, and rollback on failed final verification.

For a non-mutating package/host check:

```bash
bash scripts/install.sh --preflight-only --skip-system-packages --non-interactive
```

## Redis memory and log policy

Redis uses `noeviction` so locks, order ownership, and accounting records are
never silently evicted. The memory governor runs on a timer and derives its
target from host/cgroup total and currently available memory:

- normal: target near 25% of effective memory;
- build mode: near 18%;
- pressure: near 20%;
- critical: near 15%;
- never below the live data set plus a safety margin;
- 64 MiB target steps, hysteresis at pressure boundaries;
- allocator purge under pressure or sustained fragmentation;
- bounded AOF rewrites when file growth materially exceeds the data set.

Application, scheduler, Direct worker, Redis, recovery, and governor units have
journal rate limits. Repeated runtime failures are coalesced by signature and
time window; they remain counted without generating a message storm.

The lifetime-contribution hash is bounded while cumulative lifetime totals stay
monotonic. Pruning is dry-run by default and apply mode requires maintenance plus
an exact confirmation. Never delete that hash ad hoc.

## UI, auth, progression, and race guarantees

- Admin reset/migration actions authenticate with the same-origin session and
  every reset route awaits the shared admin authorization before Redis access.
- Main Connections settings use one server PATCH, a client single-flight guard,
  a 45-second abort, same-origin credentials, no-store reads, robust non-JSON
  error reporting, and versioned recoordination events.
- Server settings commits are serialized locally and with a shared Redis lock.
  Persistence is acknowledged before success; stale generations cannot clear a
  newer pending recoordination.
- Pollers suppress overlap and stale responses. Dashboard updates are tied to
  canonical settings/recoordination events and guarded sequence numbers.
- Restart publishes running intent before startup, fails closed on Redis/start
  errors, and returns success only after the coordinator plus every eligible
  connection has a fresh active heartbeat. Redis state mirrors are selected by
  their own activity time so stale hashes cannot overwrite fresh state.
- Realtime progress distinguishes one tick from full symbol rotation. A symbol
  counts as covered only after its complete indication → pseudo-position →
  strategy pipeline succeeds in an admitted tick for the current generation.
  Failed and stalled symbols remain visible in the UI.

## Release verification

Run these gates against the exact candidate tree:

```bash
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run test:integration
pnpm run build
pnpm run security:scan
pnpm run docs:recreation
pnpm run docs:recreation:verify
```

After installation:

```bash
sudo systemctl status cts-kn cts-kn-scheduler cts-kn-direct-trade --no-pager
sudo systemctl status cts-kn-recovery.timer cts-kn-redis-governor.timer --no-pager
redis-cli ping
curl -fsS http://127.0.0.1:3002/api/health
DEPLOYMENT_URL=http://127.0.0.1:3002 REQUIRE_SHARED_PERSISTENCE=1 \
  REQUIRE_FRESH_CONTINUITY=1 bash scripts/post-deploy-verify.sh
```

Then verify the public URL and browser workflows: login/session state, Main
Connections cards, Save Settings, QuickStart, progression dialog, statistics,
engine controls, monitoring, logs, and continuous refresh. Browser success must
include no page errors, no unexpected console errors, no failed API requests,
and stable updates over repeated polling windows.

## X02 progression and lifecycle verification

1. Capture baseline connections, balances, positions, open orders, and service
   state without mutations.
2. Run the exhaustive all-symbol computational phase with exchange submission
   forced off. Require unique full coverage for every discovered symbol and all
   indicator/strategy lanes.
3. Stress concurrent stats, progression, controls, SSE/fallback polling, memory,
   Redis key growth, event-loop lag, and restart/recoordination behavior.
4. Enter maintenance and stop the three trading services.
5. Run authenticated X02 Prod-VST preflight. Continue only if ownership and
   order-capacity gates pass.
6. Run the minimum-volume lifecycle on representative safe symbols. Require
   protection creation, position confirmation, controlled close, and cleanup.
7. Compare final state to baseline. Zero CTS test orders/positions may remain;
   external orders and pre-existing positions must be unchanged.
8. Restore production services and repeat health, continuity, progression,
   stats, UI, and log checks in production mode.

## Troubleshooting

If `http://152.53.114.112:3002/` is unavailable, check in this order:

1. `.cts-runtime/maintenance-stop` and service states;
2. scoped stale processes and port 3002 ownership;
3. `redis-cli ping`, memory policy, AOF/RDB health, and disk capacity;
4. `journalctl -u cts-kn -u cts-kn-scheduler -u cts-kn-direct-trade`;
5. local `/api/health/liveness`, `/api/health/readiness`, and init status;
6. firewall/listener address and public HTTP reachability;
7. exact deployed Git SHA versus merged `main`.

Do not clear maintenance or restart old binaries during a replacement. Keep the
marker until the merged candidate, durable environment, Redis recovery, and
post-deploy checks are ready.

## Current release record

Update this section after every production deployment with the exact merged SHA,
remote install result, test counts, all-symbol coverage, X02 lifecycle result,
browser result, Redis memory state, and remaining limitations. Never write
secret values or raw account data here.

- Candidate date: 2026-09-04
- Local unit tests: 1,750 passing across 260 suites.
- Local integration tests: 66 passing across 4 suites.
- TypeScript, ESLint, install preflight, shell/source syntax, and optimized
  production build: passing; build attempt 1 produced 42 static pages and 348
  complete server traces.
- Forced-simulated production artifact audit: 128 symbols, 47 page surfaces,
  all Main Connection/settings/backup/control/status checks, 20 hot API samples
  (p95 10.44 ms, max 29.60 ms), 0 real positions, and 0 exchange orders.
- Release secret scan: 1,609 files, 0 findings. Historical tracked private-key,
  Chisel binary/log, and embedded-auth helper artifacts were removed; only the
  parameterized strict-host-key connector remains in source.
- Remote install, all-symbol runtime coverage, X02 lifecycle, and final browser
  acceptance: pending final merged-revision deployment.
