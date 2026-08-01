# CTS-K-N

CTS-K-N is a Redis-backed, multi-stage crypto trading and operations system.
It combines a Next.js 15 / React 19 control plane with historical indication
processing, Base → Main → Real → Live strategy coordination, exchange order
execution, restart-safe position bookkeeping, one-minute continuity, and
production installers for Kilo/Cloudflare and independent Linux servers.

Real exchange placement is fail-closed. A production runtime needs shared
Redis, current schema migrations, explicit exchange credentials and operator
intent, durable coordination, and the live-order safety gates. A normal build or
installation never enables live trading automatically.

## Quick start

Requirements: Node.js 20 or newer and pnpm `10.28.1`.

```bash
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
cp .env.example .env.development.local
pnpm dev
```

The development UI listens on `http://127.0.0.1:3002`.

Verify a checkout before changing deployment state:

```bash
pnpm typecheck
pnpm lint
pnpm test:all
pnpm build
pnpm kilo:preflight
```

## Production choices

### Independent long-lived Linux server

For a clean or repeatable server install (Ubuntu/Debian/RHEL/Fedora/Amazon
Linux), run this single command. It clones directly into `/opt/cts-kn`, installs
all dependencies, builds, migrates, verifies, and starts the production service.
A repeat run stops the existing CTS services, preserves protected state, deletes
only the resolved `/opt/<name>` checkout, then clones and verifies a fresh
revision — no temporary directories are used:

```bash
sudo bash -c 'git clone --branch main --single-branch --depth=1 https://github.com/mxssnx-creator/CTS-K-N.git /opt/cts-kn 2>/dev/null || true && cd /opt/cts-kn && bash scripts/bootstrap-install.sh --dir /opt/cts-kn --name cts-kn --port 3002'
```

With a public URL (reverse proxy / domain):

```bash
sudo bash -c 'git clone --branch main --single-branch --depth=1 https://github.com/mxssnx-creator/CTS-K-N.git /opt/cts-kn 2>/dev/null || true && cd /opt/cts-kn && bash scripts/bootstrap-install.sh --dir /opt/cts-kn --name cts-kn --port 3002 --public-url https://your-domain.com'
```

Preflight check (dry-run without mutations):

```bash
sudo bash -c 'cd /opt/cts-kn && bash scripts/install.sh --preflight-only --skip-system-packages --runtime auto --service-user cts-kn --create-service-user --non-interactive'
```

The installer supports Debian/Ubuntu and RHEL/Fedora/Amazon Linux families,
uses systemd when available or PM2 when selected, provisions one application
owner plus one minute-scheduler owner, verifies Redis persistence and schema
v84, tests/builds before cutover, checks restart recovery, and restores the
previous `.next` build on failure.

It reuses already-installed packages and runtimes. When absent, Bun is installed
globally at `/usr/local/bin/bun` and launches the compact service wrapper; the
Next standalone server remains on Node for exact Next.js compatibility. Each
successful install records its values in `.cts-runtime/install-values.env`:

When the Git bootstrap runs again, it resolves the saved installation from an
explicit path/name, systemd `WorkingDirectory`, or a unique
`/opt/*/.cts-runtime/install-values.env`. It stops the matching app and
minute-scheduler, copies protected CTS state outside the target, removes the
exact checkout, then clones and verifies a clean revision. The environment,
application data/logs, and CTS-managed local Redis state survive; shared and
external Redis are never deleted.
Name-only discovery also covers PM2 installs whose checkout directory differs
from the service name. Ambiguous duplicate names fail closed and require
`--dir`. Dedicated install/environment paths use safe absolute Linux path
components (letters, digits, `.`, `_`, `-`, and `/`).

```bash
sudo /opt/cts-kn/scripts/service-control.sh resolve
sudo /opt/cts-kn/scripts/start.sh
sudo /opt/cts-kn/scripts/stop.sh
sudo /opt/cts-kn/scripts/restart.sh --port 3003
sudo /opt/cts-kn/scripts/update.sh
```

`update.sh` uses the saved service, runtime, user, port, environment, repository,
branch, and project root. It refuses identity mismatches or tracked local
changes, then delegates to the same stop → delete → fresh-install lifecycle as
the bootstrap script.

To remove the CTS services, CTS-owned runtime data, installer-created service
account and checkout, while preserving shared Bun/Node/Redis and external Redis
data, run:

```bash
sudo bash /opt/cts-kn/scripts/bootstrap-install.sh --name cts-kn --uninstall
```

