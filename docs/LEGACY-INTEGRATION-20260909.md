# Integration älterer Arbeit – 2026-09-09

Verglichen: unveröffentlichter kanonischer Stand `2041787ba7530f0b7c7487890c815086b80ce770` in `/workspace/CTS-K-N` gegen aktuelles GitHub-main `1aaba49f6e3dc61345f02d36ebc71c9167787a4b`. Originale liegen weiter im kanonischen Checkout und im verifizierten Checkpoint `20260908T230518Z-pre-latest-recovery`. Keine Bereinigung/Reset des älteren Checkouts.

34 Dateien einzeln geprüft: 17 bereits enthalten, 17 durch neuere Änderungen überarbeitet. Nach Auflösung zugunsten der nachfolgend bezeichneten neueren Verträge blieb kein zusätzlicher älterer Diff-Hunk offen. PR315 wurde nicht blind gemergt. Arbeitsstand dieser Fortsetzung: `/workspace/CTS-K-N-worktrees/vst25-live-results-20260908`.

| Datei | Entscheidung | Begründung |
| --- | --- | --- |
| `__tests__/unit/direct-trade-route-concurrency.test.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `__tests__/unit/production-start-shutdown.test.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `__tests__/unit/quickstart-timeouts.test.ts` | Durch neuere Implementierung überarbeitet | Neuere PROD_UI_SYMBOLS_JSON-Verträge schließen manuelle Symbol-Baskets ein. |
| `app/api/exchange/[exchange]/top-symbols/route.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `app/api/settings/connections/[id]/settings/route.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `app/api/settings/connections/[id]/symbols/route.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `app/api/settings/route.ts` | Durch neuere Implementierung überarbeitet | Neuere additive Block-Counts 1–6 bleiben erhalten; alte Obergrenze 12 ist überarbeitet. |
| `app/api/trade-engine/direct-trade/calculate/route.ts` | Durch neuere Implementierung überarbeitet | Neuere Retention für Berechnungsgenerationen und deren Import bleibt erhalten. |
| `app/api/trade-engine/direct-trade/route.ts` | Durch neuere Implementierung überarbeitet | Neuere additive Block-Stufen 1–2 / Counts 1–6, effektive Inkremente und Lifecycle-Zuordnung bleiben erhalten; keine Rückkehr zum alten multiplikativen Vertrag. |
| `components/dashboard/direct-trade-section.tsx` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `components/dashboard/quickstart-section.tsx` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `components/settings/connection-settings-dialog.tsx` | Durch neuere Implementierung überarbeitet | Neuer MarginCallPanel und aktuelle Schutz-Einstellungen ersetzen die ältere Ansicht. |
| `components/settings/direct-trade-settings.tsx` | Durch neuere Implementierung überarbeitet | Neuere additive Block-Stufen 1–2 / Counts 1–6, effektive Inkremente und Lifecycle-Zuordnung bleiben erhalten; keine Rückkehr zum alten multiplikativen Vertrag. |
| `components/settings/strategy-coordination-section.tsx` | Durch neuere Implementierung überarbeitet | Neuere additive Block-Stufen 1–2 / Counts 1–6, effektive Inkremente und Lifecycle-Zuordnung bleiben erhalten; keine Rückkehr zum alten multiplikativen Vertrag. |
| `components/settings/tabs/strategy-tab.tsx` | Durch neuere Implementierung überarbeitet | Neuere additive Block-Stufen 1–2 / Counts 1–6, effektive Inkremente und Lifecycle-Zuordnung bleiben erhalten; keine Rückkehr zum alten multiplikativen Vertrag. |
| `lib/direct-trade-canonical-order.ts` | Durch neuere Implementierung überarbeitet | Neuere additive Block-Stufen 1–2 / Counts 1–6, effektive Inkremente und Lifecycle-Zuordnung bleiben erhalten; keine Rückkehr zum alten multiplikativen Vertrag. |
| `lib/direct-trade-limits.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `lib/quickstart-timeouts.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `lib/strategy-coordinator.ts` | Durch neuere Implementierung überarbeitet | Neuere additive Block-Stufen 1–2 / Counts 1–6, effektive Inkremente und Lifecycle-Zuordnung bleiben erhalten; keine Rückkehr zum alten multiplikativen Vertrag. |
| `lib/top-symbols.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `lib/trade-engine/engine-manager.ts` | Durch neuere Implementierung überarbeitet | Neuere kanonische Symbolrotation mit gemessener eindeutiger Abdeckung bleibt erhalten. |
| `lib/trade-engine/stages/live-stage.ts` | Durch neuere Implementierung überarbeitet | Neuere additive Block-Stufen 1–2 / Counts 1–6, effektive Inkremente und Lifecycle-Zuordnung bleiben erhalten; keine Rückkehr zum alten multiplikativen Vertrag. |
| `lib/trade-engine/stages/real-stage.ts` | Durch neuere Implementierung überarbeitet | Neuere additive Block-Stufen 1–2 / Counts 1–6, effektive Inkremente und Lifecycle-Zuordnung bleiben erhalten; keine Rückkehr zum alten multiplikativen Vertrag. |
| `lib/trade-engine/state-machine.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `package.json` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `scripts/run-dev-preview-check.mjs` | Durch neuere Implementierung überarbeitet | Aktueller Basket-Vertrag mit verpflichtenden BTC/SOL/BCH/XRP und expliziter Symbol-Liste. |
| `scripts/run-prod-preview-check.mjs` | Durch neuere Implementierung überarbeitet | Aktueller Basket-Vertrag mit verpflichtenden BTC/SOL/BCH/XRP und expliziter Symbol-Liste. |
| `scripts/run-production-inline-ui-audit.mjs` | Durch neuere Implementierung überarbeitet | Isolierte CI-Verifikation ist ausdrücklich simuliert; Remote-Abnahme behält Live-Schutz. |
| `scripts/stress-bingx-public-32.mjs` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `scripts/verify-prod-soak.mjs` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `scripts/verify-prod-ui-max.mjs` | Durch neuere Implementierung überarbeitet | Isolierte CI-Verifikation ist ausdrücklich simuliert; Remote-Abnahme behält Live-Schutz. |
| `__tests__/unit/symbol-capacity.test.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `__tests__/unit/top-symbols-high-scale.test.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
| `lib/symbol-capacity.ts` | Bereits enthalten | Dreiwegevergleich: keine ältere Änderung außerhalb der neueren Implementierung. |
