# Release verification record — 2026-07-26

This record captures the final acceptance evidence for the Block PF/position
count/DCA, deployment, installation, durability, and recreation handoff. All
ordinary tests ran with real exchange order placement disabled. A pass is not
claimed for any credential- or target-dependent action that could not safely be
executed.

## Latest acceptance — Signal, Block PF and Base-volume identity

The 2026-07-26 release extends the Common indication category with the
default-enabled Signal engine and freezes all shared Base coordination at
identity ratio `1`. Main, Preset, Signal, Pos-Count, DCA and Block adjustments
remain explicit, independent factors. File-backed fallback imports, Redis
writes and migration 084 all normalize legacy Base multipliers without
changing the named channel factors.

- The Signal registry contains exactly 36 documented public adapters: 35
  crypto one-minute OHLCV feeds and one read-only InstaForex Charts M1 feed.
  Four liquid crypto core feeds stay in every bounded cycle while
  priority-ordered pages cover every remaining compatible enabled source; the
  Forex feed is routed only to Forex symbols and uses its explicit one-source
  broker quorum.
- Signal source requests expose a persisted seconds-based interval. It defaults
  to 30 seconds, clamps every API/legacy value to at least 30 seconds, and
  drives both source-fetch and complete-cycle cache expiry. The production UI
  contract verifies that the running API never exposes a sub-30-second value.
- Fixture/schema tests cover all 36 request and response formats. The isolated
  public HTTP probe reports 35 crypto-compatible and one Forex-compatible
  adapter, zero authenticated requests and zero order endpoints. This
  validation host blocks direct exchange-domain egress, so bounded timeouts
  are recorded as an environment reachability limitation, not as provider
  failures.
- Signal performance is an exact rolling last-15 **closed** result ring for
  each source × symbol × long/short lane. Negative mature PnL disables only
  that lane; open positions never enter PnL or PF windows.
- Strategy Block lanes are independent for symbol × long/short/overall and
  Signal Block lanes for source × symbol × long/short/overall, for every
  Block count. Their calculation, PF difference and statistics continue while
  disabled; only new evaluation/emission is suppressed, while existing
  exposure remains reconciled.
- An enabled cold Block starts immediately from the matching normal rolling PF.
  Once its own closed-result window is mature, it is held whenever Block PF is
  lower than normal PF. The explicit PF=2/Last-25 regression rejects a mature
  Block PF of 1.99 and accepts 2.0.
- The physical target is
  `general + general × BlockRatio × count`, and only the unconfirmed delta is
  submitted. Source lanes never multiply exchange exposure; they keep
  independent attribution/PnL while execution consolidates by symbol and
  direction.

Latest executable evidence:

| Check | Result |
| --- | --- |
| Next 15.5.18 standalone build | pass; 41/41 pages, trace/postbuild complete |
| Complete Jest application suite | pass; 108/108 suites, 749/749 tests |
| Critical Block/Signal repetition | pass; 3 × 140 = 420 tests |
| Extended production paper soak | pass; 240,134 ms, 12 symbols, 120 rounds, 1,320 requests |
| Fresh final production paper soak | pass; 120,067 ms, 12 symbols, 60 rounds, 660 requests |
| Fresh final production progression | 336 engine cycles; 2,304 Main strategy cycles |
| Fresh final database stability | 533 → 2,318 keys; stable-window delta 1; schema v84 |
| Fresh final production latency | steady p95 99 ms (1,000 ms budget) |
| Crash recovery | 24/24 Paper positions recovered; no pending/placed residue |
| 32-symbol production UI | pass; Signal enabled, 36-source registry (35 crypto + 1 Forex), ≥30 s request interval, Signal volume hot reload |
| Development/HMR paper soak | pass; 61,183 ms, 330 requests, steady p95 1,494 ms |
| Real exchange activity | 0 real positions and 0 real order requests |

## Toolchain and static release gates

