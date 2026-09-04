# CTS Production Handoff

This is the credential-free entry document for continuing CTS-K-N or a second
CTS instance in a future chat. Read it together with
[`PRODUCTION-OPERATIONS.md`](./PRODUCTION-OPERATIONS.md) and
[`CHISEL-REMOTE-INFO.md`](./CHISEL-REMOTE-INFO.md). Never paste or commit
private keys, Chisel authentication, exchange secrets, raw account responses,
Redis snapshots, or the contents of the persistent credential archives.

## Production identity

| Item | CTS-K-N production value | Per-instance rule |
| --- | --- | --- |
| Git repository | `mxssnx-creator/CTS-K-N` | One immutable merged `main` commit per release |
| Checkout | `/opt/cts-kn` | `/opt/<project-name>` |
| Service identity | `cts-kn` | Unique `<project-name>` |
| HTTP port | `3002` | Unique port |
| Durable state | `/var/lib/cts/instances/cts-kn` | `/var/lib/cts/instances/<project-name>` |
| Environment | `/var/lib/cts/instances/cts-kn/.env.production.local` | Inside the durable state root |
| Backups | `/var/backups/cts/cts-kn/<UTC timestamp>` | Latest 3 verified generations under `/var/backups/cts/<project-name>` |
| Redis namespace | logical DB `0` on native Redis | Unique DB, or unique npm Redis port plus DB |
| Public URL | `http://152.53.114.112:3002/` | URL matching the instance port |

The Git checkout is replaceable. The state and backup roots are not. Clean
reinstallation, update, uninstall, or rollback must preserve the durable state
root and every permanent backup.

## Durable state contract

Each instance owns this hierarchy:

| Path below `/var/lib/cts/instances/<name>` | Purpose | Normal access |
| --- | --- | --- |
| `.env.production.local` | Effective runtime environment and generated signing secrets | `root:<service-group>`, `0640` |
| `credentials/` | Raw credential archives and normalized `runtime.env` fallback | Directory `0700`; secret files `0600` |
| `forex/` | Raw Forex/InstaForex information and normalized `runtime.env` fallback | Directory `0700`; secret files `0600` |
| `data/` | SQLite and file-backed application state | Service writable |
| `redis/` | Per-instance npm Redis or inline-snapshot persistence | Service writable |
| `logs/` | Durable bounded application/installer logs | Service writable |
| `reports/` | Durable verifier and operator reports | Service writable; checkout `.agent-logs` is a symlink |

On first converging install, legacy `/var/lib/<name>` state is copied into the
canonical hierarchy without deleting the legacy recovery source. Non-empty
values already present in the main environment always win. Missing credential
values are filled from, in order:

1. `<state>/credentials/runtime.env`;
2. `<state>/forex/runtime.env`;
3. compatible legacy sibling fallback files.

The installer never prints fallback values. Runtime services read the effective
main environment, not raw upload files. For CTS-K-N, the preserved archives are
the BingX X01 file, BingX X02 Prod-VST file, and InstaForex information file;
their filenames and hashes are operational inventory, but their contents must
never appear in Git or reports.

## Multi-instance installation

Identity is determined by project name, checkout, port, durable state path,
Redis namespace, runtime user, repository, and branch. The installer rejects a
collision with any other registered checkout before stopping or replacing
anything. Saved `.cts-runtime/install-values.env` metadata is authoritative on
update and preserves Redis mode plus `live` versus `safe-simulation` mode.

CTS-K-N production:

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
  --redis-mode native \
  --redis-db 0 \
  --public-url http://152.53.114.112:3002 \
  --repository https://github.com/mxssnx-creator/CTS-K-N.git \
  --branch main \
  --enable-live \
  -- --reinstall
```

Independent CTS-G example on the same host:

```bash
bootstrap_dir="$(mktemp -d)"
git clone --depth 1 --branch main https://github.com/mxssnx-creator/CTS-K-N.git "$bootstrap_dir"
sudo bash "$bootstrap_dir/scripts/bootstrap-install.sh" \
  --dir /opt/cts-g \
  --name cts-g \
  --port 3003 \
  --runtime systemd \
  --service-user cts-g \
  --state-dir /var/lib/cts/instances/cts-g \
  --redis-mode native \
  --redis-db 1 \
  --public-url http://152.53.114.112:3003 \
  --repository https://github.com/mxssnx-creator/CTS-K-N.git \
  --branch main \
  --safe-simulation \
  -- --reinstall
