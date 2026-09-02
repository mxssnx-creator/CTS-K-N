import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("server auto-boot reconciler", () => {
  const script = readFileSync(resolve(process.cwd(), "scripts/ensure-server-autoboot.sh"), "utf8")
  const chiselUnit = readFileSync(resolve(process.cwd(), "docs/chisel-client.service.example"), "utf8")

  it("creates and verifies a root-only rollback checkpoint before mutation", () => {
    expect(script).toContain("create_backup")
    expect(script.lastIndexOf("\ncreate_backup\n")).toBeLessThan(
      script.lastIndexOf('bash "$PROJECT_ROOT/ops/server-access-dashboard/deploy/ensure-swap-18g.sh"'),
    )
    expect(script).toContain("bundle create")
    expect(script).toContain("bundle verify")
    expect(script).toContain("sha256sum -c SHA256SUMS")
    expect(script).toContain("chmod -R go-rwx")
  })

  it("never starts through an existing maintenance marker implicitly", () => {
    expect(script).toContain("--clear-maintenance")
    expect(script).toContain('MAINTENANCE_MARKER="$PROJECT_ROOT/.cts-runtime/maintenance-stop"')
    expect(script).toContain('backup_one "$MAINTENANCE_MARKER"')
    expect(script.indexOf("create_backup\n")).toBeLessThan(script.indexOf('rm -f -- "$MAINTENANCE_MARKER"'))
    expect(script).toContain("rerun with --clear-maintenance only after explicit start authorization")
  })

  it("enables and verifies every reboot-critical service", () => {
    for (const expected of [
      "chisel-server.service",
      "netbird.service",
      "tailscaled.service",
      "server-access-dashboard.service",
      "-scheduler.service",
      "-direct-trade.service",
      "-recovery.timer",
      "-pull-agent.timer",
      "systemctl enable --now",
      "systemctl is-enabled --quiet",
      "systemctl is-active --quiet",
    ]) {
      expect(script).toContain(expected)
    }
  })

  it("checks swap, Redis, application health, dashboard health, and mesh state", () => {
    expect(script).toContain("ensure-swap-18g.sh")
    expect(script).toContain("18 * 1024 * 1024 * 1024")
    expect(script).toContain("verify-redis-endpoint.mjs")
    expect(script).toContain("127.0.0.1:$APP_PORT/api/health")
    expect(script).toContain("127.0.0.1:3004/api/health")
    expect(script).toContain("tailscale status --json")
    expect(script).toContain("netbird status")
  })

  it("keeps Chisel authentication out of process arguments and committed files", () => {
    expect(chiselUnit).toContain("EnvironmentFile=/etc/chisel/client.env")
    expect(chiselUnit).not.toContain("--auth")
    expect(script).not.toContain("BINGX_X02_API_SECRET")
    expect(script).not.toMatch(/BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY/)
    expect(script).not.toMatch(/152\.53\.114\.112|b8gfZa8R/)
  })
})
