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

```bash
git clone https://github.com/mxssnx-creator/CTS-K-N.git /opt/cts-k-n
cd /opt/cts-k-n
bash scripts/install.sh --preflight-only --skip-system-packages \
  --runtime auto --service-user cts-kn --create-service-user --non-interactive
sudo bash scripts/install.sh --runtime auto --service-user cts-kn \
  --create-service-user --non-interactive
```

The installer supports Debian/Ubuntu and RHEL/Fedora/Amazon Linux families,
uses systemd when available or PM2 when selected, provisions one application
owner plus one minute-scheduler owner, verifies Redis persistence and schema
v81, tests/builds before cutover, checks restart recovery, and restores the
previous `.next` build on failure.

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
- Real applies position-count/PF/DDT gates, hedge coordination, safety caps,
  and independent Block Count 1..10 Sets.
- Live executes Standard first and only then attaches Block or DCA adjustments
  to the confirmed authoritative parent position.
- Every confirmed Set membership and realized result is booked idempotently in
  Redis so active/closed counts, PF, DDT, Block pauses, DCA steps, stats, and
  restart recovery use the same lineage.

The Block minimum ProfitFactor for count `n` is:

```text
blockMinPF(n) = defaultMinPF × blockProfitFactorRatio × (n × blockVolumeRatio)
```

Every count uses its own exact Set result ring and the same last-N window and
minimum-sample rule as the normal PF calculation. The UI exposes the Block PF
factor from `0.2` through `5.0`, default `0.8`.

## Documentation

The complete recreation kit begins at
[`docs/recreation/README.md`](docs/recreation/README.md). It includes:

- system architecture, ownership, and complete directory map;
- stage, Block, DCA, exchange, and settings propagation contracts;
- Redis data model, schema v81 migrations, recovery, and backup rules;
- complete environment/deployment/install procedures;
- acceptance tests and a clean-room rebuild runbook;
- generated API, page, environment, migration, test, source-tree, and SHA-256
  manifests under `docs/recreation/manifests/`.

Supporting deep dives remain in `docs/`, `lib/BLOCK_STRATEGY_SYSTEM.md`, and
the source-adjacent tests.

## Safety

Do not place real credentials in tracked files. Do not enable live exchange
orders until the account is flat and the hardened smoke path can take the
account-wide lock, place the minimum venue amount, arm protection, close, and
prove the final position and open-order state are flat.
