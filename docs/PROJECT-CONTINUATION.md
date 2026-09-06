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


## Verifizierte Fortsetzung 2026-09-06, PR320

- PR320 integriert ältere Arbeiten, PR315 und main/PR319 (`b3d4e9f5`). Canonical und parallele Worktrees bleiben erhalten; kein Reset fremder Änderungen.
- Historie: 2026-08-23T00:00Z bis 2026-09-06T00:00Z exklusiv, BCH zuerst, danach XRP/SOL, neun lückenfreie Reihen. Rohdaten-SHA256 `eb9fb582b1936fdceae2ac221c43a7361119a853a1d495e31de531e068b10916`.
- DCA: 217.728 Erstläufe + 1.037.610 deduplizierte SL/Stufen-Läufe = 1.255.338 Konfigurationen. 179 strenge Kandidaten vollständig unter doppelten Kosten geprüft; BCH 108/0, XRP 5/0, SOL 66/4 (Kandidaten/Stress bestanden). Priorität niedriger maximaler Drawdown, danach Exposition und Nettoergebnis. Wiederverwendetes Fenster ist retrospektiv, kein unabhängiger neuer Holdout. Kein universeller Default qualifiziert oder live übernommen.
- Direct-Trade: 90.048 vollständige Konfigurationen, 151 gültige, sieben Strategietypen. Matrixvalidität allein qualifiziert keinen Livebetrieb.
- Persistierte Ergebnisse: `CTS-v3.7-Diagramme-und-Kandidaten.html`, `CTS-v3.7-14-Tage-Ergebnisse.html` und `CTS-v3.7-14-Tage-Rohdaten.zip`. Vollständiges HTML enthält alle DCA-Konfigurationen und Direct-Trade-Blockauswertungen, Diagramme, Filter, Details und CSV. Alle 22 Archivdateien per SHA256 geprüft. Bericht zeigt Strategie-Notionalpunkte, keine Kontorendite; Funding nicht enthalten.
- Neue Redis-Korrektur: Staging-Chunks EX1800, Verlängerung nur beim Lease-Inhaber, Veröffentlichung prüft atomar Eigentümer und Vollständigkeit, persistiert aktuelle Chunks und setzt alte auf EX300 für laufende Leser. Fehler/Abbruch und verlorene Veröffentlichung-Antwort schützen die aktuelle Generation. Kompaktierung verwendet ebenfalls vollständigen atomaren Manifestwechsel. Fortschrittsanzeigen sind Lease-geschützt.
- `scripts/cleanup-direct-trade-orphans.ts --connection-id ID` ist standardmäßig lesend, begrenzte SCAN-Seiten mit fortsetzbarem Cursor. `--apply` entfernt nur persistente, eindeutig alte, nicht aktuelle Chunks bei fehlender Berechnungs-Lease; Lease/Manifest/TTL werden atomar erneut geprüft. Andere Connections und Orders sind nicht im Schlüsselbereich. Erst nach Backup und Installation der Korrektur gegen Produktionsdaten anwenden.
- Portable Installer-Tests verwenden den tatsächlich ausführenden Testbenutzer, eindeutige Instanznamen und isolierte temporäre State-/Backup-Pfade; Fake-SSH/Sudo/Systemctl bleiben reine Fixture-Befehle ohne Hostrechte.
- Vollständige Regression lokal und in separater Serverkopie: 290 Suiten / 2.002 Tests bestanden, Exit0; externe HTTP-Origin- und Proxy-Verbindungen gesperrt. Native isolierte Redis-Verifikation auf dem Server: 14/14 Sicherheits- und Lebenszyklusfälle bestanden, inklusive Lease-Rennen und verlorener Commit-Antwort. Produktionsdienste und Exchange-Zugangsdaten wurden dafür nicht benutzt.
- Verifiziertes Remote-Rollback vor PR320: `/var/backups/cts-kn/20260906T113109Z-pre-pr320-reinstall`, Quellbundle, Laufzeitarchiv, private Konfiguration, fork-frei validierte native AOF-Kette und SHA256-Prüfungen. Remote aktuell PR319, Reinstall von PR320 erst nach grünem Merge.
- Offen bleiben tatsächliche Abnahme nach Reinstall, Langzeitbegrenzung des Redis-Wachstums, geladener Overview-/Stage-Dialog und ein strenger koordinierter X02-Prod-VST-Order-Soak. Frühere fremde Baseline-Änderung bleibt ein fehlgeschlagener Soak. Keine vollständige Produktionsreife oder mehrere hundert erfolgreich abgeglichene Exchange-Orders behaupten.
