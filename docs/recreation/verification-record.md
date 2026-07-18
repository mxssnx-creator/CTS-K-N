# Release verification record — 2026-07-18

This record captures the final acceptance evidence for the Block PF/position
count/DCA, deployment, installation, durability, and recreation handoff. All
ordinary tests ran with real exchange order placement disabled. A pass is not
claimed for any credential- or target-dependent action that could not safely be
executed.

## Toolchain and static release gates

| Check | Result |
| --- | --- |
| Source base before handoff commit | `15cbbd353c64e6be35f99562a331f7b1e07cd1d7` on `main` |
| Validation host | Linux 6.12.47 x86_64; Node 24.14.0 |
| Package manager | exact `pnpm 10.28.1` through Corepack |
| Frozen dependency install | pass, offline, lockfile unchanged |
| Shell/JS/JSON/source syntax | pass |
| TypeScript | pass |
| ESLint | pass |
| Jest | 83 suites, 509 tests, 0 failures |
| Next 15.5.18 optimized build | pass; 40 static pages generated |
| Release-tree secret scan | pass; 1,122 files inspected, 0 findings |
| Redis schema | v81, sequential migration inventory |

## Strategy correctness evidence

- Block Count 1..10 are exact independent Set keys with independent result
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
- Standard → Block → DCA integration attached all confirmed legs to one parent.
  DCA used stable `#step:1..4` keys and the immutable initial quantity. A
  persisted settings update changed the next confirmed quantity from `0.004`
  to `0.011`, proving the next step uses current settings rather than a stale
  recovery snapshot.

## Deployment and installation evidence

| Check | Result |
| --- | --- |
| Canonical independent-host preflight | pass; apt host, free port 45671, 37 GiB free disk, 21 GiB RAM |
| Remote API route contract | pass; authentication, validation, disposable clone, preflight/install, seed transport, and auto/systemd/PM2 contract through the SSH boundary fixture |
| Portable minute scheduler | pass; both required paths, 60,000 ms interval |
| Full Vercel builder | pass; local provider simulation reproduced and eliminated read-only `corepack enable` EROFS, Next 15's zero-byte `export-marker.json`, and stale `export-detail.json` false-static classification; final output contains 149 routes, dynamic/API functions, 23 MiB artifacts, and no invalid JSON |
| OpenNext 1.20.1 build | pass; generated `.open-next/worker.js` |
| Wrangler 4.86.0 dry-run | pass; 808 assets, 28,793.40 KiB upload / 4,272.51 KiB gzip |
| Local Workerd Kilo runtime | pass; health, schema v81, Kilo ownership, admin auth, remote-owner fail-closed route, scheduled continuity and live recovery |
| Credential-less `kilo:deploy` | expected fail-closed before upload; 10 required runtime/owner/controller inputs absent |

OpenNext/Wrangler emitted their documented experimental `secrets`-field and
generated direct-eval bundling warnings. The bundle, Wrangler dry-run, and real
Workerd route/scheduled-event execution all completed successfully.

No genuine remote host was supplied, and the validation container has no SSH
server, systemd runtime, PM2 runtime, Docker, or Podman target. Therefore the
test did not claim a real external machine installation. The non-mutating
current-host preflight and the complete disposable SSH/bootstrap route test are
the maximum safe coverage available without external host authority.

No Cloudflare account/token, shared production Redis, public deployment URL,
or distinct long-lived owner secret was supplied. The real Kilo upload was not
attempted after preflight rejected those missing inputs.

## Production/live behavior evidence

The maximum production preview completed a 240,130 ms soak with 32 symbols,
120 rounds, 1,320 API requests, and 400 engine cycles. Progress advanced from
835 to 12,179; 64 simulated orders/positions were created and zero real orders
were placed. Database keys grew from 655 to 6,996, with a stable-window delta
of 185 (budget 1,600) and absolute count below 16,000. Steady p95 latency was
126 ms (budget 1,000 ms). The UI test rendered dashboard/assets/info for all 32
symbols, completed QuickStart in 11,478 ms, and exercised settings/volume hot
reload, connection toggles, pause/resume/stop/start, and relationship views.
Restart identity, simulation persistence, snapshot concurrency, and recovery
checks passed. Peak RSS was 2,027,232 KiB and remained inside the verifier's
warm-baseline budget.

The final public BingX read-only stress fetched 6,400 candles for 32 symbols
and ran six ticker rounds: 39 attempts, zero authenticated requests, zero order
requests, zero retries, zero timeouts, 710.9 ms average / 2,917.4 ms maximum
latency, and +2.03 MiB heap.

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
