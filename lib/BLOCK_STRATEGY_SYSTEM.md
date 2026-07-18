# Block Strategy System

## Overview

Block and DCA are `adjust` strategies that run alongside the axis-coordinated
`standard` strategies. Block counts are not a shared counter: every valid count
has its own Set key, volume calculation, active marker, order metadata, and
post-position pause lifecycle.

## Strategy types

### Standard

- Types: Default, Trailing, Pause, and axis-based position-count strategies.
- Coordination: `prev`, `last`, `cont`, and `pause` windows.
- Block/DCA scaling does not modify their size.

### Block

- Gate: every valid count in `1..blockMaxStack` is evaluated independently.
- Default state: variant, Active Real, and Active Live are enabled.
- Existing position: the Block is an add-on to the same symbol/direction parent.
- Fresh position: the propagated strategy multiplier sizes the initial order.
- Each count remains unavailable only while its own leg is active or paused.

### DCA

- Gate: loss-driven (`prevLosses >= 1`).
- Uses its own configured multiplier and does not reuse the Block formula.

## Block volume formula

For an existing live position:

```text
addQty = currentPositionQty × (blockCount × blockVolumeRatio)
aggregateQtyAfter = currentPositionQty + confirmedFilledAddQty
```

Where:

- `currentPositionQty` is the confirmed exchange quantity immediately before
  this Block add-on.
- `blockCount` is the independent count encoded in the Block Set key.
- `blockVolumeRatio` is the operator setting (default `1.0`, range `0.25..3.0`).
- Only an exchange-confirmed fill is added to local executed quantity.

Example with ratio `1` and valid Blocks 1 and 3:

```text
Block 1: base=1 → add=1 × (1 × 1)=1 → aggregate=2
Block 3: base=2 → add=2 × (3 × 1)=6 → aggregate=8
```

The second calculation uses the quantity confirmed after the first leg. Thus
non-consecutive Blocks retain independent calculations while still coordinating
against the one authoritative exchange position.

## Independent minimum ProfitFactor

Every `blockCount` is validated independently at the Real stage before Live
selection. Its minimum ProfitFactor is proportional to the normal/default Real
threshold and that count's actual volume increment:

```text
blockMinPF = defaultMinPF × blockProfitFactorRatio × blockVolumeIncrement
blockVolumeIncrement = blockBaseVolumeMultiplier × blockCount × blockVolumeRatio
```

`blockProfitFactorRatio` is configurable from `0.2..5.0` and defaults to
`0.8`. The exact Block Set reads the same latest-position window as the normal
PF calculation. Until that complete own window exists, it uses its source Set's
observed PF plus the Block profile bias; results from another Block count are
never reused. Active counts remain valid until their exchange position closes,
even if a later settings change raises their current minimum.

## Data flow

```text
Main/variant coordination
  sourceBaseMultiplier × (blockCount × ratio)
  → StrategySet Block metadata
  → RealPosition Block metadata
  → Live add-on from confirmed current exchange quantity
  → durable pending outbox before submission
  → confirmed/partial fill stored as BlockLegState
  → exact aggregate quantity reconciled and SL/TP re-armed
```

The Main-stage multiplier is needed for a fresh Block entry. Once a same-side
position exists, Live uses the authoritative current exchange quantity instead
of synthesizing a base quantity from configuration.

## Persisted fields

`StrategySet` and `RealPosition` carry:

```typescript
strategyType?: "standard" | "adjust"
baseMultiplier?: number
blockBaseVolumeMultiplier?: number
blockVolumeRatio?: number
blockProfitFactorRatio?: number
blockDefaultMinimumProfitFactor?: number
blockMinimumProfitFactor?: number
blockObservedProfitFactor?: number
blockProfitFactorWindow?: number
blockProfitFactorSampleCount?: number
blockCount?: number
blockCalculatedVolumeMultiplier?: number
```

Every live Block leg carries:

```typescript
setKey: string
blockCount: number
baseVolumeMultiplier: number
volumeRatio: number
volumeMultiplier: number
baseQuantity?: number
requestedQuantity?: number
quantity: number
positionQuantityAfter?: number
pauseCount: number
clientOrderId?: string
orderId?: string
```

`quantity` is the confirmed fill, not the requested quantity. A partial fill
keeps the pending accumulation record until the order is terminal or the full
request is observed.

## Independence and pause coordination

- Block 1, Block 3, and any other enabled counts can be valid together.
- Active Block fields are indexed by normalized symbol plus exact Set key.
- Closing a realised position advances every existing pause once.
- Block legs on that closed position then start their own count-specific pause.
- Network Redis performs pause advancement, activation, and idempotency marking
  in one Lua operation; the inline adapter serializes updates per connection.
- A retry of the same close cannot advance pauses twice.

## Crash and restart handling

- The client order ID and requested Block quantities are persisted before send.
- Restart recovery queries the original client/order ID and never blindly
  resubmits an ambiguous add-on.
- Partial fills apply only the newly observed delta.
- Exchange position reconciliation derives cumulative fill from the stored
  baseline and prevents duplicate quantity application.
- Protection orders are rebuilt for the exact confirmed aggregate exposure.

## Validation checklist

- [x] Formula: `baseQty × (blockCount × ratio)`.
- [x] Non-consecutive counts retain independent volume metadata.
- [x] Count range is clamped to `1..10` (default `10`).
- [x] Ratio is clamped to `0.25..3.0` (default `1.0`).
- [x] PF ratio is clamped to `0.2..5.0` (default `0.8`).
- [x] Count 1..N each use an exact Set key, own PF/DDT window, own minimum PF,
      own active/pause state, and own Real-stage statistics.
- [x] Active Real and Active Live toggles persist independently.
- [x] Partial fills and restart recovery retain exact order/quantity state.
- [x] Concurrent close-PnL pause updates cannot lose a decrement.
- [x] Standard and DCA paths remain separate from existing-position Block sizing.
