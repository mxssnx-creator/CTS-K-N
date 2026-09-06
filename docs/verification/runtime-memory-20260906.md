# Runtime and memory verification — 2026-09-06

Baseline: merged production `752d4e5a155094978ee647ed323173edca74bf98`.
The canonical checkout contains older concurrent edits and remains preserved.

## Current evidence

- At 10:27 UTC all three CTS services were active with NRestarts=0. Redis
  remained active with its previous NRestarts=63, no loading/rewrite in progress,
  noeviction, and successful AOF writes. HTTP health returned 200 in 42 ms.
- Redis used_memory was 7,267,835,664 bytes, up from the prior short observation.
  Its host-relative cap was about 8.3 GB. The governor correctly detected pressure;
  it does not itself remove retained history. Long-term memory stability is open.
- A bounded 15,045-key sample identified indication histories as the largest
  sampled allocation. No live/order/configuration records were modified.
- A separate Redis process compared 150 live-history copies, containing exactly
  14,691 entries: 4 KiB listpacks used 5,032,902 bytes; 8 KiB used 4,231,217 bytes;
  16 KiB used 4,641,133 bytes; 32 KiB used 7,893,369 bytes. This is a sample,
  not a guarantee for every workload or a whole-database savings measurement.
- X02 UI and HTTP both reported 20/32 historical symbols. Runtime rotation
  reported 20 configured, attempted and successful symbols. The canonical
  operator-settings mirrors also contain 20 symbols; the old nested connection
  snapshot incorrectly won the statistics resolver. Multiple strategy
  cycles and nonzero Base/Main/Real/Live row projections were observed. Active
  Set counts can legitimately be zero and must not be replaced by cumulative rows.
- Browser screenshots confirmed Overview navigation and visible exact Evals
  pairs. Theme-dependent pale backgrounds made their text difficult to read.
  No new exchange orders were submitted in this verification.

## Corrections

- Honor explicit 0% compaction headroom, including per-type overrides, and
  explicit floor=250 even when the legacy per-type limit is larger. Reject
  malformed/non-finite settings and keep fallback limits bounded.
- Use 8 KiB listpacks for future native Redis list writes. Lossless maintenance
  rebuilds a bounded temporary list from the exact original values; RESTORE
  alone retains old listpack boundaries. Replacement requires lower memory,
  exact values/order, and the original absolute expiry (or persistent status).
  Protected namespaces and temporary-key collisions are rejected. An explicit
  memory reserve check skips work before allocating under maxmemory pressure;
  Redis Lua does not reliably reject this read-then-write script on its own.
- Both compact runtime and full statistics now use the same canonical operator
  basket as the engine, before consulting older nested connection snapshots.
  Regression tests verify 20/20, the legacy fallback and the full coverage count.
- Stage cards use semantic theme colors, and zero current Set counts are
  explicitly labelled “Active sets”. Evaluation counts and ratios are unchanged.

## Validation

- Full Jest: 289 suites / 1,994 tests passed. TypeScript and ESLint passed.
- Native Redis regression: 400 exact rows, TTL/persistence, repeat execution,
  protected keys, existing compressed-list resizing and insufficient-memory
  admission all passed against an isolated server.
- Production build, publication, deployment and post-deployment verification
  are recorded in the PR and continuity notes when complete. This document
  does not claim a new VST soak or complete production accounting acceptance.
- Earlier release's strict VST soak remains failed because a foreign baseline
  order changed. Its independent owned-order reconciliation remains separate.
