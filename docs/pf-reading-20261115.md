# How to read PF (owner, 2026-11-15) -- info for every session of this project

Owner: "pool PF under 1 is normal, note this .. important is always post Base and exec PF!!!"

- **Pool PF** (every configuration's raw tape, every signal onset, before the Base validation) is normally **under 1**: the signals' gross move per order is
  smaller than the cost of one order, so an unfiltered pool reads about 0.4 - 0.9. That is expected. It is not a defect and not, by itself, a reason to remove
  an indication, a range or a configuration.
- What decides is the **post-Base PF** (the configurations that passed their own validation, with the share validated and the orders behind it) and above all
  the **executed PF** (the positions the engine actually opened, simulated walk-forward or live), read on the development AND the sealed window.
- Quote PF two ways where both exist (equal weight per close, and in money) and never quote a volume-weighted PF as a unit PF.
- A change ships only when its executed PF is better on both windows (or by an explicit owner instruction, with the measurement reported next to it).

## Evidence from CTS-G (x02 settings, 4 symbols, 3-day windows; see CTS-G `CLAUDE.md`, 2026-11-15)
- Pools: every onset of the 1,812 CTS-A-O Inverse names PF 0.37 - 0.85 in all four windows; slow 30 min reversion onsets 0.49 - 0.79.
- Executed PF by configuration type (development / sealed / live demo): trailing **1.76 / 2.03 / 1.99**, base 0.68 / 0.85 / 0.59, exit-only 0.00 / 0.00 / 0.17.
- Volume tilt toward the type that succeeds (trailing x 2, exit-only x 0.5; same orders, only the size): volume-weighted PF 1.054 -> 1.264 (development),
  1.082 -> 1.533 (sealed), drawdown +1.7 / +1.6 points; shipped in CTS-G x01 / x02 as `volumeByKind` {"trail": 2.0, "exit": 0.5}.
- For this project: measure the executed PF per configuration type in its own engine first; tilt volume only toward a type that is above 1 on both windows.
