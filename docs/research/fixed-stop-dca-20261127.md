# Fixed-stop DCA research, November 2026

BCH-USDT, XRP-USDT and SOL-USDT each had zero DCA configurations that qualified in the selection week. The study leaves funded defaults in place. It used the native offline DCA simulator. No exchange orders were submitted.

| Configuration group | Configurations per symbol | BCH selected | XRP selected | SOL selected |
| --- | ---: | ---: | ---: | ---: |
| Short and Long fixed stops with a 2.5 SL/TP ceiling | 5,040 | 0 | 0 | 0 |
| Previously supported last-rung stop multiples | 1,104 | 0 | 0 | 0 |

The 14-day interval ran from November 12 through 25 UTC, with two warmup days. The first seven days selected configurations. The next seven days were withheld from that selection. These candles overlap other CTS research. Each selection required at least 30 closes, positive net return, PF of at least 1.10, and an adverse drawdown bound of at most 5% of initial order notional at both 0.15% and 0.225% round-trip cost. The second-week minimum was 12 closes, with the same cost and risk criteria. None passed both halves. Examined alone, the second week had 72 fixed-stop configurations passing the stress criteria on BCH, zero on XRP and 410 on SOL.

The fixed grid contains 3,264 Short-band and 1,776 Long-band configurations per symbol. Both retain their own identity at a 1.2% target. Candidates below the minimum executable stop beyond the last rung, or above the target-specific ratio ceiling, are excluded before evaluation. The plan includes four entry rules, 5/15/30-minute candles, one to four rungs, two distance ladders and 0.10× or 0.25× base size per rung. It tests 0.8% and 1.2% targets.

The model measured gross positive and negative trades after costs, net return, adverse and closed drawdown, maximum position size and profitable close hours. The source was Binance USD-M perpetual candles aggregated from complete 1-minute bars. Venue queues, funding and partial fills were outside the simulation.

Use the adjacent frozen plan as `frozen-plan.json` and prepare `input.json` from contiguous OHLCV candles as specified in `scripts/research-dca-matrix.ts`. Run `node --import tsx scripts/research-dca-matrix.ts "$STUDY_DIRECTORY"`. The runner writes per-configuration and per-symbol metrics and the training-only choice before scoring the second week. Both models used input SHA-256 `9f308d64909cc329a2536c0dba477ce1de7c98729b9ff8a7d13dc0247c0161bd`. The fixed plan SHA-256 is `c3eb10b001de85a480b5f703a1be66be34c23ab07be62d427f64ec7c383d37be`.
