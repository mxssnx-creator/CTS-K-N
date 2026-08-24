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
