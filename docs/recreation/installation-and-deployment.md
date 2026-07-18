# Installation and deployment

## Local development

```bash
git clone https://github.com/mxssnx-creator/CTS-K-N.git
cd CTS-K-N
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
cp .env.example .env.development.local
pnpm dev
```

Use a dedicated development Redis or explicitly allow local InlineLocalRedis.
Do not reuse a production exchange account/Redis for ordinary tests.

## Independent Linux server

### Host requirements

- long-lived Linux; apt, dnf or yum family;
- at least 1.5 GiB RAM and 4 GiB free disk;
- root or non-interactive sudo for install/service work;
- free application port (default 3002);
- Git/network access to the repository and package registries;
- service user, or `--create-service-user`;
- systemd, or PM2 with an init system capable of reboot startup.

Run the non-mutating preflight from a complete checkout:

```bash
bash scripts/install.sh \
  --preflight-only \
  --skip-system-packages \
  --runtime auto \
  --service-user cts-kn \
  --create-service-user \
  --non-interactive
```

Prepare a mode-600 seed file when using external Redis or existing secrets:

```dotenv
REDIS_URL=rediss://user:password@redis.example.com:6379
NEXT_PUBLIC_APP_URL=https://owner.example.com
DEPLOYMENT_URL=https://owner.example.com
```

Then install:

```bash
sudo bash scripts/install.sh \
  --runtime auto \
  --service-user cts-kn \
  --create-service-user \
  --seed-env-file /root/cts-k-n.seed.env \
  --non-interactive
```

The installer:

1. validates OS, capacity, port, privileges, user and artifacts;
2. installs OS dependencies, Node and pinned pnpm where necessary;
3. provisions/verifies durable Redis and safe environment gates;
4. generates missing admin, cron, encryption and JWT secrets;
5. installs the frozen lockfile, typechecks, lints and runs all Jest tests;
6. stops the old runtime, stages its `.next`, and builds production;
7. creates read-only runtime code ownership plus writable `.next/cache`;
8. installs one app and one minute-scheduler service under the unprivileged user;
9. initializes schema, performs one scheduler tick and runs the deployment contract;
10. restarts services, verifies durable site identity and repeats the contract;
11. removes the staged backup only after success, or restores it on any failure.

`--skip-tests` skips Jest only; typecheck, lint, build, migrations, health,
persistence, scheduler and restart verification remain mandatory.

## Remote SSH installation

Settings → Install Manager → Remote SSH Install uses the legacy-named
`/api/install/remote-postgres` endpoint. It is a generic CTS-K-N server
installer; it does not install PostgreSQL.

Required flow:

1. enter current site `ADMIN_SECRET` for authorization;
2. enter host, SSH identity, repository/branch, dedicated install directory,
   runtime (`auto`, `systemd`, or `pm2`), app port, service user and Redis URL;
3. run Remote Preflight; any form edit invalidates the pass;
4. explicitly confirm Install/Upgrade;
5. review bounded, secret-scrubbed remote logs and returned URL.

The API validates host/ports/names/branch/repository/directory/environment,
blocks dangerous directories and environment injection, stores a supplied SSH
key in a private temporary directory, uses `BatchMode` when applicable, requires
passwordless sudo, checks capacity, clones a disposable revision for preflight,
then delegates installation to `scripts/install.sh`. Secrets are base64-carried
inside SSH stdin rather than exposed in command arguments.

Existing checkouts must be clean, match the requested origin, and fast-forward.
Non-empty non-Git targets fail closed.

## Kilo / Cloudflare deployment

OpenNext transforms the Next build for Workers. `custom-worker.ts` follows the
OpenNext custom-worker pattern to reuse the generated fetch handler and expose a
scheduled handler. `wrangler.jsonc` is the Worker configuration source of truth.

The official adapter documents `opennextjs-cloudflare build/deploy`; deployment
populates remote cache and delegates to Wrangler. Wrangler supports dry-run
bundles and atomic `--secrets-file` upload. References:

- <https://opennext.js.org/cloudflare/get-started>
- <https://opennext.js.org/cloudflare/howtos/custom-worker>
- <https://opennext.js.org/cloudflare/cli>
- <https://developers.cloudflare.com/workers/wrangler/commands/workers/>

### Configure

Set locally for the deploy controller:

- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`;
- shared Redis configuration;
- `ADMIN_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `JWT_SECRET`;
- public HTTPS `NEXT_PUBLIC_APP_URL`/`DEPLOYMENT_URL`;
- distinct HTTPS `REMOTE_INSTALL_OWNER_URL` and its `ADMIN_SECRET` as
  `REMOTE_INSTALL_OWNER_SECRET`;
- optional exchange credentials only when that deployment needs them.

Use `.dev.vars.example` for local preview values. Never commit `.dev.vars`.

### Validate and deploy

```bash
pnpm kilo:preflight
pnpm kilo:preflight:runtime
pnpm kilo:preview:verify
pnpm kilo:dry-run
pnpm kilo:deploy
```

`kilo:deploy` runs the complete runtime/owner/controller preflight, OpenNext
build, OpenNext deploy with an allowlisted temporary secrets file, production
initialization and post-deploy verification. The temporary file is mode 600 and
removed on success/failure. Cloudflare controller credentials are excluded from
the Worker allowlist.

The deployed Worker requires encrypted `ADMIN_SECRET`, `CRON_SECRET`,
`ENCRYPTION_KEY` and `JWT_SECRET` bindings. It exposes one-minute scheduled
continuity. It does not claim a permanent trade-engine process.

### Kilo plus owner

Both deployments point at the same shared Redis. The owner must set its public
URL and run the engine/scheduler services. Kilo's remote-install route proxies
only to this configured owner over HTTPS. A self-target, HTTP URL, credentials
embedded in URL, or short/missing owner secret returns 503.

## Verification and rollback

Use:

```bash
DEPLOYMENT_URL=https://app.example.com \
CRON_SECRET=... \
REQUIRE_SHARED_PERSISTENCE=1 \
REQUIRE_FRESH_CONTINUITY=1 \
bash scripts/post-deploy-verify.sh
```

This checks health, database, initialization, settings, engine, core APIs,
unauthorized/authorized cron behavior, exact schema, persistence scope, site
identity and fresh continuity. A host upgrade automatically rolls its previous
build back on any post-build error. Cloudflare rollback uses platform version
rollback after diagnosing Redis/schema compatibility; never roll application
code behind an already irreversible migration without a compatibility review.
