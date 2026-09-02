import { readFileSync } from "node:fs"
import { resolve } from "node:path"

describe("pull-agent installer", () => {
  const script = readFileSync(resolve(process.cwd(), "scripts/install-pull-agent.sh"), "utf8")

  it("uses the canonical updater only after clean fast-forward validation", () => {
    expect(script).toContain('git -C "$CTS_PULL_AGENT_INSTALL_DIR" status --porcelain --untracked-files=no')
    expect(script).toContain('git -C "$CTS_PULL_AGENT_INSTALL_DIR" merge-base --is-ancestor "$current" "$target"')
    expect(script).toContain('bash "$CTS_PULL_AGENT_INSTALL_DIR/scripts/update.sh"')
    expect(script).toContain('systemctl enable --now "$TIMER_UNIT"')
  })

  it("keeps the credential-bearing production environment external", () => {
    expect(script).toContain("CTS_PULL_AGENT_ENV_FILE")
    expect(script).toContain("env_mode_bits == 0600 || env_mode_bits == 0640")
    expect(script).not.toContain("BINGX_X02_API_SECRET")
    expect(script).not.toMatch(/BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY/)
  })
})
