# CTS v3.7 – Projektinformation und Fortsetzung

## Verbindliche Fortsetzung und Integration (Nutzeranweisung 2026-09-06)

- Bei jeder Fortsetzung alle älteren unveröffentlichten Änderungen, lokalen Branches, offenen PRs und neueren Änderungen inventarisieren und anhand des gemeinsamen Vorgängers vergleichen.
- Jede ältere Änderung entweder integrieren, als bereits enthalten belegen oder ihre Überarbeitung durch eine neuere Implementierung einzeln dokumentieren. Keine ältere Arbeit stillschweigend verwerfen oder neuere Korrekturen mit älterem Code überschreiben.
- Verifizierte Backups erstellen; danach integrieren/überarbeiten, vollständig testen, über GitHub pushen und grüne PRs mergen; erst anschließend gemergtes main remote reinstallieren und HTTP/UI, Statistiken, Koordination und Stabilität erneut prüfen.
- Canonical Workspace, verwalteten Chisel-Zugang, persistente Konfiguration und Daten über Reinstall und Chatwechsel erhalten.
- Historische Tests umfassen 14 vollständig abgeschlossene UTC-Tage. Konfigurationsdimensionen, vollständige ausgeführte Matrix, nicht abgedeckte Dimensionen, Datenlücken, Kosten, PF, Drawdown und Ergebnisse pro Konfiguration im HTML-Bericht ausweisen.
- Systemweite Defaults/Mindestwerte nur nach belastbaren positiven Ergebnissen nach Kosten und unabhängiger Validierung ändern. Mehrere hundert Orders sind ein Kapazitäts-/Koordinationsziel, kein Grund, Qualitäts-, Schutz- oder Eigentumsprüfungen zu umgehen. Exchange-Abnahmetests bleiben X02 Prod-VST mit virtuellem Mindestvolumen; fremde Orders unverändert lassen.
- Keine Produktionsreife behaupten, solange erforderliche Gates, Remote-Stabilität oder Order-/Statistikabgleich offen sind. Exakte Fortsetzung in `docs/PROJECT-CONTINUATION.md` und `.kilocode/rules/memory-bank/context.md` pflegen.

Aktive Integration: `/workspace/CTS-K-N-worktrees/continuation-20260906`, Branch `codex/continuation-20260906`, Basis `752d4e5a155094978ee647ed323173edca74bf98`. Canonical Altstand bleibt unter `/workspace/CTS-K-N` bis zum geprüften Abschluss gesichert.

Älterer Stand: `2041787b`, 31 geänderte und 3 damals unversionierte Dateien; sämtliche 34 Dateien einzeln per Dreiwegevergleich geprüft. 13 identisch, 4 bereits integriert, 17 Konfliktdateien vollständig durch neuere Implementierungen abgedeckt. Konflikte betreffen additive Block-Counts/Stufen, Margin- und Order-Schutz, Retention, Basket-Generation und Test-/UI-Verträge. Der neuere additive Block-Vertrag bleibt erhalten. Keine alte Funktion ist durch blindes Überschreiben entfernt worden.

Offener Dashboard-Stand aus PR315 wurde in den Integrationsbranch übernommen. Der bestätigte Vercel-Fehler ist eine fehlende `vercel-build`-Kompatibilitätsalias; Integration benutzt exakt denselben Build sowie identische Vor-/Nachbereitung wie `build`. Ein Statistikfehler markiert fehlerfreie Zyklen ohne Signale als fehlgeschlagen; Integration korrigiert diesen anhand der tatsächlichen Pipeline-Fehler. Bestehende historische Fehlerzähler bleiben als Altdaten erhalten.

Remote-Vorabprüfung 2026-09-06: verwalteter SSH-Banner bestätigt, Host `v2202607384858486523`, `/opt/cts-kn` auf `752d4e5a`, HTTP200, CTS-K-N-Dienste aktiv/NRestarts0; Redis PONG, NRestarts63, Speicher wieder ca.6,7GiB. Vollständige aktuelle Abnahme noch offen. X01-Zyklen sind nicht allein wegen fehlender Signale fehlgeschlagen.

Checkpoint: `/workspace/backups/CTS-K-N/20260906T102515Z-continuation`; Bundle und sämtliche SHA256-Prüfungen bestanden.

- Zusätzliche Nutzerpriorität: DCA zuerst für ein Symbol (aktuell BCH), danach XRP/SOL über jeweils 14 vollständige Tage rechnen. Alle ausführbaren Stufen 1–4 und mehrere letzte SL-Abstände/Mulitplikatoren vergleichen. Geringen Drawdown vor höherem Gewinn priorisieren, positive Ergebnisse nach Kosten und Kostenstress getrennt ausweisen. Bereits betrachtete Daten nicht erneut als unabhängigen Holdout bezeichnen. Vollständige Ergebnisse mit Diagrammen als interaktives HTML liefern.
