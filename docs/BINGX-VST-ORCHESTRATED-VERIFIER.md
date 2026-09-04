# BingX Prod-VST orchestrated verifier

`pnpm test:bingx:vst:orchestrated` is a fail-closed release gate with two
separate safety phases. It discovers the current contract inventory from the
BingX Prod-VST contracts endpoint and records the exact normalized, unique,
sorted symbol set in an owner-only JSON artifact under `.agent-logs/`. No
checked-in symbol list is authoritative.

## Required approvals and prerequisites

The exhaustive phase forces exchange submission off. It requires a running
candidate application, Redis, and an approved Playwright installation/browser;
set `BINGX_VST_VERIFY_APP_URL` if it is not at `http://127.0.0.1:3000`.

The authenticated phase is **not** implied by running the gate. It runs only
when all of the following exact values and host facts are present:

```text
BINGX_VST_VERIFY_AUTHENTICATED=1
BINGX_VST_VERIFY_CONNECTION_ID=bingx-x02
BINGX_VST_VERIFY_EXCHANGE=bingx
BINGX_VST_VERIFY_ENVIRONMENT=prod-vst
BINGX_VST_VERIFY_CONFIRM=I authorize X02 BingX Prod-VST virtual minimum-volume lifecycle orders
BINGX_VST_VERIFY_SERVICES_INACTIVE=1
```

The runtime maintenance marker must independently exist. Operators must verify
the guarded production services are inactive before setting the final
attestation. X02 credentials are loaded only by the existing lifecycle runner.
X01/mainnet and all Bybit connections remain read-only and are never approved
for order placement.

The lifecycle delegates to `run-bingx-vst-live-soak.ts`, preserving its exact
VST confirmation, virtual minimum sizing, hard notional ceiling, CTS-owned
order prefixes, representative symbol selection, baseline snapshot, cleanup,
stranded-order rejection, and exact baseline-restoration checks. It must not be
expanded into an all-instrument order test.

## Gate and artifacts

The computation artifact includes discovery time and endpoint, exact count and
symbols, complete per-symbol lane coverage, generation, peak concurrency,
event-loop lag, stabilized heap delta, and bounded Redis-key delta. It fails on
any missing symbol/lane, bad statistic, missed event, progression mismatch,
Base/Main/Real/Live or coordinator divergence, or resource-bound violation.

Playwright visits the principal operational pages, opens connection dialogs
and overview UI, locates lifecycle controls, statistics and logs in the rendered
accessibility tree, and checks SSE plus polling fallback. This is deliberately
browser-level validation; compiled JavaScript is never searched. The lifecycle
runner writes its separate owner-only report. Retain both reports with the
reviewed commit and operator approval record; reports must never contain keys,
secrets, raw account reports, or Redis snapshots.

