#!/usr/bin/env tsx

// Stable operator entry point for the required fourteen-day Historic-DCA
// validation. The underlying optimizer remains backwards compatible with the
// earlier 7d artifact and accepts an explicit DCA_BACKTEST_DAYS override.
process.env.DCA_BACKTEST_DAYS ||= "14"
void import("./optimize-dca-7d").catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
