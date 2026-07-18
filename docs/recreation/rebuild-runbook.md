# Clean-room rebuild runbook

This procedure reconstructs the application and validates functional
equivalence. It does not recreate production secrets or Redis data.

## 1. Acquire and verify source

1. Download the release archive or clone the tagged/recorded Git revision.
2. Verify archive checksum supplied with the handoff.
3. Compare files to `docs/recreation/manifests/project-files.tsv`.
   `pnpm docs:recreation:verify` performs the byte-size, SHA-256, ordered-tree,
   and summary-count checks automatically after dependencies are installed.
4. Confirm no unexpected environment files, `.next`, `.open-next`, `.wrangler`
   or runtime snapshot directories are present.
5. Read `summary.json` for expected toolchain/schema.

## 2. Recreate toolchain

Install Linux/macOS tooling, Git, Node >=20 and Corepack. Activate the exact
package manager:

```bash
corepack prepare pnpm@10.28.1 --activate
pnpm --version
pnpm install --frozen-lockfile
```

Do not substitute npm/yarn/bun and do not regenerate the lockfile. `bun.lock`
is intentionally absent so OpenNext cannot select the wrong package manager.
`pnpm-workspace.yaml` is also part of the contract: its native-build allowlist
permits only the checked-in packages that require install scripts.

## 3. Recreate configuration

1. Copy `.env.example` to the environment-specific untracked file.
2. Generate new admin/cron/encryption/JWT secrets.
3. Provision isolated shared Redis and set exactly one supported connection
   alternative.
4. Set application/deployment URLs.
5. Leave live forcing and exchange credentials unset for initial validation.
6. For Kilo, copy `.dev.vars.example` for local preview and configure the
   long-lived owner relationship.

## 4. Recreate database

Start against empty isolated Redis. Run application initialization or production
deploy initialization. Verify:

- current/latest migration versions match repository latest;
- site identity exists;
- default connections/settings/presets were created as expected;
- backend is shared for production;
- indexes and connection count diagnostics agree.

To recreate an existing installation, restore its separately secured Redis
backup before migration, then follow the restore checklist in
`data-model-and-redis.md`.

## 5. Prove source equivalence

Run the full matrix in `testing-and-acceptance.md`. Regenerate manifests:

```bash
pnpm docs:recreation
pnpm docs:recreation:verify
git diff -- docs/recreation/manifests
```

Expected deliberate differences are revision/timestamp/checksum changes from a
new source revision. Unexpected missing routes, tests, migration gaps or files
mean the recreation is incomplete.

## 6. Recreate a long-lived deployment

Use the canonical host preflight and installer. Do not manually synthesize
service units or PM2 state. Verify both app/scheduler boot ownership, exact
schema, shared Redis, restart identity and continuity.

## 7. Recreate Kilo

1. Create/select Cloudflare/Kilo account and scoped controller token.
2. Configure the same shared Redis used by the independent owner.
3. Configure required Worker secrets and public URL.
4. Confirm `wrangler.jsonc` remains the configuration source of truth.
5. Run preflight, local Workerd test and dry-run.
6. Run `pnpm kilo:deploy` or the platform's equivalent OpenNext deployment.
7. Verify Cron Trigger, schema, persistence, identity and fresh heartbeats.
8. Verify Kilo reports external long-lived engine ownership and remote install
   proxies only to the configured owner.

## 8. Recreate exchange connections

Create new least-privilege API keys at each venue. Enter them through the
authenticated settings flow so they use current storage/encryption and trigger
recoordination. Test credentials/read-only account state first. Do not enable
live intent until the account is flat and the hardened live smoke is authorized.

## 9. Functional equivalence checklist

- Dashboard/settings/presets/install pages render and APIs match manifests.
- Settings changes persist, confirm recoordination and affect next computation.
- Previous/Last/Continuous/Pause Sets are independently counted.
- Block Count1..10 and PF thresholds are independent and observable.
- DCA settings affect the next stable step and attach to the same parent.
- Standard/Block/DCA paper pipeline matches ordered live lineage.
- Engine/scheduler survive restart with same site identity/state.
- Kilo scheduled handler advances both continuity hashes.
- Remote preflight/install uses selected auto/systemd/PM2 runtime.
- Production readiness remains fail-closed without shared persistence/credentials.

## 10. Package a new handoff

1. Ensure the worktree is clean at the release revision.
2. Regenerate docs/manifests and commit them.
3. Run release verification again.
4. Create an archive from Git-tracked files, not the working directory, so
   secrets/build caches are excluded.
5. Produce SHA-256 checksum and record revision/schema/test evidence.
6. Store archive, checksum and evidence in a durable download location.
