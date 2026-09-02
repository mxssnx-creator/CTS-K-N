import test from "node:test";
import assert from "node:assert/strict";

import {
  clamp,
  normalizePath,
  parseCpuStat,
  parseMeminfo,
  percentile,
  progressionSummary,
} from "./access-dashboard.mjs";

test("normalizes the nginx dashboard prefix", () => {
  assert.equal(normalizePath("/__server/api/metrics"), "/api/metrics");
  assert.equal(normalizePath("/__server"), "/");
  assert.equal(normalizePath("/api/metrics"), "/api/metrics");
});

test("parses Linux memory counters as exact bytes", () => {
  const memory = parseMeminfo(
    "MemTotal:       1024 kB\nMemAvailable:    512 kB\nSwapTotal:       18 kB\n",
  );
  assert.equal(memory.MemTotal, 1024 * 1024);
  assert.equal(memory.MemAvailable, 512 * 1024);
  assert.equal(memory.SwapTotal, 18 * 1024);
});

test("parses aggregate and per-core CPU counters", () => {
  const cpu = parseCpuStat(
    "cpu  100 10 20 70 5 0 0 0 0 0\n" +
    "cpu0 50 5 10 35 2 0 0 0 0 0\n" +
    "cpu1 50 5 10 35 3 0 0 0 0 0\n",
  );
  assert.deepEqual(cpu.aggregate.slice(0, 5), [100, 10, 20, 70, 5]);
  assert.deepEqual(cpu.cores.map((core) => core.index), [0, 1]);
});

test("keeps percentile, bounds and progression summaries deterministic", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(clamp(-4, 0, 100), 0);
  assert.equal(clamp(140, 0, 100), 100);
  const summary = progressionSummary({
    historic: { progressPercent: 124, symbolsProcessed: 90, symbolsTotal: 80, isComplete: false },
    progression: { phase: "replay", cycles: 12 },
  });
  assert.equal(summary.percent, 100);
  assert.equal(summary.processed, 90);
  assert.equal(summary.total, 80);
  assert.equal(summary.phase, "replay");
  assert.equal(summary.cycles, 12);
});
