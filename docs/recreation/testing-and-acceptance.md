# Testing and acceptance

## Release matrix

Run from a clean checkout with the frozen lockfile. Environment-specific tools
should use isolated Redis and no live exchange placement.

```bash
pnpm install --frozen-lockfile
git diff --check
node scripts/verify-source-syntax.mjs
pnpm typecheck
pnpm lint
pnpm test:all
pnpm build
pnpm kilo:preflight
pnpm kilo:dry-run
pnpm test:kilo-runtime
pnpm test:scheduler:minute
pnpm security:scan
pnpm docs:recreation
pnpm docs:recreation:verify
```

Also validate shell/JSON syntax:

```bash
bash -n scripts/install.sh scripts/post-deploy-verify.sh \
  scripts/vercel-build-setup.sh scripts/verify-stability.sh
node --check scripts/kilo-deploy.mjs
node -e 'JSON.parse(require("fs").readFileSync("wrangler.jsonc","utf8"))'
```

`manifests/tests-and-verifiers.tsv` lists every checked-in test/verifier. The
full Jest count is reported by the actual release run; do not copy a historic
number into acceptance evidence.

## Required focused strategy suites

- independent Block formulas, keys, pauses and concurrency;
- each Block count's own last-N result window/minimum sample;
- active-count retention without cross-count validation;
- Block settings changes immediately recalculating Count1..N;
- Block stats clear on disable/no source/no active parent;
- position-count axis independence and active exact Set retention;
- DCA stable `#step:N` identities, cooldown, immutable initial-quantity sizing;
- current persisted DCA settings overriding the open position's recovery
  profile on the next step;
- ordered Standard parent → Block → DCA integration with confirmed quantities;
- realized close outcome booked before membership deletion and retry idempotency;
- safety-cap variant fairness and active low-PF Set survival.

## Deployment tests

### Canonical host preflight

Use a free high port and current/nonprivileged service user as appropriate:

```bash
bash scripts/install.sh --preflight-only --skip-system-packages \
  --runtime auto --service-user "$(id -un)" --port 45671 --non-interactive
```

This is non-mutating and verifies actual host capacity, port inspection,
project artifacts, runtime/user feasibility and shell syntax.

### Remote route simulation

`__tests__/unit/install-deployment-contract.test.ts` replaces the SSH/bootstrap
boundary with disposable executables. It sends authenticated preflight and
install requests through the real API route, validates clone/bootstrap,
noninteractive arguments, seed Redis transport, runtime selection and returned
service contract. This is the highest safe remote coverage without a supplied
external host for the mutating install mode. Release validation should also run
the non-mutating mode through a real disposable SSH protocol target when the
test environment can provide one, including private-key authentication and a
clone of the exact pushed revision.

### Genuine remote host

When a target/SSH authority is supplied, first run `mode=preflight`. Only after
it passes should install be confirmed. Acceptance requires the remote canonical
installer to report schema, shared Redis, service restart, durable identity,
scheduler and fresh continuity success. A connection-only SSH check is not a
successful installation test.

### Kilo static/build/runtime

- `kilo:preflight`: versions/config/handler/schema/required secrets;
- `kilo:dry-run`: OpenNext build plus Wrangler bundle without deploy;
- `test:kilo-runtime`: real local Workerd serving the OpenNext UI and API;
  verifies dashboard/settings/preset assets, Block PF and volume read-after-write,
  durable external-owner handoff, Disable/Enable, requested/effective Live state,
  Pause/Resume/Stop/Start, live-order authentication/placement fail-closed,
  zero real positions/orders, scheduled event and fresh continuity/recovery;
- `kilo:deploy`: authenticated remote deployment plus production contract;
- `kilo:verify`: post-deploy schema/persistence/continuity proof.

## Production preview and stress

The repository contains dev/prod preview, maximum-symbol, UI, soak and public
exchange stress scripts. Run them only in an isolated environment with resource
limits and no live placement:

```bash
pnpm test:prod-preview
pnpm test:prod-preview:max
pnpm test:prod-preview:verify
pnpm test:prod-ui:max
pnpm test:prod-soak
pnpm test:stress-32
```

Record duration, peak RSS, event-loop/route timeouts, symbol counts and any
degraded fallback. A script skipped for missing external prerequisites must be
listed as unexecuted, not passed.

For side-by-side production previews, build with `NEXT_DIST_DIR=.next-prod`.
The configuration serializes only that custom-dist static-generation phase to
avoid Next 15 export-directory `ENOTEMPTY` races on overlay/network filesystems;
normal and Kilo `.next` builds retain their regular parallelism.

## Live exchange acceptance

Do not run during ordinary CI/build. When explicitly authorized, use only the
hardened live smoke described in `security-model.md`. Record initial/final
venue positions/orders, minimum amount, order/client IDs, fill, SL/TP evidence,
close result and final flat proof. Abort and reconcile on ambiguity.

## Completion evidence template

```text
Revision:
Node / pnpm:
Schema:
Typecheck:
Lint:
Jest suites/tests:
Next build:
OpenNext build:
Wrangler dry-run:
Workerd scheduled runtime:
Host preflight:
Remote route simulation:
Genuine remote target (or explicit blocker):
Kilo live deploy (or explicit credential blocker):
Live exchange smoke (or explicit safety/credential blocker):
Secret scan:
Git push / remote commit:
```

No release claim should hide a credential/target-dependent test behind a local
simulation result.
