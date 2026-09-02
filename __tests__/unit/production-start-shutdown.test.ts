import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = process.cwd()

describe("production launcher shutdown", () => {
  test("force-reaps a standalone child that ignores SIGTERM before systemd times out", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cts-production-shutdown-"))
    const standaloneDir = join(fixtureRoot, ".next", "standalone")
    mkdirSync(standaloneDir, { recursive: true })
    writeFileSync(
      join(standaloneDir, "server.js"),
      [
        'process.on("SIGTERM", () => {})',
        'process.on("SIGINT", () => {})',
        'console.log("fixture-child-ready")',
        "setInterval(() => undefined, 1_000)",
      ].join("\n"),
    )

    const launcher = resolve(root, "scripts", "start-production.mjs")
    let processUnderTest: ChildProcessWithoutNullStreams | null = null
    let output = ""
    try {
      processUnderTest = spawn(process.execPath, [launcher], {
        cwd: fixtureRoot,
        detached: true,
        env: {
          ...process.env,
          CTS_NODE_BIN: process.execPath,
          CTS_SHUTDOWN_GRACE_MS: "1000",
        },
        stdio: "pipe",
      })
      processUnderTest.stdout.on("data", (chunk) => { output += String(chunk) })
      processUnderTest.stderr.on("data", (chunk) => { output += String(chunk) })

      await waitFor(() => output.includes("fixture-child-ready"), 5_000)
      const shutdownStartedAt = Date.now()
      process.kill(-processUnderTest.pid!, "SIGTERM")
      const result = await waitForExit(processUnderTest, 5_000)

      expect(result.code).toBe(0)
      expect(Date.now() - shutdownStartedAt).toBeGreaterThanOrEqual(900)
      expect(Date.now() - shutdownStartedAt).toBeLessThan(4_500)
      expect(output).toContain("forcing termination")
      expect(output).toContain("runtime exited code=none signal=SIGKILL")
    } finally {
      if (processUnderTest?.pid && processUnderTest.exitCode === null) {
        try { process.kill(-processUnderTest.pid, "SIGKILL") } catch { /* already gone */ }
      }
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }, 10_000)

  test("the read-only production soak accepts an exact operator basket", () => {
    const source = readFileSync(
      resolve(root, "scripts", "verify-prod-soak.mjs"),
      "utf8",
    )
    expect(source).toContain("process.env.SOAK_SYMBOLS")
    expect(source).toContain("new Set(configuredSoakSymbols).size")
    expect(source).toContain("SOAK_SYMBOLS must contain 1-${EXCHANGE_SYMBOL_COUNT_MAX} unique normalized symbols")
    expect(source).toContain("? configuredSoakSymbols")
  })
})

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  throw new Error("Timed out waiting for production launcher fixture")
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("Timed out waiting for launcher exit")), timeoutMs)
    child.once("exit", (code, signal) => {
      clearTimeout(timeout)
      resolvePromise({ code, signal })
    })
  })
}
