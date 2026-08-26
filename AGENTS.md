## Binding Project Continuity and Safety

These rules apply to every agent/chat working in this repository and take
precedence over stale workspace paths in older notes.

- The canonical persistent checkout is `/workspace/CTS-K-N`. Scratch/task
  directories may be used only for disposable artifacts, never as the source
  of truth. If the canonical checkout is unavailable, stop and recover it from
  a verified bundle instead of silently creating a replacement elsewhere.
- Create a recoverable backup before each material edit series, commit/push,
  merge, deployment, migration, Redis mutation, or production service change.
  Local checkpoints belong under `/workspace/backups/CTS-K-N`; server
  checkpoints belong under `/var/backups/cts-kn`.
- A source checkpoint must include a complete Git bundle, binary worktree
  patch, untracked-file archive/list, HEAD/status records, SHA-256 manifest,
  `sha256sum -c`, and `git bundle verify`. Protect backup directories/files
  with owner-only permissions. Never place credentials or Redis data in Git.
- After a material source change has passed its required validation, commit it
  and push it to GitHub through the reviewed branch/PR flow before it is
  treated as a deployable result. If GitHub is temporarily unreachable, retain
  the verified checkpoint, record the exact blocker, and do not describe the
  change as published.
- Deploy only a merged, green GitHub `main`. Preserve the remote `.env`, Redis
  persistence, exchange credentials, systemd configuration, and rollback
  binaries. Resolve exact services, revisions, and paths read-only before any
  replacement, then verify health and rollback readiness after it.
- X01/Mainnet and every Bybit connection are read-only. X02 BingX Prod-VST may
  be lifecycle-tested only with virtual minimum volume and must finish with its
  owned positions/orders reconciled and the pre-test account baseline restored.
  Never broaden this authorization to a mainnet order.
- Never print, commit, bundle, or copy into chat: SSH/Chisel secrets, private
  keys, exchange credentials, `.env` contents, raw account reports, or Redis
  snapshots. Load existing owner-only credentials only at the execution edge.
- For remote work, use the managed Chisel activation at
  `/workspace/.network-clients/activate-cts.sh` and its pinned localhost SSH
  forward. Validate the existing tunnel before operating the server; never
  replace it with an ad-hoc proxy or reveal its credentials, keys, or server
  arguments in logs, commits, reports, or chat.
- Treat the managed Chisel listener as a production-access prerequisite:
  diagnose and restart only the managed client when the pinned forward is not
  healthy, verify the localhost SSH banner before remote work, and record a
  broker/network blocker instead of falling back to another route.
- Use the lockfile and the pinned package-manager version for dependencies.
  Do not upgrade runtimes or dependencies incidentally during maintenance.
- Before handoff, update `.kilocode/rules/memory-bank/context.md` with the exact
  canonical revision, backups, gate results, remote state, and any pending
  safety work so a new chat can continue without relying on session history.

## Optional Feature Guides

When users request features beyond the base template, check for available recipes in `.kilocode/recipes/`.

### Available Recipes

| Recipe       | File                                | When to Use                                           |
| ------------ | ----------------------------------- | ----------------------------------------------------- |
| Add Database | `.kilocode/recipes/add-database.md` | When user needs data persistence (users, posts, etc.) |

### How to Use Recipes

1. Read the recipe file when the user requests the feature
2. Follow the step-by-step instructions
3. Update the memory bank after implementing the feature

## Memory Bank Maintenance

After completing the user's request, update the relevant memory bank files:

- `.kilocode/rules/memory-bank/context.md` - Current state and recent changes
- Other memory bank files as needed when architecture, tech stack, or project goals change
