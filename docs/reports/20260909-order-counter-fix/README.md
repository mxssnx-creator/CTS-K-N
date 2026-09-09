# CTS-K-N order-counter validation

`report.html` is the detailed post-merge/post-reinstall report with inline SVG charts. `summary.json` contains the machine-readable checks; `remote-monitor-10m.jsonl` contains 11 read-only samples at roughly one-minute intervals. `raw/` contains redacted HTTP JSON snapshots.

The report intentionally records `entry_protection_halt` as active: Live is requested/enabled, while new venue entries remain fail-closed until an exact ownership/protection audit is complete.
