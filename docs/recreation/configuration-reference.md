# Configuration reference

## Sources and precedence

CTS-K-N has four configuration layers:

1. code defaults and migration defaults;
2. global application settings;
3. connection settings (legacy plus canonical mirrored hashes);
4. current position-local recovery state for values that must survive restart.

Current canonical connection settings override global defaults. For DCA, new
persisted fields override a position-local profile on the next step. An
explicit RealPosition profile is the final override only when a caller
intentionally supplies it.

Settings writers do not directly mutate every consumer. They call serialized
recoordination, persist version/fingerprint/event state, invalidate coordinator
and engine caches, request a new strategy computation where needed, and expose
completion to the UI.

## Strategy settings that require hot reload

This list is representative; use `lib/settings-coordinator.ts`,
`lib/connection-recoordinator.ts`, `lib/progression-fingerprint.ts` and
`lib/trade-engine/settings-change-fields.ts` as the executable list.

- Base/Main/Real PF, DDT, confidence and minimum position counts;
- Previous/Last/Continuous/Pause enablement, ranges and steps;
- Default/Trailing/Block/DCA enablement and trailing variant matrix;
- Block volume, PF factor, maximum stack, pause and active overlays;
- DCA max steps, volumes, distances, TP mode, breakeven amount, cooldown;
- symbols, modes, position cost, leverage, margin and protection controls;
- Set ceilings, compaction thresholds and engine concurrency/timing controls.

## Essential production environment

The complete detected inventory is `manifests/environment-variables.tsv` and
the editable template is `.env.example`.

| Variable | Requirement |
| --- | --- |
| `NODE_ENV=production` | production Node host |
| `ADMIN_SECRET` | 16+ random chars; admin/install bearer |
| `CRON_SECRET` | 16+ random chars; scheduler bearer |
| `ENCRYPTION_KEY` | 16+ random chars; 32 bytes recommended |
| `JWT_SECRET` | 16+ random chars; session signing |
| one shared Redis configuration | required for production and all live trading |
| `NEXT_PUBLIC_APP_URL` / `DEPLOYMENT_URL` | absolute deployment origin; HTTPS when remote |
| `CTS_DEPLOYMENT_RUNTIME` | `systemd`, `pm2`, `kilo-deploy`, etc. |
| exchange API credentials | only for configured exchange actions |

Safe production values:

```dotenv
ALLOW_PROD_INLINE_REDIS=0
ALLOW_INLINE_REDIS_LIVE_TRADING=0
ENABLE_PRODUCTION_MIGRATIONS=1
AUTO_MIGRATE_ON_STARTUP=1
```

Do not set `FORCE_LIVE` in install seed files. The canonical installer blocks
it. Live intent is an authenticated, explicit operator action after connection
credentials and readiness are valid.

## Shared Redis alternatives

Configure one complete alternative:

- `REDIS_URL` (network Redis, TLS via `rediss://` when remote);
- `KV_URL`;
- `UPSTASH_REDIS_REST_URL` plus `UPSTASH_REDIS_REST_TOKEN`;
- `KV_REST_API_URL` plus `KV_REST_API_TOKEN`.

Host installation without an external URL provisions local Redis and enables
AOF plus snapshot policy. Kilo must use a remote cross-instance service.

## Kilo controller and runtime

The local deployment controller needs `CLOUDFLARE_API_TOKEN` and a 32-hex
`CLOUDFLARE_ACCOUNT_ID`. `scripts/kilo-deploy.mjs` never uploads these. The
Worker declares `ADMIN_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY` and `JWT_SECRET`
as required encrypted bindings.

For Remote SSH Install from Kilo:

```dotenv
REMOTE_INSTALL_OWNER_URL=https://owner.example.com
REMOTE_INSTALL_OWNER_SECRET=<the owner's ADMIN_SECRET>
```

The owner must be a distinct HTTPS origin running CTS-K-N on a long-lived Node
runtime. The Kilo API refuses an insecure, self-referential, missing or
short-secret owner configuration.

## Environment-file parsing

`scripts/run-with-env.mjs` parses KEY=VALUE without shell evaluation, then
spawns the requested process. Install seed files reject invalid names,
newlines, shell-control variables, PATH/HOME/NODE injection, `FORCE_LIVE`, and
live-placement overrides. Secrets are never passed as command-line arguments or
printed by the installer.

## Defaults and migrations

Every new operator setting needs all of the following:

- TypeScript interface and code default;
- global/connection/preset UI default and bounds;
- API parser/serializer and Redis representation;
- migration/backfill for existing stores;
- settings-change classification/fingerprint/invalidation;
- runtime consumption and stats/readback;
- focused settings-effect test, not only a UI/source-string assertion.

This is the acceptance rule that prevents a visible slider from being inert.