### Kilo / Cloudflare Workers

Use `.dev.vars.example` for a local Workerd preview. For a complete controlled
deployment, configure the variables documented in `.env.example`, including a
shared Redis service and a distinct long-lived owner, then run:

```bash
pnpm kilo:preflight:runtime
pnpm kilo:preview:verify
pnpm kilo:dry-run
pnpm kilo:deploy
```

`pnpm kilo:deploy` validates controller credentials, uploads an explicit
Worker-binding allowlist atomically with the deployment, initializes the
database, triggers and verifies continuity, and checks shared persistence.
Kilo owns the web UI and scheduled minute calls; the independent server owns
the permanent trade-engine process and can also execute Remote SSH Install
jobs. Both share the same durable Redis state.

## Strategy model

- Base creates indication configurations and optional trailing-range variants.
- Main validates Base configurations and materializes reached Previous, Last,
  Continuous, Pause, outcome, and direction axes.
- Real applies position-count/PF/DDT gates, hedge coordination, and independent
  Block Count 1..10 Sets. Stage rows are exhaustive; bounded rotating work
  batches control latency without becoming a row or configuration ceiling.
- Signal is a default-enabled Common indication engine. It normalizes 35
  documented public one-minute OHLCV feeds, derives a low-stop consensus
  locally, and enters the same Main → Real → Live lineage as every other
  indication. Each connection has an independent Signal switch alongside Main
  Live Trade. Every enabled source compatible with a symbol is processed each
  cycle; bounded HTTP concurrency controls in-flight work without sampling or
  truncating the configured source space.
- Regular Block ladders use normal Base-derived Sets only; Pos-Count Sets do
  not recursively create Blocks. The separate Real-active Block calculation
  still counts Pos-Count positions in its per-symbol, per-direction activity.
- Real Block evaluation keeps independent Strategy lanes for
  symbol × Long/Short/Overall and independent Signal lanes for
  source × symbol × Long/Short/Overall, for every configured Block count.
- Live executes Standard first and only then attaches Block or DCA adjustments
  to the confirmed authoritative parent position.
- Every confirmed Set membership and realized result is booked idempotently in
  Redis so active/closed counts, PF, DDT, Block pauses, DCA steps, stats, and
  restart recovery use the same lineage.

The Block minimum ProfitFactor for count `n` is:

```text
blockMinPF(n) = defaultMinPF × blockProfitFactorRatio × (n × blockVolumeRatio)
```

The physical Block target uses the immutable general order volume and never
compounds earlier Count fills:

```text
blockTarget(n) = generalVolume + ((generalVolume × blockVolumeRatio) × n)
nextOrderQty(n) = max(0, blockTarget(n) - generalVolume - confirmedBlockAdds)
```

Every count uses its own exact Set result ring and the same last-N window and
minimum-sample rule as the normal PF calculation. A cold enabled Block starts
immediately from the matching normal PF without a Block-only progression. Once
its own window is mature, it can emit only while its own PF is at least the
matching normal rolling PF and any stronger configured minimum. Calculations,
differences, and statistics continue while the Block switch is off; only new
emission is suppressed. The UI exposes the Block PF factor from `0.2` through
`5.0`, default `0.8`.

Base volume coordination is always identity `1`. Explicit Main, Preset, Signal,
Pos-Count, DCA, and Block factors are composed only at their own named boundary.
Signal exposes its own volume-factor slider beside the other channel factors,
including Overall settings.

## Documentation

The complete recreation kit begins at
[`docs/recreation/README.md`](docs/recreation/README.md). It includes:

- system architecture, ownership, and complete directory map;
- stage, Block, DCA, exchange, and settings propagation contracts;
- Redis data model, schema v91 migrations, recovery, and backup rules;
- complete environment/deployment/install procedures;
- acceptance tests and a clean-room rebuild runbook;
- generated API, page, environment, migration, test, source-tree, and SHA-256
  manifests under `docs/recreation/manifests/`.

Supporting deep dives remain in
[`docs/signal-source-research.md`](docs/signal-source-research.md),
`lib/BLOCK_STRATEGY_SYSTEM.md`, and the source-adjacent tests.

## Safety

Do not place real credentials in tracked files. Do not enable live exchange
orders until the account is flat and the hardened smoke path can take the
account-wide lock, place the minimum venue amount, arm protection, close, and
prove the final position and open-order state are flat.
