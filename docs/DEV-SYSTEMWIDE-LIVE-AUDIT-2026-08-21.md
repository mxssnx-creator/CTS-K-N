# Systemweite Live-/PF-/Progressions-Audit — 2026-08-21

## Ergebnis

Der geprüfte Stand ist für den abgesicherten Dev- und Production-Simulationsbetrieb grün. Alle Prüfungen bleiben strikt von Mainnet-Orderausführung getrennt. Ein echter BingX-Prod-VST-Lauf ist vorbereitet, aber ohne konfigurierte X02-VST-Zugangsdaten korrekt blockiert.

## Fachliche Korrekturen

- Die Main-/Live-Stage-Zahl ist jetzt eindeutig eine **PositionCost-Koordinate**, kein klassischer Profit Factor: `1.00` ist neutral nach einer abgezogenen PositionCost, `1.10` steht für zwei PositionCost brutto / eine PositionCost netto, `1.20` für drei brutto / zwei netto.
- Klassischer realisierter `gross profit / gross loss` PF bleibt davon getrennt. Ein untagged historisches `0.x Result-R` bleibt positiv; ein fälschlich als Main-Koordinate markiertes `0.x` wird neutralisiert statt als negativer Trade ausgelegt.
- TP/SL-Set-Koordinaten sind zentralisiert. Neue TP-Topologien starten mit `5, 10, 15, 20 × PositionCost`; PositionCost wird im Backtest und Preset-Tester genau einmal abgezogen.
- Die UI zeigt bei Presets die tatsächlich konfigurierte PositionCost statt einer fest verdrahteten `0.1 %` an. Zufällig erzeugte Performance-Charts wurden entfernt; ohne gespeicherte Serie wird keine fiktive Historie dargestellt.

## System-/Datenkorrekturen

- Historische Progressionen, Live-PnL-Read-Model, PnL-Statistik und Pseudo-Positions-Semantik verwenden die kanonischen, verbindungsbezogenen Ledger.
- X01 und X02 sind für Einstellungen, Preset-Tests, Symbolstatistiken, PnL und Prozessdaten getrennt; unscoped Zugriffe werden abgelehnt.
- Dev startet nicht länger still nur X01. Aktive Verbindungen werden explizit verarbeitet.
- Runtime-Telemetrie misst Event-Loop-Auslastung je Intervall; ein einmalig arbeitsintensiver Kaltstart kann die adaptive Concurrency nicht mehr dauerhaft als kritisch markieren.
- Der Dev-Preview-Harness behandelt jetzt auch temporäre Socket-/Timeoutfehler beim Routen-Warmup mit begrenzten Retries und ist im parallelen Restart-Lauf grün.

## Live-Order-Audit

- Cooldown/FIFO-Grenzen und idempotente, kollisionsresistente `clientOrderId`-Kontrollen sind abgedeckt.
- Neue Entries konfigurieren Margin vor Leverage vor der Order; ein Margin-Fehler verhindert die Leverage-/Order-Fortsetzung.
- Persistierte Live-Positionen verwenden ausschließlich autoritative Fills für Preis und Menge. Ticker-Fallbacks erzeugen keine Phantom-Fills.
- BingX X02 Prod-VST ist nur bei `is_testnet=1`, exact VST-Origin und expliziter Bestätigung zulässig; Mainnet bleibt gesperrt.

## Laufzeit-Evidenz

| Prüfung | Ergebnis |
|---|---|
| Gesamtsuite | 197/197 Suites, 1.274/1.274 Tests grün |
| Production-Build | erfolgreich; 42 statische Seiten, 347 Trace-Dateien |
| Dev-Simulation | 32 Symbole, 4.096 MiB Heap, Inline-Redis, 0 reale Orders |
| Production-Simulation | 32 Symbole, X01/X02-Isolation, 0 reale Orders |
| Production API-Latenz | p50 6,45 ms, p95 26,71 ms, max 36,57 ms |
| Production Speicher | RSS 559,6 MiB, Heap used 245,7 MiB; Druckniveau healthy |
| Event Loop | p50 Delay 20,5 ms, p95 33,5 ms, max 402,1 ms; Intervallauslastung im ruhigen Snapshot <0,05 % (gerundet 0) |
| Direkte Strategie-Matrix | 32 Symbole, 960.512 Sets, alle Strategietypen, 884 valide Sets, 42.003 ms, Peak 92 MiB Heap |
| Async-Skalierung | deterministisch 1–16 Symbole, keine Netzwerk-/Redis-Credentials oder Orders; Peak je Child 111 MiB |
| Credential-Scan | 1.451 Dateien, 0 Findings |

## Sicherheits-/Umgebungsgrenzen

- Der Multiworker-Soak benötigt einen echten Shared-Redis-Server. In dieser Umgebung ist weder `redis-server` noch eine freigegebene Redis-URL vorhanden; deshalb wurde keine unsichere Mehrworker-Emulation verwendet.
- Der VST-Preflight wurde ohne Request und ohne Order korrekt blockiert, weil `BINGX_X02_API_KEY` und `BINGX_X02_API_SECRET` nicht konfiguriert sind.
- Ein generischer Mainnet-Preflight wurde absichtlich nicht ausgeführt. Die Laufzeitumgebung hat den Main-API-Zugriff als nicht durch die VST-Freigabe gedeckt blockiert.
- Die Cloud-Browser-Sitzung kann keine lokale `127.0.0.1`-Runtime öffnen. Die Production-Audit prüfte die gerenderten Seiten/Assets und die APIs lokal; eine externe interaktive Browserprüfung benötigt eine erreichbare Deployment-URL.

## Validierte Artefakte

- Dev-Lauf: `/tmp/cts-dev-32-retry.log`
- Production-Lauf: `/tmp/cts-prod-32-retry.log`
- BingX-VST-Preflight: `.agent-logs/bingx-vst-soak-2026-08-21T17-45-45-301Z.json`
