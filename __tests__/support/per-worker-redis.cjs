/**
 * Give every Jest worker its own Redis logical database when the suite runs
 * against a real Redis (REDIS_URL / KV_URL). Workers then never see each
 * other's keys, so suites can run in parallel instead of --runInBand. Without
 * a URL the in-memory adapter is already per process. An explicit database in
 * the URL (redis://host:port/N) is respected. Redis provides databases 0-15 by
 * default; worker N uses database N (1-15), so keep --maxWorkers <= 15.
 */
const workerId = Number(process.env.JEST_WORKER_ID || "1")
for (const name of ["REDIS_URL", "KV_URL"]) {
  const raw = process.env[name]
  if (!raw || !/^rediss?:\/\//.test(raw)) continue
  try {
    const url = new URL(raw)
    if (url.pathname && url.pathname !== "/") continue
    url.pathname = `/${Math.min(15, Math.max(1, workerId))}`
    process.env[name] = url.toString()
  } catch {
    // leave an unparsable URL to the client's own error
  }
}
