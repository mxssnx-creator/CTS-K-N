# Independent BingX X01 pulse desk

Live mainnet scalper + CTS Block 1–12. Does not talk to the CTS engine.

Unit: `grok-pulse@<connection>.service`

The former local HTTP stats/config dashboard was removed. The pulse worker
does not require an HTTP control surface; operate it through systemd and the
connection-scoped files in this directory.