```

Use a unique `--redis-port` as well when `--redis-mode npm` is selected. Native
Redis instances share port 6379 but use distinct logical DBs. The installer
derives DBs from ports when omitted, validates all collisions, and allocates
exchange rate-limit and npm-Redis memory shares across detected instances.

`--enable-live` is the installation default. `--safe-simulation` is the explicit
fail-closed override and is preserved on later clean updates unless the operator
explicitly changes it.

## Removal, reinstall, backup, and rollback

Always use `bootstrap-install.sh`; do not recursively delete `/opt`, `/var/lib`,
or `/var/backups`. Before replacement it:

1. resolves the exact saved identity;
2. enters maintenance and stops only matching CTS owners;
3. captures recovery state outside the checkout;
4. creates a permanent timestamped backup containing only persistent CTS state,
   environment when external, a verified Git source bundle, an online Redis RDB
   when available, and a checksum-verified `SHA256SUMS` manifest;
5. clones the requested branch into a clean target;
6. restores state and runs the complete installer;
7. keeps the permanent backup after success and retains resumable recovery state
   if installation fails.

Package-manager caches, PM2 internals, build artifacts and service-user dotfiles
are never copied into permanent backups. After a new backup verifies, the
bootstrap retains the newest three verified generations by default
(`CTS_BACKUP_RETENTION_COUNT=3`). A malformed or unverifiable backup is retained
for operator inspection instead of being silently deleted.

Retries resume the newest exact-target recovery archive both when the target is
absent and when a replacement clone exists but has not yet produced authoritative
install metadata. The incomplete clone can never overwrite the prior archive.

Uninstall removes only the exact checkout, units, and managed runtime identity.
It intentionally preserves `/var/lib/cts/instances/<name>` and
`/var/backups/cts/<name>`.

## Runtime ownership and forced cleanup

For systemd, one instance owns:

- `<name>.service` — UI/API and Main Trade Engine;
- `<name>-scheduler.service` — portable minute coordination;
- `<name>-direct-trade.service` — leased Direct-Trade workers;
- `<name>-recovery.timer` — convergence and restart recovery;
- `<name>-redis-governor.timer` — dynamic Redis memory policy;
- `<name>-redis.service` only for the per-instance npm fallback.

Clean installation disables old matching services/timers, retires legacy Redis
memory units, removes matching PM2 owners, and force-terminates only processes
whose command/cwd proves ownership by the exact checkout. It never kills an
unrelated process merely because it occupies the requested port; that is a hard
preflight failure. Immutable legacy paths named
`<name>-release-<7-to-40-hex-SHA>` or
`<name>-rollback-pr<number>-<UTC-timestamp>-<7-to-40-hex-SHA>` are excluded
from identity and memory-share counts only when their saved name/port match the
target and no live process or matching systemd unit uses that exact root. Every
active snapshot and every ordinary parallel checkout remains a hard collision.

## Redis, memory, logs, and rate limits

- Local Redis uses AOF `everysec`, RDB checkpoints, protected mode, and
  `maxmemory-policy noeviction`; ownership, locks, and trade accounting are never
  silently evicted.
- The governor bases limits on the lower of host and cgroup capacity, current
  available memory, data-set size, pressure state, build state, and instance
  share. It steps gradually with hysteresis and can purge the allocator or bound
  AOF growth under pressure.
- Application heap, scheduler, and Direct-Trade budgets are derived from
  available memory after a host reserve; installation fails when a safe minimum
  cannot be provided.
- Exchange queues combine global and per-endpoint token buckets, bounded queues,
  priority scheduling, retry timing, and `CTS_EXCHANGE_RATE_LIMIT_SHARE` so
  parallel instances do not each assume the venue's full allowance.
- every Redis/in-process diagnostic sink retains at most 1,000 rows; evicted
  Monitoring/Error payload hashes are deleted and new payloads receive TTLs;
- the shared five-minute `cts-log-retention.timer` keeps regular host and CTS
  text logs at the newest 1,000 lines and at most 8 MiB per file without
  traversing data, credentials, Redis state, reports or backups;
- systemd-journald is capped at 256 MiB/7 days (64 MiB runtime), while service
  rate limits and signature/time-window coalescing suppress repeated messages.

## Stage and UI accounting contract

Every active Main Connection card always renders all four stage rows. Missing or
warming data is displayed as zero/pending rather than removing a row. Historic
Overall and Realtime are independent views.

| Stage | Primary card values | Exact meaning |
| --- | --- | --- |
| Base | `Total`, `Valid` | Complete Sets with open positions; subset evaluated against Base PF minimum, default `0.80` |
| Main | `Valid`, `Overall` | Base-valid Sets meeting Main rules; valid Sets plus calculated Normal/Trailing/Block/DCA rows, with Block excluded from additive Overall while Block-Only is active |
| Real | `Valid`, `Active` | Main Overall rows passing rolling Real PF/DDT; active count normalized to one per Base lineage even when position-count variants exist |
| Live | `Total`, `Orders` | Actual Long + Short exchange positions across symbols; unique independent placed/running orders |

Row-Real is calculated from exact recent-position windows (default 20) after the
active Real Block processing. Row-Live is calculated from Row-Real with its own
20-position PF/DDT window. A qualifying Row-Live is mirrored directly to Live;
there is no hidden extra evaluation. Row-Live Block has independent settings,
seeded from active Block settings. Block-Only defaults to enabled.

The Live row also reports the Real-to-Live PF ratio/difference over the latest
50 matched closed positions, or all available matched positions when fewer than
50 exist. Ratios use `1.0 = 100%`. Realtime displays stage averages separately
from cumulative Historic totals and updates through overlap-safe polling,
sequence guards, adaptive freshness, and canonical recoordination events.

## Reset, settings, QuickStart, and race guarantees

- Reset-DB and migration actions authorize the same-origin admin session or an
  explicit bearer secret before touching Redis; in-process migration guards are
  reset after a flush so schema 107 is rebuilt immediately.
- Main Connections settings use one client single-flight save, one deterministic
  PATCH, a bounded abort, same-origin credentials, no-store reads, serialized
  server commits, Redis locking, and generation-safe recoordination.
- QuickStart persists settings before engine start, reuses already running
  progressions, emits one versioned recoordination, and returns success only
  after required heartbeats/coverage become current.
- Redis mirrors are selected by their own activity timestamp. Pollers reject
  overlap and stale responses; stage snapshots are generation-consistent.

## Exchange safety and X02 verification

Live capability is restricted by `LIVE_ORDER_CONNECTION_IDS=bingx-x02`.

- BingX X02 uses Prod-VST virtual funds and is the only authorized write target.
- BingX X01/Mainnet, Bybit, InstaForex, and every other venue are read-only.
- Existing external orders and pre-existing positions must be snapshotted and
  left unchanged.
- Controlled X02 tests require maintenance mode and inactive app, scheduler, and
  Direct-Trade services; use minimum executable virtual volume and CTS-owned
  client IDs.
- Cleanup may close/cancel only IDs created by that test. Final state must have
  zero remaining CTS test orders/positions and an unchanged external baseline.

Use [`BINGX-VST-ORCHESTRATED-VERIFIER.md`](./BINGX-VST-ORCHESTRATED-VERIFIER.md)
for the guarded lifecycle command and evidence format.

## Vercel status

CTS production has no Vercel runtime dependency. Source/runtime Vercel branches,
configuration, and generated artifacts are forbidden. Kilo/Cloudflare files are
a separate optional deployment target and are not Vercel. An external Vercel
project must only be reported removed after the provider API confirms deletion;
source cleanup alone is not proof of external deletion.

As of the 2026-09-04 release check, the external `cts-k-n` Vercel project still
exists. The connected provider integration is read/deploy-only and exposes no
project-deletion operation. Its removal therefore remains an explicit external
access blocker and must not be represented as complete until a write-capable
Vercel session confirms deletion.

## Release gates

Run against the exact candidate tree:

```bash
pnpm run typecheck
pnpm run lint
pnpm run test:all
pnpm run build
pnpm run security:scan
pnpm run docs:recreation
pnpm run docs:recreation:verify
```

Then merge through GitHub, require successful CI on the PR, deploy only merged
`main`, and verify the remote checkout is clean and exactly matches the merged
SHA. After install, verify service/timer enablement, Redis persistence and schema
107, restart continuity, `/api/health`, QuickStart, maximum-symbol rotations,
all indicator/strategy lanes, Stage/Realtime stats, settings dialogs, reset auth,
controls/actions/events, sustained polling, browser console/network state, and
the controlled X02 lifecycle.

## Chisel continuation rule

In ChatGPT Work, every remote command process must source the managed activation,
verify the pinned harmless SSH banner, and perform all follow-up SSH commands in
that same process. A listener or PID from another process is not reusable. Use
the exact credential-free procedure in `CHISEL-REMOTE-INFO.md`; never bypass the
pinned fingerprint or SSH known-host check.

## Future-chat checklist

1. Read this file, `PRODUCTION-OPERATIONS.md`, and `CHISEL-REMOTE-INFO.md`.
2. Inspect GitHub `main`, open PRs, CI, and the exact deployed SHA before edits.
3. Keep production in maintenance while candidate, backup, or migration status
   is uncertain.
4. Never display secret values; compare only key names, modes, sizes, and hashes.
5. Back up before every clean reinstall and retain the latest three verified generations.
6. Push a feature branch, pass CI, merge, and deploy only merged `main`.
7. Record exact test counts, merged/deployed SHA, backup path, all-symbol
   coverage, browser result, Redis/memory result, and X02 cleanup result below.

## Current release record

- Candidate date: 2026-09-04.
- Redis schema: 107.
- Focused migration/install/UI/stage regressions: passing (268 tests).
- Full local Jest with open-handle detection: 267 suites and 1,838 tests passed;
  no open-handle warning.
- TypeScript, ESLint, shell syntax, two optimized Next.js production builds, and
  release secret scan: passing; no secret findings.
- Public BingX read-only stress: 128 unique symbols, 25,599 candle rows, 135
  attempts, zero failed/timed-out/authenticated/order requests, peak RSS 75.85
  MiB, maximum event-loop delay 18.48 ms.
- Direct-Trade matrix: 960,512 evaluated Sets and 22,459 valid Sets across all
  strategy types; Block ledger comparison covered 120,064 Base rows plus
  1,419,264 variant rows with zero identity mismatches.
- Parallel deterministic benchmark: all specifications completed at up to
  approximately 74,087 Sets/s; maximum parent event-loop delay 20.79 ms.
- Local production-preview startup was intentionally not bypassed because this
  workspace has no shared Redis daemon. The exact preview, GitHub PR/CI/merge,
  remote convergence, browser acceptance, maximum-symbol production run, and
  controlled X02 lifecycle remain required before declaring production ready.