| Check | Result |
| --- | --- |
| Source base before this handoff commit | `8e46569b5203401876d9c7eb1a557521602574d1` on `origin/main` |
| Validation host | Linux 6.12.13 x86_64; Node 24.14.0 |
| Package manager | exact `pnpm 10.28.1` through Corepack |
| Frozen dependency install | pass, offline, lockfile unchanged |
| Shell/JS/JSON/source syntax | pass |
| TypeScript | pass |
| ESLint | pass |
| Jest | 108 suites, 749 tests, 0 failures |
| Next 15.5.18 optimized build | pass; 41 pages generated |
| Isolated `.next-prod` build | pass; custom-dist static generation serialized and the Next 15 missing `pages-manifest.json` post-emit race repaired before page-data collection |
| Release-tree secret scan | pass; 1,236 files inspected, 0 findings |
| Redis schema | v84, sequential migration inventory |

## Strategy correctness evidence

- Block Count 1..12 are exact independent Set keys with independent result
  windows, minimum-sample activation, PF decisions, active retention, pause
  state, stats, and migration coverage.
- The count floor is calculated without presentation rounding as
  `default minimum PF × Block PF factor × (count × Block volume ratio)`. The
  factor is clamped to 0.2..5.0 and defaults to 0.8 in global, per-connection,
  and Preset Strategy/Block surfaces.
- A settings-effect test changed volume/PF from `0.5/0.8` to `1.5/1.2` and
  proved Count 1/2 floors changed from `0.48/0.96` to `2.16/4.32` immediately.
- Position-count axis normalization, enabled/disabled axes, generated Set
  uniqueness, active exact-Set survival under caps, and hot-recoordination were
  covered by focused unit/regression suites.
- Position-count Live execution keeps one physical hedged target, applies
  cumulative partial reductions exactly once across cycles/restarts, blocks a
  duplicate reduce while the prior client/order id is unresolved, reallocates
  the authoritative remaining quantity across member Sets, and records one
  bounded aggregate execution ledger without inventing per-Set PnL histories.
- Standard → Block → DCA integration attached all confirmed legs to one parent.
  DCA used stable `#step:1..4` keys and the immutable initial quantity. A
  persisted settings update changed the next confirmed quantity from `0.004`
  to `0.011`, proving the next step uses current settings rather than a stale
  recovery snapshot.

## Deployment and installation evidence

| Check | Result |
| --- | --- |
| Canonical independent-host preflight | pass; apt host, free port 45671, 44 GiB free disk, 21 GiB RAM |
| Remote API route contract | pass; authentication, validation, disposable clone, preflight/install, seed transport, and auto/systemd/PM2 contract through the SSH boundary fixture; an additional real OpenSSH/key-auth loopback run cloned the pushed `main` and completed the canonical non-mutating preflight over the SSH protocol |
| Portable minute scheduler | pass; both required paths, 60,000 ms interval |
| Clean reconstruction/Vercel builder | pass from an empty Git archive with no `node_modules`; exact pnpm 10.28.1 restored 1,272 locked packages and provider packaging produced 149 routes, 67 function entries, 116 valid JSON manifests, and no invalid JSON |
| Full Vercel builder | pass locally; provider simulation reproduced and eliminated read-only `corepack enable` EROFS, Next 15's zero-byte `export-marker.json`, and stale `export-detail.json` false-static classification; dynamic/API functions are retained |
| OpenNext 1.20.1 build | pass; generated `.open-next/worker.js` |
| Wrangler 4.86.0 dry-run | pass; 831 assets accepted for upload |
| Local Workerd Kilo runtime | pass; health, schema v84, 12 UI routes and 268 served UI scripts, non-collapsing header/sidebar CSS, exact 5/5 Historic/Main progress, version/event Settings ACK, Block-PF/position-count/volume changes, minute-deduplicated dashboard paper pulse, external-owner queue, all global/connection state switches, statistics/history, live fail-closed, admin auth, remote-owner fail-closed route, scheduled continuity and live recovery |
| Credential-less `kilo:deploy` | expected fail-closed before upload; required runtime/owner/controller inputs absent |

OpenNext/Wrangler emitted their documented experimental `secrets`-field and
generated direct-eval bundling warnings. The bundle, Wrangler dry-run, and real
Workerd route/scheduled-event execution all completed successfully.

