# Operations and recovery

## Normal readiness evidence

Operators should use state, not process assumptions. Required evidence:

- `/api/health` and `/api/health/database` are healthy;
- `/api/system/init-status` reports ready, current/latest schema equal, shared
  backend in production, durable site ID, expected runtime/engine owner;
- `/api/persistence/status` reports cross-instance durability for live use;
- `/api/trade-engine/status` shows current owner/heartbeats or a correctly
  queued external-owner state;
- continuity and live-recovery timestamps are fresh;
- progression/settings recoordination has no pending/error marker;
- local/exchange open positions and orders reconcile.

Stats are observability, not the source of exchange truth. A zero value must
distinguish no evaluated Sets from an actual measured zero; Block snapshots are
cleared when disabled/no parent/no sources.

## Long-lived service operations

systemd:

```bash
systemctl status cts-k-n cts-k-n-scheduler
journalctl -u cts-k-n -u cts-k-n-scheduler --since today
systemctl restart cts-k-n cts-k-n-scheduler
```

PM2 (run as the configured service user and PM2 home):

```bash
pm2 status
pm2 logs cts-k-n
pm2 restart cts-k-n cts-k-n-scheduler --update-env
pm2 save --force
```

Only one scheduler should be installed for one deployment. Redis minute dedup
limits duplicate work but does not make duplicate owners desirable.

## Safe upgrade

1. Back up Redis and record current commit/build/site identity.
2. Confirm exchange positions/orders and engine intent.
3. Run remote/local non-mutating preflight against the target revision.
4. Ensure the checkout is clean and fast-forward it.
5. Run canonical installer; do not manually replace `.next`.
6. Require schema, health, scheduler, identity and restart checks to pass.
7. Review progression/logs before re-enabling any paused operator intent.

The installer stages the previous build before building. The EXIT trap restores
and restarts it for any later error. On successful verification the old staged
build is removed to prevent upgrade disk leaks.

## Failure playbooks

### Shared Redis unavailable

- Live placement remains blocked; do not enable inline fallback.
- Stop/restrict engines if connection instability could produce stale venue
  state.
- Restore Redis connectivity, verify schema/site identity, then reconcile all
  venue positions/orders before resuming.

### Stale continuity

- Check exactly one scheduler owner and `CRON_SECRET` agreement.
- Check unauthorized cron returns 401, not success.
- Run one scheduler tick with `scheduler:minute:once` on a long-lived host or
  local `__scheduled` in Workerd.
- Inspect minute dedup and the two coordination hashes.
- On Kilo confirm the Cron Trigger is attached to the deployed Worker version.

### Engine intent but no owner

- Kilo is expected to report `external-long-lived-required`.
- Verify the independent server uses the same Redis and has current service
  heartbeat.
- Do not opt a request Worker into permanent in-process ownership as a shortcut.

### Ambiguous exchange submission

- Do not resend manually.
- Preserve the pending outbox/client order ID.
- Query by client ID/order ID and reconcile exchange positions/open orders.
- Apply only observed fill delta; re-arm protection for confirmed quantity.

### Protection missing

- Treat as high priority. The live pipeline attempts protection immediately
  after fill and records every step.
- Use the emergency/close controls according to current exchange state.
- Do not create a second parent position to compensate.

### Settings appear inert

- Check canonical settings readback and recoordination completion/version.
- Check changed field is in strategy/live-order classification lists.
- Force cache invalidation through the normal settings flow, not Redis edits.
- Confirm next Real evaluation or DCA step carries the changed value.

### Schema mismatch

- Stop exchange mutation owners.
- Run the repository migration command/production initialization once against a
  backup-capable Redis.
- Verify exact repository latest and indexes.
- Never decrement `_schema_version` manually.

## Backup cadence

- Enable Redis provider persistence/replication and encrypted snapshots.
- Take application exports before configuration resets and releases.
- Protect backups like exchange credentials; they may contain encrypted
  connection secrets and live position state.
- Test restore into an isolated Redis and non-live connection.
- Record commit/schema with each backup.

## Reset semantics

The clear-progressions operation removes recoverable runtime graphs, positions,
logs and caches while preserving required configuration/identity families. It
also disables runtime intent. A full database flush is destructive and must not
be used as ordinary troubleshooting. After either operation, run migrations and
readiness checks before starting.
