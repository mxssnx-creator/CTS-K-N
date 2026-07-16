# Portable one-minute continuity

CTS-K-N no longer depends on Vercel Cron configuration. The same one-minute
coordination works in two deployment shapes:

1. A long-lived `next start`, Docker, PM2, systemd, or VPS process runs the
   in-process minute timer automatically. It also keeps live-position recovery
   on the configurable `cronSyncIntervalSeconds` cadence (15 seconds by default).
2. A serverless deployment sets `DISABLE_IN_PROCESS_CONTINUITY=1` and runs one
   external scheduler process. The scheduler calls both protected continuity
   routes once per minute without overlapping its own ticks.

## External scheduler process

Set the same secret in the application and scheduler environment:

```sh
CRON_SECRET="$(openssl rand -hex 32)"
SCHEDULER_BASE_URL="https://your-app.example"
```

Run continuously under your normal process supervisor:

```sh
pnpm scheduler:minute
```

For a host cron/systemd timer that already invokes commands once per minute,
use the single-run form:

```sh
pnpm scheduler:minute:once
```

The scheduler calls these routes in parallel:

- `/api/cron/server-continuity`
- `/api/cron/sync-live-positions`

Both require `Authorization: Bearer $CRON_SECRET` in production. Cloudflare's
existing `scheduled()` worker remains supported through `wrangler.jsonc`.

## Deployment rules

- Use shared Redis for multi-instance/serverless production. Local snapshots
  are appropriate only for one long-lived server and cannot coordinate several
  machines.
- Run exactly one dedicated engine owner. Passive API workers should set
  `DISABLE_TRADE_ENGINE_AUTOSTART=1` and `DISABLE_IN_PROCESS_CONTINUITY=1`.
- Do not expose `CRON_SECRET` through a `NEXT_PUBLIC_` variable.
- Verify configuration with `pnpm test:scheduler:minute`, then run
  `pnpm scheduler:minute:once` against the deployment.
