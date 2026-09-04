import { execFileSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

describe("bounded runtime log contract", () => {
  it("keeps only the newest 1000 lines without touching state or symlink targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cts-log-retention-"))
    const script = path.join(process.cwd(), "scripts", "limit-runtime-logs.sh")
    const xrdpLog = path.join(root, "var", "log", "xrdp.log")
    const runtimeLog = path.join(root, "var", "lib", "cts", "instances", "cts-kn", "logs", "app.log")
    const stateLog = path.join(root, "var", "lib", "cts", "instances", "cts-kn", "data", "trades.log")
    const symlinkLog = path.join(root, "var", "lib", "cts", "instances", "cts-kn", "logs", "state-link.log")
    const hugeLog = path.join(root, "var", "log", "huge.log")
    const originalState = "authoritative-trading-state\n"

    try {
      await mkdir(path.dirname(xrdpLog), { recursive: true })
      await mkdir(path.dirname(runtimeLog), { recursive: true })
      await mkdir(path.dirname(stateLog), { recursive: true })
      const lines = Array.from({ length: 1500 }, (_, index) => `line-${String(index + 1).padStart(4, "0")}`)
      await writeFile(xrdpLog, `${lines.join("\n")}\n`)
      await writeFile(runtimeLog, `${lines.join("\n")}\n`)
      await writeFile(stateLog, originalState)
      await symlink(stateLog, symlinkLog)
      await writeFile(hugeLog, `${"x".repeat(2 * 1024 * 1024)}\n`)

      execFileSync("bash", [script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CTS_LOG_SCAN_ROOT: root,
          CTS_LOG_SKIP_JOURNAL: "1",
          CTS_LOG_MAX_LINES: "1000",
          CTS_LOG_MAX_BYTES: "1048576",
        },
        stdio: "pipe",
      })

      for (const log of [xrdpLog, runtimeLog]) {
        const retained = (await readFile(log, "utf8")).trimEnd().split("\n")
        expect(retained).toHaveLength(1000)
        expect(retained[0]).toBe("line-0501")
        expect(retained.at(-1)).toBe("line-1500")
      }
      expect((await stat(hugeLog)).size).toBeLessThanOrEqual(1048576)
      expect(await readFile(stateLog, "utf8")).toBe(originalState)
      expect((await lstat(symlinkLog)).isSymbolicLink()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("publishes one shared host timer and bounded in-process buffers", async () => {
    const [installer, bootstrap, diskLimiter, systemLogger, consoleLogger, structuredLogger, auditLogger, engineLogger, monitoringLogger, errorLogger, redisOperations] = await Promise.all([
      readFile(path.join(process.cwd(), "scripts", "install.sh"), "utf8"),
      readFile(path.join(process.cwd(), "scripts", "bootstrap-install.sh"), "utf8"),
      readFile(path.join(process.cwd(), "scripts", "limit-runtime-logs.sh"), "utf8"),
      readFile(path.join(process.cwd(), "lib", "system-logger.ts"), "utf8"),
      readFile(path.join(process.cwd(), "lib", "console-logger.ts"), "utf8"),
      readFile(path.join(process.cwd(), "lib", "structured-logging.ts"), "utf8"),
      readFile(path.join(process.cwd(), "lib", "audit-logger.ts"), "utf8"),
      readFile(path.join(process.cwd(), "lib", "engine-structured-logging.ts"), "utf8"),
      readFile(path.join(process.cwd(), "lib", "monitoring-logger.ts"), "utf8"),
      readFile(path.join(process.cwd(), "lib", "error-logger.ts"), "utf8"),
      readFile(path.join(process.cwd(), "lib", "redis-operations.ts"), "utf8"),
    ])

    expect(diskLimiter).toContain('MAX_LINES="${CTS_LOG_MAX_LINES:-1000}"')
    expect(diskLimiter).toContain('scan_logs "$(rooted /var/log)"')
    expect(diskLimiter).toContain("Never descend through data, Redis, credentials, reports or backups")
    expect(installer).toContain("cts-log-retention.timer")
    expect(installer).toContain("SystemMaxUse=$journal_max")
    expect(installer).toContain("OnUnitActiveSec=5min")
    expect(installer).toContain("cleanup_transient_install_artifacts")
    expect(bootstrap).toContain('CTS_BACKUP_RETENTION_COUNT:-3')
    expect(bootstrap).toContain("copy_persistent_backup_state")
    expect(bootstrap).not.toContain('cp -a --reflink=auto -- "$legacy_root" "$backup/legacy-instance-state"')
    expect(bootstrap).toContain("prune_verified_backups")
    expect(systemLogger).toContain('pipeline.ltrim("logs:all:list", 0, 999)')
    expect(consoleLogger).toContain('client.ltrim("logs:all:list", 0, 999)')
    expect(structuredLogger).toContain("MAX_STRUCTURED_LOGS = 1000")
    expect(auditLogger).toContain("logs.slice(-999)")
    expect(engineLogger).toContain("ltrim(logKey, 0, 999)")
    expect(engineLogger).toContain("private flushPromise: Promise<void> | null = null")
    expect(monitoringLogger).toContain("settings:monitor_log:${expiredLogId}")
    expect(errorLogger).toContain("const toRemove = allLogs.slice(1000)")
    expect(errorLogger).toContain("settings:site_log:${oldId}")
    expect(redisOperations).toContain('ltrim("monitoring:events:list", 0, 999)')

    execFileSync("bash", ["-n", "scripts/limit-runtime-logs.sh"], { cwd: process.cwd() })
  })
})
