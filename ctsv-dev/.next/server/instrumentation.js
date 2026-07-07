"use strict";
/*
 * ATTENTION: An "eval-source-map" devtool has been used.
 * This devtool is neither made for production nor for readable output files.
 * It uses "eval()" calls to create a separate source file with attached SourceMaps in the browser devtools.
 * If you are trying to read the output file, select a different devtool (https://webpack.js.org/configuration/devtool/)
 * or disable the default devtool with "devtool: false".
 * If you are looking for production-ready output files, see mode: "production" (https://webpack.js.org/configuration/mode/).
 */
(() => {
var exports = {};
exports.id = "instrumentation";
exports.ids = ["instrumentation"];
exports.modules = {

/***/ "(instrument)/../ctsv/instrumentation.ts":
/*!**********************************!*\
  !*** ../ctsv/instrumentation.ts ***!
  \**********************************/
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

eval("__webpack_require__.r(__webpack_exports__);\n/* harmony export */ __webpack_require__.d(__webpack_exports__, {\n/* harmony export */   register: () => (/* binding */ register)\n/* harmony export */ });\n/**\n * Next.js instrumentation hook — the deterministic, once-per-process server\n * boot entry point. `register()` runs a single time when each server process\n * starts, BEFORE any request is handled.\n *\n * ── WHY THIS FILE IS CRITICAL (production stability) ─────────────────────────\n * This file had gone missing even though `next.config.mjs` and\n * `scripts/vercel-build-setup.sh` both reference it. Without it, production had\n * NO server-side boot path: the engine only initialized when a browser happened\n * to mount `EngineAutoInitializer` and POST `/api/system/initialize`. That route\n * seeds + auto-starts but does NOT run `completeStartup()`, so the orphaned-flag\n * cleanup (`cleanupOrphanedProgress`) and stranded-position reconcile\n * (`reconcileStrandedPositions`) NEVER ran on a production restart/deploy.\n * Result: zombie `engine_is_running` flags, stalled progress, stranded live\n * positions, and inconsistent counts carried over in the snapshot from the\n * previous process — exactly the \"race conditions, stallings, restarts,\n * failures of progress and counts\" reported in production. Dev was stable\n * because it is a single long-lived process with the browser always open and a\n * dev-only stale-state flush on every init.\n *\n * Restoring this hook gives production a deterministic, headless boot that does\n * not depend on a browser, and guarantees orphan cleanup + migrations run on\n * every process start. The documented boot path is:\n *   register() → completeStartup() [initRedis→runMigrations, validate,\n *   cleanupOrphanedProgress, reconcileStrandedPositions] →\n *   initializeTradeEngineAutoStart() → startServerContinuityRunner()\n */ // Guard against double-execution across HMR / module re-evaluation. The flag\n// lives on globalThis so it survives Next.js dev module reloads within one\n// process (register() is only meant to run once per real process start).\nconst bootGuard = globalThis;\nasync function register() {\n    // Only skip the Edge runtime. In `next start` / OpenNext production workers\n    // `NEXT_RUNTIME` can be undefined during instrumentation registration, while\n    // the runtime is still a normal Node-compatible server process. Requiring the\n    // value to be exactly \"nodejs\" skipped deterministic boot in production and\n    // reproduced the dev/prod divergence: migrations, orphan cleanup, and\n    // stranded-position reconciliation did not run until a later request path.\n    if (false) {}\n    if (bootGuard.__v0_instrumentation_booted) return;\n    bootGuard.__v0_instrumentation_booted = true;\n    console.log(\"[v0] [Instrumentation] register() — beginning deterministic server boot...\");\n    // Each step is wrapped so a single failure cannot abort the rest of the boot\n    // (or crash the server). The pre-startup sequence is the most important part\n    // — it runs migrations and cleans orphaned state from the previous process.\n    try {\n        const { completeStartup } = await Promise.all(/*! import() */[__webpack_require__.e(\"vendor-chunks/nanoid\"), __webpack_require__.e(\"_instrument_ctsv_lib_startup-coordinator_ts\")]).then(__webpack_require__.bind(__webpack_require__, /*! @/lib/startup-coordinator */ \"(instrument)/../ctsv/lib/startup-coordinator.ts\"));\n        await completeStartup();\n    } catch (err) {\n        console.error(\"[v0] [Instrumentation] completeStartup failed (continuing):\", err instanceof Error ? err.message : err);\n    }\n    // Production Node processes should be self-contained: initialize the\n    // auto-start/healing sweep and continuity runner by default so explicit UI\n    // actions and persisted running intent work without a separate worker env flag.\n    // Serverless/edge safety is handled inside the imported runners.\n    if (process.env.DISABLE_TRADE_ENGINE_AUTOSTART !== \"1\") {\n        try {\n            const { initializeTradeEngineAutoStart } = await __webpack_require__.e(/*! import() */ \"_instrument_ctsv_lib_trade-engine-auto-start_ts\").then(__webpack_require__.bind(__webpack_require__, /*! @/lib/trade-engine-auto-start */ \"(instrument)/../ctsv/lib/trade-engine-auto-start.ts\"));\n            await initializeTradeEngineAutoStart();\n        } catch (err) {\n            console.error(\"[v0] [Instrumentation] auto-start init failed (continuing):\", err instanceof Error ? err.message : err);\n        }\n    } else {\n        console.warn(\"[v0] [Instrumentation] trade-engine auto-start disabled by DISABLE_TRADE_ENGINE_AUTOSTART=1\");\n        console.warn(\"[v0] [Instrumentation] background trade-engine auto-start skipped; explicit UI actions and continuity sweeps can start/reconcile engines\");\n    }\n    if (process.env.DISABLE_IN_PROCESS_CONTINUITY !== \"1\") {\n        try {\n            const { startServerContinuityRunner } = await __webpack_require__.e(/*! import() */ \"_instrument_ctsv_lib_server-continuity-runner_ts\").then(__webpack_require__.bind(__webpack_require__, /*! @/lib/server-continuity-runner */ \"(instrument)/../ctsv/lib/server-continuity-runner.ts\"));\n            startServerContinuityRunner();\n        } catch (err) {\n            console.error(\"[v0] [Instrumentation] continuity runner failed (continuing):\", err instanceof Error ? err.message : err);\n        }\n    } else {\n        console.warn(\"[v0] [Instrumentation] in-process continuity disabled by DISABLE_IN_PROCESS_CONTINUITY=1\");\n        console.warn(\"[v0] [Instrumentation] background in-process continuity skipped; deployment cron or UI-triggered reconciliation remains available\");\n    }\n    console.log(\"[v0] [Instrumentation] ✓ Server boot complete\");\n}\n//# sourceURL=[module]\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiKGluc3RydW1lbnQpLy4uL2N0c3YvaW5zdHJ1bWVudGF0aW9uLnRzIiwibWFwcGluZ3MiOiI7Ozs7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0EwQkMsR0FFRCw2RUFBNkU7QUFDN0UsMkVBQTJFO0FBQzNFLHlFQUF5RTtBQUN6RSxNQUFNQSxZQUFZQztBQUVYLGVBQWVDO0lBQ3BCLDRFQUE0RTtJQUM1RSw2RUFBNkU7SUFDN0UsOEVBQThFO0lBQzlFLDRFQUE0RTtJQUM1RSxzRUFBc0U7SUFDdEUsMkVBQTJFO0lBQzNFLElBQUlDLEtBQW1DLEVBQUU7SUFFekMsSUFBSUgsVUFBVU0sMkJBQTJCLEVBQUU7SUFDM0NOLFVBQVVNLDJCQUEyQixHQUFHO0lBRXhDQyxRQUFRQyxHQUFHLENBQUM7SUFFWiw2RUFBNkU7SUFDN0UsNkVBQTZFO0lBQzdFLDRFQUE0RTtJQUM1RSxJQUFJO1FBQ0YsTUFBTSxFQUFFQyxlQUFlLEVBQUUsR0FBRyxNQUFNLHlSQUFtQztRQUNyRSxNQUFNQTtJQUNSLEVBQUUsT0FBT0MsS0FBSztRQUNaSCxRQUFRSSxLQUFLLENBQUMsK0RBQStERCxlQUFlRSxRQUFRRixJQUFJRyxPQUFPLEdBQUdIO0lBQ3BIO0lBRUEscUVBQXFFO0lBQ3JFLDJFQUEyRTtJQUMzRSxnRkFBZ0Y7SUFDaEYsaUVBQWlFO0lBQ2pFLElBQUlQLFFBQVFDLEdBQUcsQ0FBQ1UsOEJBQThCLEtBQUssS0FBSztRQUN0RCxJQUFJO1lBQ0YsTUFBTSxFQUFFQyw4QkFBOEIsRUFBRSxHQUFHLE1BQU0sd09BQXVDO1lBQ3hGLE1BQU1BO1FBQ1IsRUFBRSxPQUFPTCxLQUFLO1lBQ1pILFFBQVFJLEtBQUssQ0FBQywrREFBK0RELGVBQWVFLFFBQVFGLElBQUlHLE9BQU8sR0FBR0g7UUFDcEg7SUFDRixPQUFPO1FBQ0xILFFBQVFTLElBQUksQ0FBQztRQUNiVCxRQUFRUyxJQUFJLENBQUM7SUFDZjtJQUVBLElBQUliLFFBQVFDLEdBQUcsQ0FBQ2EsNkJBQTZCLEtBQUssS0FBSztRQUNyRCxJQUFJO1lBQ0YsTUFBTSxFQUFFQywyQkFBMkIsRUFBRSxHQUFHLE1BQU0sMk9BQXdDO1lBQ3RGQTtRQUNGLEVBQUUsT0FBT1IsS0FBSztZQUNaSCxRQUFRSSxLQUFLLENBQUMsaUVBQWlFRCxlQUFlRSxRQUFRRixJQUFJRyxPQUFPLEdBQUdIO1FBQ3RIO0lBQ0YsT0FBTztRQUNMSCxRQUFRUyxJQUFJLENBQUM7UUFDYlQsUUFBUVMsSUFBSSxDQUFDO0lBQ2Y7SUFFQVQsUUFBUUMsR0FBRyxDQUFDO0FBQ2QiLCJzb3VyY2VzIjpbIi93b3Jrc3BhY2UvNjk5NWZlZDctYmJlYS00MjczLTljYjAtMDRhNzBkNWRhZWI0L3Nlc3Npb25zL2FnZW50X2IxNWUzYzJhLWJkMTYtNDI5My04YmZkLWRhZjQ2NmViMDE1Ny9jdHN2L2luc3RydW1lbnRhdGlvbi50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE5leHQuanMgaW5zdHJ1bWVudGF0aW9uIGhvb2sg4oCUIHRoZSBkZXRlcm1pbmlzdGljLCBvbmNlLXBlci1wcm9jZXNzIHNlcnZlclxuICogYm9vdCBlbnRyeSBwb2ludC4gYHJlZ2lzdGVyKClgIHJ1bnMgYSBzaW5nbGUgdGltZSB3aGVuIGVhY2ggc2VydmVyIHByb2Nlc3NcbiAqIHN0YXJ0cywgQkVGT1JFIGFueSByZXF1ZXN0IGlzIGhhbmRsZWQuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIEZJTEUgSVMgQ1JJVElDQUwgKHByb2R1Y3Rpb24gc3RhYmlsaXR5KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqIFRoaXMgZmlsZSBoYWQgZ29uZSBtaXNzaW5nIGV2ZW4gdGhvdWdoIGBuZXh0LmNvbmZpZy5tanNgIGFuZFxuICogYHNjcmlwdHMvdmVyY2VsLWJ1aWxkLXNldHVwLnNoYCBib3RoIHJlZmVyZW5jZSBpdC4gV2l0aG91dCBpdCwgcHJvZHVjdGlvbiBoYWRcbiAqIE5PIHNlcnZlci1zaWRlIGJvb3QgcGF0aDogdGhlIGVuZ2luZSBvbmx5IGluaXRpYWxpemVkIHdoZW4gYSBicm93c2VyIGhhcHBlbmVkXG4gKiB0byBtb3VudCBgRW5naW5lQXV0b0luaXRpYWxpemVyYCBhbmQgUE9TVCBgL2FwaS9zeXN0ZW0vaW5pdGlhbGl6ZWAuIFRoYXQgcm91dGVcbiAqIHNlZWRzICsgYXV0by1zdGFydHMgYnV0IGRvZXMgTk9UIHJ1biBgY29tcGxldGVTdGFydHVwKClgLCBzbyB0aGUgb3JwaGFuZWQtZmxhZ1xuICogY2xlYW51cCAoYGNsZWFudXBPcnBoYW5lZFByb2dyZXNzYCkgYW5kIHN0cmFuZGVkLXBvc2l0aW9uIHJlY29uY2lsZVxuICogKGByZWNvbmNpbGVTdHJhbmRlZFBvc2l0aW9uc2ApIE5FVkVSIHJhbiBvbiBhIHByb2R1Y3Rpb24gcmVzdGFydC9kZXBsb3kuXG4gKiBSZXN1bHQ6IHpvbWJpZSBgZW5naW5lX2lzX3J1bm5pbmdgIGZsYWdzLCBzdGFsbGVkIHByb2dyZXNzLCBzdHJhbmRlZCBsaXZlXG4gKiBwb3NpdGlvbnMsIGFuZCBpbmNvbnNpc3RlbnQgY291bnRzIGNhcnJpZWQgb3ZlciBpbiB0aGUgc25hcHNob3QgZnJvbSB0aGVcbiAqIHByZXZpb3VzIHByb2Nlc3Mg4oCUIGV4YWN0bHkgdGhlIFwicmFjZSBjb25kaXRpb25zLCBzdGFsbGluZ3MsIHJlc3RhcnRzLFxuICogZmFpbHVyZXMgb2YgcHJvZ3Jlc3MgYW5kIGNvdW50c1wiIHJlcG9ydGVkIGluIHByb2R1Y3Rpb24uIERldiB3YXMgc3RhYmxlXG4gKiBiZWNhdXNlIGl0IGlzIGEgc2luZ2xlIGxvbmctbGl2ZWQgcHJvY2VzcyB3aXRoIHRoZSBicm93c2VyIGFsd2F5cyBvcGVuIGFuZCBhXG4gKiBkZXYtb25seSBzdGFsZS1zdGF0ZSBmbHVzaCBvbiBldmVyeSBpbml0LlxuICpcbiAqIFJlc3RvcmluZyB0aGlzIGhvb2sgZ2l2ZXMgcHJvZHVjdGlvbiBhIGRldGVybWluaXN0aWMsIGhlYWRsZXNzIGJvb3QgdGhhdCBkb2VzXG4gKiBub3QgZGVwZW5kIG9uIGEgYnJvd3NlciwgYW5kIGd1YXJhbnRlZXMgb3JwaGFuIGNsZWFudXAgKyBtaWdyYXRpb25zIHJ1biBvblxuICogZXZlcnkgcHJvY2VzcyBzdGFydC4gVGhlIGRvY3VtZW50ZWQgYm9vdCBwYXRoIGlzOlxuICogICByZWdpc3RlcigpIOKGkiBjb21wbGV0ZVN0YXJ0dXAoKSBbaW5pdFJlZGlz4oaScnVuTWlncmF0aW9ucywgdmFsaWRhdGUsXG4gKiAgIGNsZWFudXBPcnBoYW5lZFByb2dyZXNzLCByZWNvbmNpbGVTdHJhbmRlZFBvc2l0aW9uc10g4oaSXG4gKiAgIGluaXRpYWxpemVUcmFkZUVuZ2luZUF1dG9TdGFydCgpIOKGkiBzdGFydFNlcnZlckNvbnRpbnVpdHlSdW5uZXIoKVxuICovXG5cbi8vIEd1YXJkIGFnYWluc3QgZG91YmxlLWV4ZWN1dGlvbiBhY3Jvc3MgSE1SIC8gbW9kdWxlIHJlLWV2YWx1YXRpb24uIFRoZSBmbGFnXG4vLyBsaXZlcyBvbiBnbG9iYWxUaGlzIHNvIGl0IHN1cnZpdmVzIE5leHQuanMgZGV2IG1vZHVsZSByZWxvYWRzIHdpdGhpbiBvbmVcbi8vIHByb2Nlc3MgKHJlZ2lzdGVyKCkgaXMgb25seSBtZWFudCB0byBydW4gb25jZSBwZXIgcmVhbCBwcm9jZXNzIHN0YXJ0KS5cbmNvbnN0IGJvb3RHdWFyZCA9IGdsb2JhbFRoaXMgYXMgdW5rbm93biBhcyB7IF9fdjBfaW5zdHJ1bWVudGF0aW9uX2Jvb3RlZD86IGJvb2xlYW4gfVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVnaXN0ZXIoKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIE9ubHkgc2tpcCB0aGUgRWRnZSBydW50aW1lLiBJbiBgbmV4dCBzdGFydGAgLyBPcGVuTmV4dCBwcm9kdWN0aW9uIHdvcmtlcnNcbiAgLy8gYE5FWFRfUlVOVElNRWAgY2FuIGJlIHVuZGVmaW5lZCBkdXJpbmcgaW5zdHJ1bWVudGF0aW9uIHJlZ2lzdHJhdGlvbiwgd2hpbGVcbiAgLy8gdGhlIHJ1bnRpbWUgaXMgc3RpbGwgYSBub3JtYWwgTm9kZS1jb21wYXRpYmxlIHNlcnZlciBwcm9jZXNzLiBSZXF1aXJpbmcgdGhlXG4gIC8vIHZhbHVlIHRvIGJlIGV4YWN0bHkgXCJub2RlanNcIiBza2lwcGVkIGRldGVybWluaXN0aWMgYm9vdCBpbiBwcm9kdWN0aW9uIGFuZFxuICAvLyByZXByb2R1Y2VkIHRoZSBkZXYvcHJvZCBkaXZlcmdlbmNlOiBtaWdyYXRpb25zLCBvcnBoYW4gY2xlYW51cCwgYW5kXG4gIC8vIHN0cmFuZGVkLXBvc2l0aW9uIHJlY29uY2lsaWF0aW9uIGRpZCBub3QgcnVuIHVudGlsIGEgbGF0ZXIgcmVxdWVzdCBwYXRoLlxuICBpZiAocHJvY2Vzcy5lbnYuTkVYVF9SVU5USU1FID09PSBcImVkZ2VcIikgcmV0dXJuXG5cbiAgaWYgKGJvb3RHdWFyZC5fX3YwX2luc3RydW1lbnRhdGlvbl9ib290ZWQpIHJldHVyblxuICBib290R3VhcmQuX192MF9pbnN0cnVtZW50YXRpb25fYm9vdGVkID0gdHJ1ZVxuXG4gIGNvbnNvbGUubG9nKFwiW3YwXSBbSW5zdHJ1bWVudGF0aW9uXSByZWdpc3RlcigpIOKAlCBiZWdpbm5pbmcgZGV0ZXJtaW5pc3RpYyBzZXJ2ZXIgYm9vdC4uLlwiKVxuXG4gIC8vIEVhY2ggc3RlcCBpcyB3cmFwcGVkIHNvIGEgc2luZ2xlIGZhaWx1cmUgY2Fubm90IGFib3J0IHRoZSByZXN0IG9mIHRoZSBib290XG4gIC8vIChvciBjcmFzaCB0aGUgc2VydmVyKS4gVGhlIHByZS1zdGFydHVwIHNlcXVlbmNlIGlzIHRoZSBtb3N0IGltcG9ydGFudCBwYXJ0XG4gIC8vIOKAlCBpdCBydW5zIG1pZ3JhdGlvbnMgYW5kIGNsZWFucyBvcnBoYW5lZCBzdGF0ZSBmcm9tIHRoZSBwcmV2aW91cyBwcm9jZXNzLlxuICB0cnkge1xuICAgIGNvbnN0IHsgY29tcGxldGVTdGFydHVwIH0gPSBhd2FpdCBpbXBvcnQoXCJAL2xpYi9zdGFydHVwLWNvb3JkaW5hdG9yXCIpXG4gICAgYXdhaXQgY29tcGxldGVTdGFydHVwKClcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc29sZS5lcnJvcihcIlt2MF0gW0luc3RydW1lbnRhdGlvbl0gY29tcGxldGVTdGFydHVwIGZhaWxlZCAoY29udGludWluZyk6XCIsIGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBlcnIpXG4gIH1cblxuICAvLyBQcm9kdWN0aW9uIE5vZGUgcHJvY2Vzc2VzIHNob3VsZCBiZSBzZWxmLWNvbnRhaW5lZDogaW5pdGlhbGl6ZSB0aGVcbiAgLy8gYXV0by1zdGFydC9oZWFsaW5nIHN3ZWVwIGFuZCBjb250aW51aXR5IHJ1bm5lciBieSBkZWZhdWx0IHNvIGV4cGxpY2l0IFVJXG4gIC8vIGFjdGlvbnMgYW5kIHBlcnNpc3RlZCBydW5uaW5nIGludGVudCB3b3JrIHdpdGhvdXQgYSBzZXBhcmF0ZSB3b3JrZXIgZW52IGZsYWcuXG4gIC8vIFNlcnZlcmxlc3MvZWRnZSBzYWZldHkgaXMgaGFuZGxlZCBpbnNpZGUgdGhlIGltcG9ydGVkIHJ1bm5lcnMuXG4gIGlmIChwcm9jZXNzLmVudi5ESVNBQkxFX1RSQURFX0VOR0lORV9BVVRPU1RBUlQgIT09IFwiMVwiKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgaW5pdGlhbGl6ZVRyYWRlRW5naW5lQXV0b1N0YXJ0IH0gPSBhd2FpdCBpbXBvcnQoXCJAL2xpYi90cmFkZS1lbmdpbmUtYXV0by1zdGFydFwiKVxuICAgICAgYXdhaXQgaW5pdGlhbGl6ZVRyYWRlRW5naW5lQXV0b1N0YXJ0KClcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbdjBdIFtJbnN0cnVtZW50YXRpb25dIGF1dG8tc3RhcnQgaW5pdCBmYWlsZWQgKGNvbnRpbnVpbmcpOlwiLCBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogZXJyKVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLndhcm4oXCJbdjBdIFtJbnN0cnVtZW50YXRpb25dIHRyYWRlLWVuZ2luZSBhdXRvLXN0YXJ0IGRpc2FibGVkIGJ5IERJU0FCTEVfVFJBREVfRU5HSU5FX0FVVE9TVEFSVD0xXCIpXG4gICAgY29uc29sZS53YXJuKFwiW3YwXSBbSW5zdHJ1bWVudGF0aW9uXSBiYWNrZ3JvdW5kIHRyYWRlLWVuZ2luZSBhdXRvLXN0YXJ0IHNraXBwZWQ7IGV4cGxpY2l0IFVJIGFjdGlvbnMgYW5kIGNvbnRpbnVpdHkgc3dlZXBzIGNhbiBzdGFydC9yZWNvbmNpbGUgZW5naW5lc1wiKVxuICB9XG5cbiAgaWYgKHByb2Nlc3MuZW52LkRJU0FCTEVfSU5fUFJPQ0VTU19DT05USU5VSVRZICE9PSBcIjFcIikge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHN0YXJ0U2VydmVyQ29udGludWl0eVJ1bm5lciB9ID0gYXdhaXQgaW1wb3J0KFwiQC9saWIvc2VydmVyLWNvbnRpbnVpdHktcnVubmVyXCIpXG4gICAgICBzdGFydFNlcnZlckNvbnRpbnVpdHlSdW5uZXIoKVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc29sZS5lcnJvcihcIlt2MF0gW0luc3RydW1lbnRhdGlvbl0gY29udGludWl0eSBydW5uZXIgZmFpbGVkIChjb250aW51aW5nKTpcIiwgZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IGVycilcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS53YXJuKFwiW3YwXSBbSW5zdHJ1bWVudGF0aW9uXSBpbi1wcm9jZXNzIGNvbnRpbnVpdHkgZGlzYWJsZWQgYnkgRElTQUJMRV9JTl9QUk9DRVNTX0NPTlRJTlVJVFk9MVwiKVxuICAgIGNvbnNvbGUud2FybihcIlt2MF0gW0luc3RydW1lbnRhdGlvbl0gYmFja2dyb3VuZCBpbi1wcm9jZXNzIGNvbnRpbnVpdHkgc2tpcHBlZDsgZGVwbG95bWVudCBjcm9uIG9yIFVJLXRyaWdnZXJlZCByZWNvbmNpbGlhdGlvbiByZW1haW5zIGF2YWlsYWJsZVwiKVxuICB9XG5cbiAgY29uc29sZS5sb2coXCJbdjBdIFtJbnN0cnVtZW50YXRpb25dIOKckyBTZXJ2ZXIgYm9vdCBjb21wbGV0ZVwiKVxufVxuIl0sIm5hbWVzIjpbImJvb3RHdWFyZCIsImdsb2JhbFRoaXMiLCJyZWdpc3RlciIsInByb2Nlc3MiLCJlbnYiLCJORVhUX1JVTlRJTUUiLCJfX3YwX2luc3RydW1lbnRhdGlvbl9ib290ZWQiLCJjb25zb2xlIiwibG9nIiwiY29tcGxldGVTdGFydHVwIiwiZXJyIiwiZXJyb3IiLCJFcnJvciIsIm1lc3NhZ2UiLCJESVNBQkxFX1RSQURFX0VOR0lORV9BVVRPU1RBUlQiLCJpbml0aWFsaXplVHJhZGVFbmdpbmVBdXRvU3RhcnQiLCJ3YXJuIiwiRElTQUJMRV9JTl9QUk9DRVNTX0NPTlRJTlVJVFkiLCJzdGFydFNlcnZlckNvbnRpbnVpdHlSdW5uZXIiXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZVJvb3QiOiIifQ==\n//# sourceURL=webpack-internal:///(instrument)/../ctsv/instrumentation.ts\n");

/***/ }),

/***/ "../app-render/action-async-storage.external":
/*!*******************************************************************************!*\
  !*** external "next/dist/server/app-render/action-async-storage.external.js" ***!
  \*******************************************************************************/
/***/ ((module) => {

module.exports = require("next/dist/server/app-render/action-async-storage.external.js");

/***/ }),

/***/ "../app-render/after-task-async-storage.external":
/*!***********************************************************************************!*\
  !*** external "next/dist/server/app-render/after-task-async-storage.external.js" ***!
  \***********************************************************************************/
/***/ ((module) => {

module.exports = require("next/dist/server/app-render/after-task-async-storage.external.js");

/***/ }),

/***/ "../app-render/work-async-storage.external":
/*!*****************************************************************************!*\
  !*** external "next/dist/server/app-render/work-async-storage.external.js" ***!
  \*****************************************************************************/
/***/ ((module) => {

module.exports = require("next/dist/server/app-render/work-async-storage.external.js");

/***/ }),

/***/ "../app-render/work-unit-async-storage.external":
/*!**********************************************************************************!*\
  !*** external "next/dist/server/app-render/work-unit-async-storage.external.js" ***!
  \**********************************************************************************/
/***/ ((module) => {

module.exports = require("next/dist/server/app-render/work-unit-async-storage.external.js");

/***/ }),

/***/ "bingx-api":
/*!****************************!*\
  !*** external "bingx-api" ***!
  \****************************/
/***/ ((module) => {

module.exports = require("bingx-api");

/***/ }),

/***/ "crypto":
/*!*************************!*\
  !*** external "crypto" ***!
  \*************************/
/***/ ((module) => {

module.exports = require("crypto");

/***/ }),

/***/ "events":
/*!*************************!*\
  !*** external "events" ***!
  \*************************/
/***/ ((module) => {

module.exports = require("events");

/***/ }),

/***/ "fs":
/*!*********************!*\
  !*** external "fs" ***!
  \*********************/
/***/ ((module) => {

module.exports = require("fs");

/***/ }),

/***/ "fs/promises":
/*!******************************!*\
  !*** external "fs/promises" ***!
  \******************************/
/***/ ((module) => {

module.exports = require("fs/promises");

/***/ }),

/***/ "next/dist/compiled/next-server/app-page.runtime.dev.js":
/*!*************************************************************************!*\
  !*** external "next/dist/compiled/next-server/app-page.runtime.dev.js" ***!
  \*************************************************************************/
/***/ ((module) => {

module.exports = require("next/dist/compiled/next-server/app-page.runtime.dev.js");

/***/ }),

/***/ "node:crypto":
/*!******************************!*\
  !*** external "node:crypto" ***!
  \******************************/
/***/ ((module) => {

module.exports = require("node:crypto");

/***/ }),

/***/ "path":
/*!***********************!*\
  !*** external "path" ***!
  \***********************/
/***/ ((module) => {

module.exports = require("path");

/***/ }),

/***/ "redis":
/*!************************!*\
  !*** external "redis" ***!
  \************************/
/***/ ((module) => {

module.exports = require("redis");

/***/ })

};
;

// load runtime
var __webpack_require__ = require("./webpack-runtime.js");
__webpack_require__.C(exports);
var __webpack_exec__ = (moduleId) => (__webpack_require__(__webpack_require__.s = moduleId))
var __webpack_exports__ = (__webpack_exec__("(instrument)/../ctsv/instrumentation.ts"));
module.exports = __webpack_exports__;

})();