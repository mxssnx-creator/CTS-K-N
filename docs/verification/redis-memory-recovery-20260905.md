# Redis memory incident and production repair — 2026-09-05

## Observed incident

The shared native Redis on the 16 GiB production host was killed by the kernel
OOM handler. Its AOF replay then repeatedly exceeded systemd's 90-second
startup timeout. The service restart counter increased from 55 to 63 before
recovery completed. The durable source dataset reported 18,739,261,928 bytes
at save time; loaded memory peaked at 21,445,694,856 bytes. The old governor
raised maxmemory to 25,232,932,864 bytes, above the physical host capacity.

## Repair and prevention

- Bound the governor's used-memory floor to half the host's memory, scaled by
  the number of independent Redis processes. Normal preferred allocation
  remains 25%; pressure/build targets remain lower. noeviction preserves
  durable accounting keys. An over-budget dataset is reported explicitly.
- Reserve the other half for workers and the OS; do not permit a background
  persistence fork without a full dataset's copy-on-write reserve plus 512 MiB.
- Defer maintenance during loading, snapshots, or an existing rewrite. Throttle
  purge attempts and failed AOF rewrite attempts, and persist cooldown state
  in the durable per-instance data directory across systemd oneshot runs.
- Backups copy and validate the complete native AOF chain without a Redis
  fork. Rotated manifests or incomplete/corrupt command tails are retried and
  rejected, never repaired/truncated silently. RDB-only backups require full
  copy-on-write headroom; connection/recovery deadlines are bounded. Native
  restore verification recovered all 400 fixture entries, ownership and exact
  TTL with no persistence fork, and rejected corrupt input without mutation.
- Retain AOF every-second durability; disable automatic RDB snapshots and
  automatic AOF rewrites so the headroom-aware governor owns fork scheduling.
- Give native Redis 900 seconds to finish durable replay when the default
  90-second timeout is in use. Preserve existing longer/custom timeouts.
- Enable native list compression. The bounded maintenance script stages each
  indication history, compares every serialized entry and its ordering, and
  retains the original absolute expiry before an atomic rename. Live, order,
  position, settings and ownership namespaces are excluded.
- Reject OOM, transport and read-only write failures without invoking the
  legacy history conversion path or deleting existing history.

## Measured production result

The completed first pass scanned 139,735 indication keys and repacked 112,828
lists. It compared 20,838,428 entries. Affected-list memory fell from
18,567,269,703 to 4,157,911,996 bytes: **14,409,357,707 bytes reclaimed**.
Total Redis allocation subsequently measured 6,881,313,096 bytes (6.41 GiB).
Available host memory rose from about 211 MiB to 3,486 MiB; swap in use fell
from almost 18 GiB to 3,677 MiB. Redis NRestarts remained 63 after recovery.
All three CTS-K-N runtime services remained active with NRestarts=0.
A local HTTP health request returned 200 in 46 ms.

A separate listpack-rebuild pilot preserved its 387 entries but only saved
3,894 additional bytes in 100 sampled keys. It was not expanded to a second
full production pass. The committed maintenance tool uses the successful
DUMP/RESTORE representation change, avoiding that unnecessary rewrite load.

## Verification and release boundary

The updated complete pre-deployment checkpoint is
`/var/backups/cts-kn/pre-production-memory-deploy-20260905T143918Z`; it includes
all six AOF segments and the executable .next/node_modules rollback artifacts.
All 18 checkpoint files and the source bundle were verified.

- Isolated native Redis verification: exact list values/order, unchanged
  absolute expiry, persistent-key lifetime, collision rejection, protected
  namespaces and repeated logical idempotence passed; fixture memory fell
  from 274,896 to 25,024 bytes in the DUMP/RESTORE test.
- Full Jest validation passed: 285 suites / 1,962 tests. TypeScript and ESLint
  passed. Production build passed with 349 complete traces before the
  standalone backup-helper follow-up; the installer rebuilds the merged release.
- Regression coverage includes the original 18.7 GB oversized dataset,
  compressed production sizing, loading/busy persistence, fork headroom,
  failed-attempt cooldowns, and non-destructive OOM/transport handling.
- Original protected source/config/Redis checkpoint:
  `/var/backups/cts-kn/redis-oom-20260905T135159Z` (all active AOF segments,
  manifest, RDB, source bundle, configuration, checksums and bundle verified).
- Temporary production measures are already active: list compression,
  900-second replay timeout and guarded persistence configuration. The old
  governor timer was stopped before repair and must be replaced by the merged
  corrected version before restoration.
- This report does not assert feature deployment, a successful X02 lifecycle,
  complete venue account statistics, or a sustained load-test pass. These
  require acceptance on the merged deployed revision.

## Merged production verification and follow-up

PR317 was merged as `3a6a136bca637b218d7709db02081ba9b1a269c0`.
GitHub Actions passed on the PR and main; local and remote installations passed
285 suites / 1,962 tests, TypeScript, lint and complete production traces.
The managed clean reinstall and restart verification completed successfully.
All three CTS services are active with NRestarts=0. Redis remains at the
incident's NRestarts=63; no new Redis restart occurred during repair/deployment.
At 16:08 UTC Redis used 3.07 GiB versus the incident's 19.97 GiB peak.

The separate offline AOF maintenance reduced persistence from 35,866,913,708
to 4,337,377,411 bytes in 50 seconds (58,519,552-byte actual copy-on-write).
The governor subsequently rewrote with sufficient physical reserve and its
persisted cooldown. Post-startup derived-data cleanup also reduced allocation;
only the earlier 14,409,357,707-byte repack is claimed as exact lossless savings.

Verified rollback checkpoints include:
- `/var/backups/cts-kn/pre-production-memory-deploy-20260905T143918Z`
- `/var/backups/cts-kn/pre-x02-memory-release-vst-20260905T153436Z`

The authenticated X02 VST run on this release lasted 925,061 ms, completed
11 lifecycle cycles and stopped during cycle 12 on an open-order snapshot
100421 timestamp rejection. Owned exposure was fully reconciled, cleanup
reported no errors or account differences, and production services restarted.
This harness uses an isolated local ledger; its virtual venue fills are not a
claim of native production ledger acceptance. The full 20-minute gate did not
pass. No mainnet or foreign account orders were changed.

The failure exposed missing lazy signing and clock-error recovery in account
snapshots. The follow-up signs open orders, order history and position reads at
dispatch and retries exactly once after a timestamp rejection/resynchronization.
It also prevents Overview request overlap, aborts closed scopes, separates logs
from stats, and labels failed refreshes without fabricating zero metrics.
Exact stage numerator/denominator values determine their displayed percentage.

Legacy Vercel integrations remain outside the successful GitHub Actions gate:
one still invokes the intentionally removed vercel-build script.
