# CTS-K-N maximum holding time and final-stage PF

## Runtime behavior

Settings → System controls the general maximum in milliseconds, optional shorter range limits in minutes, and Auto Hold Time. An empty environment value now gives the 240-minute default instead of silently turning off the paper timer. A saved system value takes precedence. Explicit zero disables the general timer. Special and Direct-Trade retain their own strategy deadlines. Direct-Trade defaults to 120 minutes and uses the stricter system or range limit when one applies. Realtime paper positions, the Live reconciliation paths, prehistoric indication measurement, Signal forward measurement and Historic Test replay share the configured limit. A new cap invalidates the corresponding Historic Test approval until that replay refreshes.

While the general timer is enabled, open positions retain the limit committed at entry or use the tighter current cap. The exchange timer starts at the first confirmed fill when available. Older rows use the original creation time. Add orders and mark updates do not reset the timer. Expiry follows the owned close path and keeps the exchange confirmation and protection barriers. A timed Signal replay close uses the timestamp of the first observable exit price. Ordinary Direction indications now use the Main range.

Auto Hold Time is opt-in. It evaluates at most eight shorter deadlines using marks observed within one minute of each deadline on the same fixed-protection, single-entry paper position. A candidate needs 24 matched outcomes in two chronological groups of 12. At both normal and stressed cost, each group must beat the baseline net P&L, reach at least 1.10 PF and avoid higher drawdown. A decision is scoped to the connection, symbol, side, exact Set, TP, SL, PositionCost and original cap. Unobserved prices, stale proofs, synthetic marks and unsupported paths use the configured cap. Evidence is bounded to 24 closes per lane, expires after 14 days and is reused for 30 seconds between updates. Applied timers are visible on the canonical records as `holdLimitMs` and `automaticHoldTime` for Live positions and `hold_limit_ms` and `automatic_hold_time` for paper positions.

Mature Real and Live windows must also pass classic after-cost PF above 1.0. The PositionCost-relative stage threshold is a separate check. DCA uses its own mature result window in the scalar final stage and an already validated Real predecessor during bootstrap. Once a Set requires exchange evidence, a missing or insufficient venue window blocks promotion. Held rows that fail promotion stay eligible for protection and stay out of passing counts.

## Fourteen-day replay

The same digest-verified November BingX archive supplied 32 perpetual markets. Warm-up used November 9–11 UTC, development used November 12–18 and the later check used November 19–25. The two trading phases are nonoverlapping and retrospective. The study tested 104 price, protection and timeframe profiles at seven fixed caps plus the matched Auto Hold rule, for 800 policy/profile cells. The 15-minute run included only the 72 profiles with a compatible bar size. The staged replay used 5, 15 and 30-minute entry/exit bars and signed Last-N alternatives. The model uses 0.15% base and 0.26% stressed round-trip cost on filled exposure. Drawdown is closed equity with $100 initial notional and $10,000 starting equity.

| Cap | Early PF | Early stress PF | Later PF | Later stress PF | Worst later DD, base |
| --- | ---: | ---: | ---: | ---: | ---: |
| 15 min | 0.509 | 0.307 | 0.411 | 0.258 | 0.338% |
| 30 min | 0.623 | 0.432 | 0.534 | 0.383 | 0.848% |
| 60 min | 0.745 | 0.569 | 0.598 | 0.448 | 1.145% |
| 90 min | 0.725 | 0.556 | 0.631 | 0.484 | 1.373% |
| 120 min | 0.762 | 0.597 | 0.674 | 0.546 | 1.363% |
| 240 min | 0.817 | 0.657 | 0.731 | 0.611 | 1.511% |
| 480 min | 0.812 | 0.682 | 0.791 | 0.672 | 1.998% |
| Auto Hold, 240-min control | 0.815 | 0.657 | 0.733 | 0.609 | 1.511% |

These pooled PFs divide aggregate winning P&L by aggregate losing P&L across profile cells. A market opportunity may appear in multiple cells. The maximum drawdown is the worst individual profile. Auto Hold changed 213 later exits at base cost and 158 at stressed cost across the cells. It selects from earlier settled trials and uses the baseline's entry schedule, so the comparison does not add entries made possible by an earlier exit.

The eight-hour setting produced two development winners. With TP 1.8% and SL 1.8%, the 5-minute mean-reversion profile fell from PF 1.512 over 285 entries to 0.646 over 481. With the same TP and SL 2.7%, it fell from 1.743 over 168 entries to 0.636 over 359. No profile met PF 1.10, 30 closes and drawdown at most 5% at both costs in both periods. The general four-hour default remains and Auto Hold stays opt-in. The available data does not establish final-stage profitability or live x02 parity. The managed x02 activation path was unavailable. No service deployment or venue orders were part of the verification.

## Reproduction and continuity

Use the pinned dependencies and the archive and CSV schema in [the prior replay](exact-last-n-stage-lineage-20261127.md#reproduction). Provide the four UTC boundaries listed above, as epoch milliseconds, and SHA-256 for all 32 CSVs.

```sh
for minutes in 15 30 60 90 120 240 480; do
  node --require ./scripts/test-network-isolation.cjs --import tsx \
    scripts/regression/last-n-stage-market-replay.ts STUDY.json "HOLD-$minutes.json" --sweep "--hold-minutes=$minutes"
done
node --require ./scripts/test-network-isolation.cjs --import tsx \
  scripts/regression/last-n-stage-market-replay.ts STUDY.json AUTO.json --sweep --hold-minutes=240 --auto-hold-study
```

Starting source is merged main `d38febc3c21f0ca628e8b5a2f2ad424db5632592` after [PR #592](https://github.com/mxssnx-creator/CTS-K-N/pull/592). The strict-stage and fixed-band DCA branch remains a distinct experiment. The protected order-batch and Relate branches retain their own prior verification and are outside this time-limit change. The verified pre-edit checkpoint is `/workspace/backups/CTS-K-N/20261127T102746Z-before-max-and-auto-hold-time`.
