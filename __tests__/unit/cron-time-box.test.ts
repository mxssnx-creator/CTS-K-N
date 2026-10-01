import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { NextResponse } from "next/server"
import { CRON_RUN_STALE_MS, cronRunStatus, cronTimeBudgetMs, resetCronRunState, runCronTimeBoxed } from "@/lib/cron-time-box"

const req = (query = "") => new Request(`http://localhost/api/cron/x${query}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ok = (extra: Record<string, unknown> = {}) => NextResponse.json({ success: true, ...extra })

beforeEach(() => resetCronRunState())

describe("a cron route answers within its budget and runs its work once", () => {
  test("work that finishes inside the budget answers exactly as before", async () => {
    const res = await runCronTimeBoxed("a", req(), async () => ok({ value: 7 }), { budgetMs: 200 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, value: 7 })
  })

  test("slow work answers pending at once, and the work still finishes", async () => {
    let finished = false
    const work = async () => { await sleep(300); finished = true; return ok() }
    const started = Date.now()
    const res = await runCronTimeBoxed("slow", req(), work, { budgetMs: 100 })
    expect(Date.now() - started).toBeLessThan(250)
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ success: true, pending: true, alreadyRunning: false, name: "slow" })
    expect(finished).toBe(false)
    await sleep(400)
    expect(finished).toBe(true)
    expect(cronRunStatus().slow.lastRun).toMatchObject({ ok: true, status: 200 })
    expect(cronRunStatus().slow.runningForMs).toBeNull()
  })

  test("one run at a time: the next ticks do not start a second run", async () => {
    let starts = 0
    const work = async () => { starts++; await sleep(300); return ok() }
    await runCronTimeBoxed("single", req(), work, { budgetMs: 50 })
    const second = await runCronTimeBoxed("single", req(), work, { budgetMs: 50 })
    const third = await runCronTimeBoxed("single", req(), work, { budgetMs: 50 })
    expect(starts).toBe(1)
    expect(await second.json()).toMatchObject({ pending: true, alreadyRunning: true })
    expect(third.status).toBe(202)
    await sleep(350)
    await runCronTimeBoxed("single", req(), work, { budgetMs: 50 })
    expect(starts).toBe(2) // finished, so a new run may start
  })

  test("a background failure is not lost: the following answer says success:false", async () => {
    const work = async () => { await sleep(80); return NextResponse.json({ success: false, error: "boom" }, { status: 200 }) }
    await runCronTimeBoxed("fail", req(), work, { budgetMs: 20 })
    await sleep(150)
    const next = await runCronTimeBoxed("fail", req(), async () => { await sleep(300); return ok() }, { budgetMs: 20 })
    const body = await next.json()
    expect(body.pending).toBe(true)
    expect(body.success).toBe(false)
    expect(body.lastRun).toMatchObject({ ok: false })
  })

  test("a thrown error inside the budget propagates; one after the budget is recorded, never unhandled", async () => {
    await expect(runCronTimeBoxed("throw-fast", req(), async () => { throw new Error("fast") }, { budgetMs: 100 })).rejects.toThrow("fast")
    await runCronTimeBoxed("throw-late", req(), async () => { await sleep(60); throw new Error("late") }, { budgetMs: 10 })
    await sleep(120)
    expect(cronRunStatus()["throw-late"].lastRun).toMatchObject({ ok: false, status: 500, error: "late" })
  })

  test("?wait=1 waits for the whole run (the installer's --once check)", async () => {
    const work = async () => { await sleep(250); return ok({ finished: true }) }
    const res = await runCronTimeBoxed("wait", req("?wait=1"), work, { budgetMs: 20 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, finished: true })
  })

  test("a MAINTENANCE route waits at most maxWaitMs in wait mode and then answers pending, so a long accounting run cannot fail a deploy check", async () => {
    let finished = false
    const work = async () => { await sleep(400); finished = true; return ok({ finished: true }) }
    const started = Date.now()
    const res = await runCronTimeBoxed("maint", req("?wait=1"), work, { budgetMs: 20, maxWaitMs: 80 })
    expect(Date.now() - started).toBeLessThan(300)
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ success: true, pending: true, name: "maint" })
    expect(finished).toBe(false)
    await sleep(450)
    expect(finished).toBe(true) // the run was not cancelled
  })
  test("maxWaitMs does not shorten a run that finishes in time, and a CONTINUITY route (no maxWaitMs) still waits for everything", async () => {
    const quick = await runCronTimeBoxed("maint-quick", req("?wait=1"), async () => { await sleep(30); return ok({ finished: true }) }, { budgetMs: 10, maxWaitMs: 500 })
    expect(quick.status).toBe(200); expect(await quick.json()).toEqual({ success: true, finished: true })
    const slow = await runCronTimeBoxed("continuity", req("?wait=1"), async () => { await sleep(200); return ok({ finished: true }) }, { budgetMs: 10 })
    expect(slow.status).toBe(200); expect(await slow.json()).toEqual({ success: true, finished: true })
  })
  test("only the four maintenance routes are bounded; the continuity routes the installer relies on are not", () => {
    const read = (n: string) => readFileSync(resolve(process.cwd(), `app/api/cron/${n}/route.ts`), "utf8")
    for (const name of ["close-accounting", "historic-test", "signal-source-optimization", "bots"]) expect(read(name)).toContain("{ maxWaitMs: MAINTENANCE_MAX_WAIT_MS }")
    for (const name of ["server-continuity", "sync-live-positions", "direct-trade-continuity"]) expect(read(name)).not.toContain("maxWaitMs")
  })
  test("a run presumed hung does not block the route forever", async () => {
    let starts = 0
    const hung = () => { starts++; return new Promise<Response>(() => undefined) }
    await runCronTimeBoxed("hung", req(), hung, { budgetMs: 10 })
    const realNow = Date.now
    try {
      Date.now = () => realNow() + CRON_RUN_STALE_MS + 1_000
      await runCronTimeBoxed("hung", req(), hung, { budgetMs: 10 })
    } finally { Date.now = realNow }
    expect(starts).toBe(2)
  })

  test("the tick is as long as the budget, not as the slowest route: seven routes of 3 s each", async () => {
    const started = Date.now()
    const answers = await Promise.all(Array.from({ length: 7 }, (_, i) => runCronTimeBoxed(`tick-${i}`, req(), async () => { await sleep(3_000); return ok() }, { budgetMs: 100 })))
    expect(Date.now() - started).toBeLessThan(400)
    expect(answers.every((a) => a.status === 202)).toBe(true)
  })

  test("the budget can be set and is kept between 100 ms and 5 s", () => {
    expect(cronTimeBudgetMs({})).toBe(600)
    expect(cronTimeBudgetMs({ CTS_CRON_TIME_BUDGET_MS: "250" })).toBe(250)
    expect(cronTimeBudgetMs({ CTS_CRON_TIME_BUDGET_MS: "5" })).toBe(100)
    expect(cronTimeBudgetMs({ CTS_CRON_TIME_BUDGET_MS: "99999" })).toBe(5000)
    expect(cronTimeBudgetMs({ CTS_CRON_TIME_BUDGET_MS: "abc" })).toBe(600)
  })
})

describe("wiring", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")
  test.each(["server-continuity", "sync-live-positions", "direct-trade-continuity", "historic-test", "bots", "close-accounting", "signal-source-optimization"])(
    "the %s route answers through the time box", (name) => {
      const route = read(`app/api/cron/${name}/route.ts`)
      expect(route).toMatch(/import \{ (MAINTENANCE_MAX_WAIT_MS, )?runCronTimeBoxed \} from "@\/lib\/cron-time-box"/)
      expect(route).toMatch(new RegExp(`return runCronTimeBoxed\\("${name}", request, \\(\\) => handle\\(request\\)(, \\{ maxWaitMs: MAINTENANCE_MAX_WAIT_MS \\})?\\)`))
      // sync-live-positions never had a POST; the others answer both methods the same way.
      if (name !== "sync-live-positions") expect(route).toMatch(/export const POST = GET|export async function POST/)
    })
  test("dashboard-pulse, which reads the results, waits for them", () => {
    const pulse = read("app/api/runtime/dashboard-pulse/route.ts")
    expect(pulse).toContain('"/api/cron/server-continuity?wait=1"')
    expect(pulse).toContain('"/api/cron/sync-live-positions?wait=1"')
  })
  test("the deployment verifier waits for the finished tick: a 202 pending would fail the deploy (2026-09-29 13:07)", () => {
    const verify = read("scripts/post-deploy-verify.sh")
    expect(verify).toContain('http_status "${endpoint}?wait=1" "$CRON_TIMEOUT_SECONDS" --header "Authorization: Bearer ${cron_secret}"')
    // the unauthenticated probe (expects 401) stays as it was
    expect(verify).toContain('unauthenticated_status="$(http_status "$endpoint" "$READ_TIMEOUT_SECONDS")"')
    expect(read("scripts/run-prod-preview-check.mjs")).toContain('"/api/cron/sync-live-positions?wait=1"')
  })
  test("the scheduler asks for completion only in the installer's --once mode", () => {
    const script = resolve(process.cwd(), "scripts/run-minute-scheduler.mjs")
    const code = `import * as m from ${JSON.stringify("file://" + script)}
      const seen = []; const fetchImpl = async (url) => { seen.push(String(url)); return new Response("{}", { status: 200 }) }
      await m.runSchedulerTick({ baseUrl: "http://127.0.0.1:3002", fetchImpl })
      const normal = seen.splice(0)
      await m.runSchedulerTick({ baseUrl: "http://127.0.0.1:3002", fetchImpl, waitForCompletion: true })
      console.log(JSON.stringify({ normal, once: seen }))`
    const out = JSON.parse(execFileSync("node", ["--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, NODE_ENV: "test" } }).trim().split("\n").pop() as string)
    expect(out.normal.length).toBe(7); expect(out.normal.some((u: string) => u.includes("wait=1"))).toBe(false)
    expect(out.once.length).toBe(7); expect(out.once.every((u: string) => u.includes("wait=1"))).toBe(true)
    expect(read("scripts/run-minute-scheduler.mjs")).toContain("runSchedulerTick({ ...config, signal: lifecycle.signal, waitForCompletion: true })")
  })
})
