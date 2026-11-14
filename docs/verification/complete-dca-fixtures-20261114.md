# Complete DCA lifecycle fixtures — 14 November 2026

Base main: `f62db0d89a8bca549c003ca5a9d6effd91f1b9f9`. Canonical checkout: `/workspace/CTS-K-N`.

The four long/short DCA partial/terminal fixtures relied on DCA being enabled by default. Current connection policy correctly disables it, so dispatch returned the policy rejection before the intended lifecycle assertions. The positive fixtures now set `connection.dcaEnabled = true` and reset it between tests. Existing disabled-policy coverage remains unchanged; no production gate or switch was relaxed.

The inventory test now distinguishes all registered types/tuples (137 / 2,437) from the enabled cohort (129 / 2,325). Newly registered opt-in types do not change the enabled universe. Other calculated-set and evaluation counts stay exact.

Verification:

- Two affected suites: 42 tests pass.
- Full isolated suite: 566 suites / 3,796 tests pass. A private disposable Redis 7.2 on loopback port 6399 uses no persistence and is shut down after the suite; ordinary Node transport remains guarded.
- TypeScript, focused ESLint, strategy features, independent Last-N blocks, source syntax and release secret scan pass.
- Production build passes and validates 356 complete trace files. The first simultaneous large build was killed with exit 137; a bounded 2,048 MiB repeat passes. Locked pnpm 10.28.1 dependencies are retained.

Official source checkpoints preceded recovery, edits and handoff; publication/merge require another verified checkpoint. Recreation manifests are regenerated after the final documentation edits. Current hosted CI and publication receipts belong to the containing PR.

This is offline lifecycle evidence. It neither repeats the native 12-symbol test nor establishes profitable execution PF. No remote service, production Redis, connection setting or exchange order changed. Managed Chisel activation remains unavailable; the remote runtime was not contacted through an alternate route.
