# CTS-K-N complete recreation kit

This directory is the authoritative hand-off for rebuilding CTS-K-N from a
clean machine or reimplementing it without relying on undocumented chat
history. The source repository remains the executable specification; these
documents explain its intent, ownership boundaries, state contracts, exact
validation steps, and recovery behavior.

## Reading order

1. [`architecture.md`](architecture.md) — system boundaries and runtime owners.
2. [`project-structure.md`](project-structure.md) — source tree and module roles.
3. [`runtime-and-data-flow.md`](runtime-and-data-flow.md) — startup through live
   execution and reconciliation.
4. [`strategy-block-dca.md`](strategy-block-dca.md) — strategy axes, Block PF,
   independent counts, DCA, and settings effects.
5. [`data-model-and-redis.md`](data-model-and-redis.md) — durable keys, schema,
   migrations, identity, and retention.
6. [`configuration-reference.md`](configuration-reference.md) — configuration
   layers, environment variables, and safe defaults.
7. [`installation-and-deployment.md`](installation-and-deployment.md) — local,
   Kilo/Cloudflare, and independent-server installation.
8. [`operations-and-recovery.md`](operations-and-recovery.md) — monitoring,
   upgrades, backup, failure, and rollback.
9. [`security-model.md`](security-model.md) — trust boundaries and live-order
   safety.
10. [`testing-and-acceptance.md`](testing-and-acceptance.md) — required release
    matrix and evidence.
11. [`rebuild-runbook.md`](rebuild-runbook.md) — clean-room reproduction.
12. [`verification-record.md`](verification-record.md) — exact release test
    evidence and explicit external blockers.

## Machine-readable inventories

Run `pnpm docs:recreation` from the repository root. Then run
`pnpm docs:recreation:verify` to hash every inventoried project file and prove
the source-tree and summary counts agree. The generator writes:

| Manifest | Purpose |
| --- | --- |
| `api-routes.tsv` | Every App Router API route, method, runtime hints, and detected auth signals |
| `ui-pages.tsv` | Every UI page and imported top-level components |
| `environment-variables.tsv` | Every referenced/documented environment variable and source |
| `redis-migrations.tsv` | Ordered Redis schema migrations |
| `tests-and-verifiers.tsv` | Unit, integration, E2E, deployment, performance, and operator checks |
| `project-files.tsv` | Byte size and SHA-256 for each source-controlled project file |
| `source-tree.txt` | Canonical file inventory |
| `summary.json` | Framework, revision, schema, and inventory totals |

The generator excludes its own output directory from the recursive checksum
manifest. This prevents self-referential hashes. The downloadable repository
archive is the byte-for-byte recreation source; regenerate manifests after any
code change.

## Recreation invariant

A recreation is complete only when all of the following are true:

- the pinned dependency lock installs without modification;
- TypeScript, ESLint, all Jest suites, Next production build, OpenNext build,
  Wrangler dry-run, and local Workerd scheduled-runtime tests pass;
- Redis reaches the repository's latest sequential schema (v82 at this handoff);
- the site instance ID survives process restart on shared persistence;
- the minute continuity and live-recovery heartbeats are fresh;
- Standard, independent Block Count, and sequential DCA lineage tests pass;
- production does not use process-local Redis or silently fall back from a
  requested real exchange order to simulation;
- a live exchange test, when explicitly authorized and credentialed, uses the
  hardened account-wide-lock/minimum-size/open-protect-close-flat procedure.

## What is intentionally external

The repository does not contain exchange credentials, Cloudflare credentials,
Redis contents, Kilo account ownership, SSH keys, DNS records, or production
backups. Those are deployment secrets/state and must be recreated through the
documented interfaces. The code and manifests are sufficient to recreate the
application; production data requires a separately secured backup.
