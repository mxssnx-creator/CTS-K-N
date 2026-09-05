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
- Regular Count ladders are created only from normal Base-derived Sets
  (including Base trailing variants), never from Pos-Count/axis Sets.
- The independent Active Real procedure counts every non-terminal Real
  position for the same symbol and direction, including Pos-Count positions.
  Pos-Count activity changes the active count; it does not become a Block
  source Set of its own.
- Existing position: the Block is an add-on to the same symbol/direction parent.
- No parent: the Block waits; it never opens a standalone adjustment position.
- Each count remains unavailable only while its own leg is active or paused.

### DCA

- Gate: the DCA strategy toggle is the inclusion gate; each adverse-price step
  is resolved independently against the confirmed initial entry at Live.
- Uses its own configured multiplier and does not reuse the Block formula.

## Block volume formula

For an existing live position:

```text
recoveryStep = min(requestedRecoveryStep, blockIncrementSteps)
targetMultiplier = 1 + (blockCount × blockVolumeRatio × recoveryStep)
targetAddQty = generalBaseQty × (targetMultiplier - 1)
targetBlockQty = generalBaseQty + targetAddQty
confirmedBlockAddQty = sum(confirmed Block leg fills)
nextOrderQty = max(0, targetAddQty - confirmedBlockAddQty)
aggregateQtyAfter = currentExchangeQty + confirmedFilledNextOrderQty
```

Where:

- `generalBaseQty` is the immutable confirmed Standard/Trailing parent fill.
- `blockCount` is the independent count encoded in the Block Set key.
- `blockVolumeRatio` is the operator setting (default `1.0`, range `0.25..3.0`).
- Earlier Block fills are subtracted from the next absolute target.
- Only an exchange-confirmed fill is added to local executed quantity.

Example with general volume `1`, ratio `1.5`, and valid Counts 1–3:

```text
Count 1: target add=1.5; confirmed before=0.0 → order=1.5 → total=2.5
Count 2: target add=3.0; confirmed before=1.5 → order=1.5 → total=4.0
Count 3: target add=4.5; confirmed before=3.0 → order=1.5 → total=5.5
```

If Count 3 is selected first, its one order is `4.5` and the total is still
`5.5`. A later lower Count remains an independent evaluated/paused Set but is
recorded as already covered and sends no exchange order. This preserves
independent Set results without over-adding physical exposure.

## Independent minimum PF coordinate

Every `blockCount` is validated independently at the Real stage before Live
selection. Its minimum PositionCost coordinate scales only the positive
distance above neutral `1.00`, proportional to the configured ratio and that
count's actual volume increment:

```text
blockMinPF = 1 + ((defaultMinPF - 1) × blockProfitFactorRatio × blockVolumeIncrement)
blockVolumeIncrement = (1 + blockVolumeRatio)^min(blockCount, blockIncrementSteps) - 1
```

`blockProfitFactorRatio` is configurable from `0.2..5.0` and defaults to
`1.1`. `blockIncrementSteps` is configurable from `1..2` and defaults to `2`.
Counts above that physical increment cap remain independent Real Rows for
evaluation, statistics, and attribution, but cannot submit duplicate add
orders for an already-covered target. The exact Block Set reads the same latest-closed-position window and
uses the same minimum-sample threshold as the normal coordinate calculation. A
cold enabled lane starts immediately from the matching normal coordinate, with
no private Block progression. Once its own window is mature, its effective
minimum is the greater of the matching normal coordinate and the configured
count-specific floor. Classic realized PF remains a separate
gross-profit/gross-loss statistic.
Results from another Block count are never reused. Active counts remain valid
until their exchange position closes, even if a later settings change raises
their current minimum.

The Real scope graph also evaluates Strategy lanes per
`symbol × long|short|overall × count` and Signal lanes per
`source × symbol × long|short|overall × count`. Overall combines realized
evaluation history only; executable Long and Short quantities remain separate.
All lanes keep calculated/eligible/difference/PF statistics while the strategy
switch is disabled. Disabled means no new Block emission, while already-open
exposure remains present for reconciliation.

## Data flow

```text
normal Base-derived Set (Pos-Count Set excluded)
  → Real-stage independent Count coordination
  blockCount × ratio
  → StrategySet Block metadata
  → RealPosition absolute target metadata
  → Live remaining delta from immutable general base quantity
  → durable pending outbox before submission
  → confirmed/partial fill stored as BlockLegState
  → exact aggregate quantity reconciled and SL/TP re-armed

all non-terminal Real positions (Pos-Count positions included)
  → symbol + Long/Short activity count
  → independent #block:active:N Real overlay
  → same absolute target/delta execution procedure
```

The Main/Real multiplier remains lineage and audit metadata. Live only executes
a Block against an authoritative same-side Standard/Trailing parent and uses
that parent's confirmed exchange quantity; it never synthesizes a standalone
Block entry from configuration.

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
targetAdditionalQuantity?: number
confirmedAdditionalQuantityBefore?: number
targetBlockQuantity?: number
targetSatisfied?: boolean
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

- [x] Formula: `total = baseQty + ((baseQty × ratio) × blockCount)`.
- [x] Sequential Count orders submit only the remaining delta to that target.
- [x] Non-consecutive counts retain independent volume metadata.
- [x] Count range is clamped to `1..6` (default `6`).
- [x] Ratio is clamped to `0.25..3.0` (default `1.0`).
- [x] PF ratio is clamped to `0.2..5.0` (default `0.8`).
- [x] Count 1..N each use an exact Set key, own PF/DDT window, own minimum PF,
      own active/pause state, and own Real-stage statistics.
- [x] Cold Blocks use the matching normal closed-position PF immediately;
      mature Blocks below that PF cannot create a new add-on.
- [x] Strategy and Signal source Long/Short/Overall lanes remain independent.
- [x] Disabled strategy paths still publish calculation, eligibility,
      difference and PF statistics without new emission.
- [x] Active Real and Active Live toggles persist independently.
- [x] Partial fills and restart recovery retain exact order/quantity state.
- [x] Concurrent close-PnL pause updates cannot lose a decrement.
- [x] Standard and DCA paths remain separate from existing-position Block sizing.
