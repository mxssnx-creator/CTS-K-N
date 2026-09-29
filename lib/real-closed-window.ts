/**
 * Reads the closed-position list far enough to find the REAL positions the
 * statistics are supposed to rest on.
 *
 * Kept out of the route file: Next.js only allows HTTP handlers and route
 * config as exports of a route module, and an extra export fails the build.
 */
export const CLOSED_ANALYTICS_LIMIT = 75

// The contract is "the latest 50 REAL positions", but the closed list also holds
// rows that never traded (protection rollbacks, blocked or unfilled entries).
// The route used to read the first 75 entries of that list and filter AFTER, so
// on X01, where the newest rows were rollbacks, the "last 50" window held 10
// positions (66.7 % wins, PF 0.89 against 35.6 % and PF 0.46 over the 59
// settled positions of the same day). The list is now read in growing steps
// until 75 real positions are in hand or the list is exhausted.
export const CLOSED_SCAN_STEPS: readonly number[] = [CLOSED_ANALYTICS_LIMIT, 300, 800, 2000]

export async function readRealClosedWindow(
  read: (limit: number) => Promise<any[]>,
  isReal: (row: any) => boolean,
  needed: number = CLOSED_ANALYTICS_LIMIT,
  steps: readonly number[] = CLOSED_SCAN_STEPS,
): Promise<{ rows: any[]; scanned: number; real: number }> {
  let rows: any[] = []
  for (const limit of steps) {
    rows = (await read(limit)) || []
    const real = rows.filter(isReal).length
    if (real >= needed || rows.length < limit) return { rows, scanned: rows.length, real }
  }
  return { rows, scanned: rows.length, real: rows.filter(isReal).length }
}

