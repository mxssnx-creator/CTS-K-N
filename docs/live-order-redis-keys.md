# Canonical Redis keys for live order placement

`lib/live-order-service.ts` is the canonical writer for manual/testing route exchange orders and live-stage entry/accumulation accounting.

| Concept | Canonical Redis key |
| --- | --- |
| Order intent | `settings:orders` through `getSettings('orders')` / `setSettings('orders', ...)` |
| Exchange order lookup | `live:order:{connectionId}:{exchangeOrderId}` when the live position persistence layer can index an exchange order id |
| Live position | `live:position:{livePositionId}` plus the `live:positions:{connectionId}` open-position index |
| Progression counters | `progression:{connectionId}` hash fields such as `live_orders_placed_count`, `live_orders_filled_count`, `live_positions_created_count`, `live_orders_failed_count`, `live_orders_simulated_count`, and `live_volume_usd_total` |
| Per-symbol order counters | `live_orders_by_symbol:{connectionId}` hash fields in `{SYMBOL}:{long|short}:{placed|filled|failed}` format |
