import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const scheduler = resolve(process.cwd(), "scripts/run-minute-scheduler.mjs")
// The script is plain ESM run by node in production; load it the same way.
function run(body: string): any {
  const out = execFileSync("node", ["--input-type=module", "-e",
    `import * as m from ${JSON.stringify("file://" + scheduler)}; const r = await (async () => { ${body} })(); console.log(JSON.stringify(r))`],
    { encoding: "utf8", env: { ...process.env, SCHEDULER_BASE_URL: "http://127.0.0.1:3002", NODE_ENV: "test" } })
  return JSON.parse(out.trim().split("\n").pop() as string)
}

describe("the installer's final scheduler tick tolerates a start-up transient", () => {
  test("a tick that fails once and then passes succeeds on the second attempt", () => {
    const r = run(`let n = 0; const s = await m.runTickWithRetry({ tick: async () => ({ ok: ++n > 1 }), retries: 3, delayMs: 0, sleep: async () => {} }); return { ok: s.ok, attempts: n }`)
    expect(r).toEqual({ ok: true, attempts: 2 })
  })
  test("a tick that never passes fails after exactly retries + 1 attempts", () => {
    const r = run(`let n = 0; const s = await m.runTickWithRetry({ tick: async () => ({ ok: (n++, false) }), retries: 3, delayMs: 0, sleep: async () => {} }); return { ok: s.ok, attempts: n }`)
    expect(r).toEqual({ ok: false, attempts: 4 })
  })
  test("without retries behaviour is unchanged: one attempt, no waiting", () => {
    const r = run(`let n = 0, slept = 0; const s = await m.runTickWithRetry({ tick: async () => ({ ok: (n++, false) }), retries: 0, delayMs: 5000, sleep: async () => { slept++ } }); return { ok: s.ok, attempts: n, slept }`)
    expect(r).toEqual({ ok: false, attempts: 1, slept: 0 })
  })
  test("the retry count is bounded and defaults to zero", () => {
    const r = run(`return { def: m.resolveSchedulerConfig({ SCHEDULER_BASE_URL: "http://127.0.0.1:3002" }, []).onceRetries, big: m.resolveSchedulerConfig({ SCHEDULER_BASE_URL: "http://127.0.0.1:3002", SCHEDULER_ONCE_RETRIES: "99" }, []).onceRetries }`)
    expect(r).toEqual({ def: 0, big: 5 })
  })
  test("the installer enables the retry for both of its final ticks", () => {
    const sh = readFileSync(resolve(process.cwd(), "scripts/install.sh"), "utf8")
    expect((sh.match(/SCHEDULER_ONCE_RETRIES=3/g) || []).length).toBe(2)
  })
})
