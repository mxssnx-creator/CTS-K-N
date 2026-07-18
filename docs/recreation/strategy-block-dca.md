# Strategy, Block and DCA specification

## Common Set identity

Every executable Strategy Set has a stable `setKey`, optional `parentSetKey`,
variant, indication type, direction, scalar metrics, and axis lineage. Confirmed
position entries create exact Set memberships. Realized closes write a bounded
result ring for every exact and parent lineage key. Candidate evaluation alone
does not increment position counts.

## Position-count axes

| Axis | Supported range | Data source | Semantics |
| --- | ---: | --- | --- |
| Previous | 1..12 (configured step/range) | completed results | last-N PF filter |
| Last | 1..4 | completed results | last-M positive/negative outcome |
| Continuous | 1..8 | confirmed active entries per direction | only reached counts emit |
| Pause | 1..8 | completed-position lifecycle | independent pause window |
| Direction | long, short | Set configuration | independent Cartesian branch |

The ledger uses up to 12 recent results for axes because Previous supports 12.
Connection Block PF uses the configured normal previous-position window (up to
its supported bound), not the axis maximum.

## Block configuration

| Field | Range/default | Effect |
| --- | --- | --- |
| `variantBlockEnabled` | boolean, default on | emits/clears all Block paths |
| `blockMaxStack` | 1..10, default 10 | independent counts evaluated |
| `blockVolumeRatio` | 0.25..3.0, default 1.0 | additive increment per count |
| `blockProfitFactorRatio` | 0.2..5.0, default 0.8 | scales count-specific PF floor |
| `blockPauseCountRatio` | bounded count multiplier | exact post-close cooldown |
| `blockActiveRealEnabled` | default on | active Real overlay |
| `blockActiveLiveEnabled` | default on | active Live overlay |

The `blockProfitFactorRatio` control is present in global Strategies/Block,
connection settings, preset settings and preset editing. Persistence,
normalization, migrations, fingerprints, hot reload, stats and API output use
the same field.

## Exact Block formulas

For count `n` and the position quantity confirmed immediately before the leg:

```text
volumeIncrement(n) = n × blockVolumeRatio
requestedAddQty(n) = confirmedCurrentQty × volumeIncrement(n)
blockMinPF(n) = defaultMinPF × blockProfitFactorRatio × volumeIncrement(n)
```

`defaultMinPF` is the normal/default calculation's current Real-stage minimum.
The Block does not multiply its volume increment by the legacy profile base
multiplier. The profile multiplier remains metadata/coordination; actual add-on
quantity and minimum PF use the same increment ratio.

Example: current confirmed quantity `2`, ratio `0.5`, factor `0.8`, default
minimum PF `1.2`:

| Count | Increment | Requested add | Minimum PF |
| ---: | ---: | ---: | ---: |
| 1 | 0.5× | 1 | 0.48 |
| 2 | 1.0× | 2 | 0.96 |
| 3 | 1.5× | 3 | 1.44 |

If Count 1 fills before Count 3 is selected, Count 3 snapshots the newly
confirmed aggregate quantity. This is intentional: every leg is independent,
but all legs adjust one authoritative venue position.

## Independent Block evaluation

For every source Set, Count1..CountN gets:

- a distinct `#block:N` Set key;
- its own last-N realized result ring;
- the same window length and minimum-sample threshold as normal PF;
- its own observed PF, DDT, minimum PF, active flag, pause flag, order outbox,
  confirmed quantity, and stats row;
- an active-exposure exemption until terminal reconciliation.

Before the exact count has enough samples, observed PF inherits the eligible
source Set's observed PF. It never borrows another count's results. Disabling
Block or removing sources clears all Count1..10 and active-overlay stats so a
stale non-zero dashboard value cannot survive.

The Real safety cap retains active exact counts. New Block candidates do not
consume the non-default fairness reserve because up to ten counts per source
could starve DCA/trailing; their own PF ranking competes for remaining capacity.

## Block leg persistence

A confirmed leg records count, exact key, requested/filled/base/aggregate
quantities, base profile multiplier, volume ratio/increment, pause count,
client/order IDs and timestamps. A partial fill adds only its observed delta
and leaves pending state until terminal or fully filled. Closing removes its
active index and starts an exact pause. Close retry is idempotent.

## DCA configuration and execution

DCA is disabled by default. Enabling it emits one stable `parent#dca` recovery
candidate per eligible parent. Live resolves readiness from price and completed
steps:

```text
adverse(long)  = max(0, (initialPrice - currentPrice) / initialPrice × 100)
adverse(short) = max(0, (currentPrice - initialPrice) / initialPrice × 100)
stepQty(i)     = confirmedInitialQty × stepVolumeMultiplier(i)
```

Defaults: four steps; volume multipliers `1.5, 2.0, 2.3, 2.5`; adverse distances
`0.5%, 1.0%, 1.5%, 2.0%`; 30-second cooldown. Arrays are clamped and distances
made non-decreasing. Each filled step uses `parent#dca#step:N`, so step 1 cannot
suppress steps 2..4 and retry of the same step remains idempotent.

The current settings hashes are read for every next-step decision and layered
in this order:

1. last executed position-local profile (restart fallback);
2. legacy connection settings;
3. canonical current connection settings;
4. explicit RealPosition profile, when intentionally supplied.

Alias fields are canonicalized per layer. A settings save therefore affects the
very next DCA step even while the parent remains open.

DCA take profit supports average entry, first entry, or breakeven-plus. After a
confirmed add, the live stage recalculates aggregate price/quantity and re-arms
protection under the selected mode.

## Required regression evidence

The primary contracts are in:

- `__tests__/unit/block-count-state.test.ts`;
- `__tests__/unit/strategy-block-real-overlays.test.ts`;
- `__tests__/unit/strategy-axis-coordination.test.ts`;
- `__tests__/unit/trailing-dca-strategy.test.ts`;
- `__tests__/unit/strategy-position-entry-ledger.test.ts`;
- `__tests__/integration/main-engine-live-dispatch.test.ts`.