The Workerd state-switch run found and fixed three Kilo-specific truthfulness
issues: settings recoordination no longer reports a local apply without an
attached manager; status no longer treats coordinator intent as runtime proof;
and global Start/Resume now accepts Redis-parsed Boolean flags, allocates a new
switch generation, and durably queues each enabled connection for the distinct
long-lived owner instead of claiming that a request worker started it.

No genuine external remote host was supplied, and the validation container has
no systemd runtime, PM2 runtime, Docker, or Podman target. Therefore the test
does not claim a complete external-machine installation. The real OpenSSH
loopback run covered the network protocol, private-key authentication,
per-request host-key isolation, API streaming, GitHub revision clone, cleanup,
and canonical non-mutating preflight. The disposable SSH/bootstrap boundary
test additionally covered install mode without changing a real host.

The pushed GitHub revision's Vercel integration still reports a provider-side
failure. The same revision succeeds in both populated and empty-checkout local
Vercel builders, but the protected deployment logs require Vercel project
access or a `VERCEL_TOKEN`; no remote Vercel success is claimed without that
evidence.

The linked Kilo deployment and its public URL are supplied and are rebuilt by a
GitHub `main` update. No shared production Redis/external database or distinct
long-lived owner secret was supplied, so live exchange ordering remains
fail-closed. Public URL acceptance is performed only after this verified tree
is pushed and Kilo reports the new build deployed.

The final local server acceptance used a freshly rebuilt isolated `.next-prod`
artifact. Its three-boot five-symbol run processed 330 API reads, advanced 386
aggregate engine cycles and 966 Main strategy cycles, completed Historic/Main
from an observed 1/5 = 20% snapshot through 5/5 = 100%, kept that X/Y/percent
invariant valid throughout all 30 rounds, held the post-warm-up database
inventory stable, and measured 33 ms API P95. The separate 32-symbol
production UI flow completed QuickStart in 134 ms,
advanced nine cycles, exercised Settings/Volume hot reload plus connection and
global state switches, and left zero real positions/orders. After enabling the
development-only webpack memory optimization and lowering the Dev heap ceiling,
a 60-second Dev/HMR run processed 330 API requests, advanced 18→354 aggregate
cycles and 51→868 Main strategy cycles, kept its warm DB inventory flat, and
measured 912 ms steady P95. Its remaining large RSS wave is isolated to Next
development compiler/HMR graphs; the production process stayed below 1 GiB and
its engine/Redis inventories remained bounded.

## Production/live behavior evidence

The final maximum production preview completed a 240,123 ms soak with 32 symbols,
120 rounds, 1,320 API requests, and 400 engine cycles. Progress advanced from
855 to 11,970; 64 simulated orders/positions were created and zero real orders
were placed. Database keys grew from 651 to 7,171, with a stable-window delta
of 236 (budget 1,600) and absolute count below 16,000. Steady p95 latency was
127 ms (budget 1,000 ms). The UI test rendered dashboard/assets/info for all 32
symbols, completed QuickStart in 8,500 ms, and exercised settings/volume hot
reload, connection toggles, pause/resume/stop/start, and relationship views.
Restart identity, simulation persistence, snapshot concurrency, and recovery
checks passed. Peak RSS was 1,784,804 KiB, ended at 1,465,828 KiB, and passed
the verifier's warm-sample leak check.

The final requested five-symbol BingX read-only SDK stress fetched 1,000 candles
and ran three ticker rounds: 10 attempts, zero authenticated requests, zero
order requests, one primary-origin timeout recovered through the official
`.pro` origin, 2,702.9 ms average / 4,950 ms maximum latency, and +1.72 MiB heap.
The earlier maximum 32-symbol/6,400-candle read-only run also remains green.

A real exchange open/protect/close-flat smoke was not executed because no
authorized credentials or initial account-flat proof was available. This is a
safety blocker, not a passed test. When credentials and explicit authority are
provided, use only the account-wide-lock/minimum-venue-size procedure in
`security-model.md` and verify both positions and open orders are flat at the
end.

## Handoff invariant

Regenerate and verify the manifests after the final documentation/memory-bank
edit. Commit and push only when the release tree is secret-clean and all
non-external gates above remain green. The final Git commit and downloadable
archive checksum are recorded in the delivery handoff because a tracked file
cannot contain the hash of the commit that contains itself.
