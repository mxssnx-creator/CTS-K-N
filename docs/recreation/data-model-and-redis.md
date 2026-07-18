# Data model and Redis

## Persistence contract

Redis is the runtime source of truth. Production must use a cross-instance
backend through `REDIS_URL`, `KV_URL`, an Upstash REST pair, or a Vercel/KV REST
pair. InlineLocalRedis exists for tests/local diagnostics and optional local
snapshot recovery; it cannot unlock live trading in a multi-instance or
serverless production deployment.

`lib/redis-db.ts` exposes the adapter and domain helpers. Callers should use
bounded indexes, lists, hashes and sorted sets rather than `KEYS` in hot paths.
Migrations may scan when needed; runtime APIs use explicit indexes or bounded
scan helpers.

## Major key families

The exact current source inventory is generated, and two supporting audits live
at `docs/live-order-redis-keys.md` and `docs/redis-client-keys-audit.md`.

| Family/pattern | Data type | Purpose |
| --- | --- | --- |
| `_schema_version`, migration markers | string/hash | sequential schema ownership |
| `connections`, `connection:*`, connection indexes | hash/set | exchange/runtime connection configuration |
| `app_settings`, `settings:*`, `connection_settings:*` | hash/string | global/canonical/legacy settings layers |
| `strategies:{conn}:{symbol}:*` | string/hash | Base/Main/Real compact Set snapshots |
| `live_set_keys:{conn}` | set | exact live lineage index |
| `strategy_pos_entry_ids:{conn}` | set | idempotent confirmed entry IDs |
| `strategy_position_set_memberships:{conn}:{position}` | set | exact Set memberships per position |
| `strategy_set_entry_counts:{conn}` | hash | total confirmed entries per exact Set |
| `strategy_set_active_entry_counts:{conn}` | hash | active confirmed entries per exact Set |
| `strategy_set_result_ring:{conn}:{setKey}` | list | bounded realized PnL/DDT outcomes |
| `block_count_active:{conn}:{symbol}` | hash | active exact Block leg keys |
| `block_count_pause:{conn}` | hash | independent count pause states |
| `strategy_block_pf_stats:{conn}` | hash | Count1..10 and active Block PF snapshots |
| `real:position:*`, `real:positions:index:*` | string/set | RealPosition snapshots and index |
| live position/order key families | string/set/hash | authoritative local order/position/outbox state |
| progression/engine/runtime hashes | hash | owner intent, heartbeats, epochs, counters, settings completion |
| `system:coordination:continuity` | hash | minute scheduler heartbeat and outcome |
| `system:coordination:live-recovery` | hash | reconciliation heartbeat and outcome |
| minute-dedup keys | string with TTL | exactly-once-per-minute cron lease |
| site-instance identity | string/hash | persistence/restart proof |

Do not infer a new key solely from this summary. Search the source and generated
manifests before changing a family, then update clear/reset, migration, backup,
stats and tests together.

## Exact position ledger

An entry is counted only after a confirmed venue/paper fill. Recording is
idempotent by `entryId`. The position stores every exact lineage key; aggregate
hashes count active and total membership. On close:

1. realized outcome is written once to each exact/parent result ring;
2. active counts are decremented without going negative;
3. exact active Set indexes are removed;
4. Block active indexes and pauses advance idempotently;
5. position membership is removed only after outcome booking.

This ordering prevents a crash window where a position disappears but its PF
sample is lost. A replay cannot double-count the close.

## Result-ring ProfitFactor

Each list entry carries realized PnL, timing/DDT data and timestamp. Window
readers take the latest requested N values. ProfitFactor is gross positive PnL
divided by absolute gross loss; no loss with positive gross profit is represented
by the bounded high-PF convention used in the code. The minimum sample count is
separate from the maximum window. Block exact counts use the same configured
window/minimum sample as normal PF but never share one another's ring.

## Schema migrations

`lib/redis-migrations.ts` is the sole ordered schema bundle. Every migration has
a monotonically increasing integer version, name and idempotent application.
At this handoff the latest version is 81. Verification scripts derive/check the
repository maximum and reject a deployed older/different schema.

Rules for adding a migration:

1. append one next sequential version; never renumber published migrations;
2. make retries safe and tolerate missing legacy data;
3. add defaults to global, connection and preset stores where applicable;
4. update settings serializers, API/UI defaults, fingerprints, clear/reset and
   stats paths in the same change;
5. add a focused migration test and update deployment expected schema checks;
6. run the full migration and deployment test matrix.

The Block PF field is introduced/backfilled as `blockProfitFactorRatio=0.8` and
the latest migration establishes the current independent Block/DCA ledger/stat
shape. See `manifests/redis-migrations.tsv` for all versions and names.

## Retention and expiration

- Exact result rings are bounded by list trimming.
- Active Block indexes and PF stats receive explicit expiry where they are
  recoverable; pause state persists until advanced.
- Lock/outbox/dedup keys have finite TTLs appropriate to recovery.
- Permanent configuration, migrations, site identity, connection data and
  required progression intent are not treated as disposable cache.
- Admin clear-progressions distinguishes durable configuration from recoverable
  runtime keys; adding a new family requires classifying it explicitly.

## Backup and restore

Application backup APIs export/import supported Redis state. For disaster
recovery, also use the Redis provider's native encrypted snapshot/replication
facility. A valid restore must be followed by:

1. migration to repository latest;
2. index/connection count diagnostics;
3. site identity and shared-persistence verification;
4. live position/order reconciliation before any engine start;
5. continuity heartbeat verification;
6. explicit operator review of live-trade intent.

Never restore live order state into a different exchange account and allow
automatic placement before proving the venue is flat or successfully adopting
the existing positions/orders.
