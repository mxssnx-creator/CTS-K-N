import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const install = readFileSync(resolve(process.cwd(), "scripts/install.sh"), "utf8")
const rollback = install.slice(install.indexOf("rollback_after_failed_verification() {"))
const verify = install.slice(install.indexOf("verify_and_restart() {"), install.indexOf("rollback_after_failed_verification() {"))

describe("a configuration gap must not take a healthy build off the air", () => {
  test("the failure kind defaults to build and is only widened by deployment init", () => {
    expect(install).toContain('VERIFY_FAILURE_KIND="build"')
    // Reset at the start of every verification run, so a previous run cannot
    // leak a permissive value into this one.
    expect(verify).toContain('VERIFY_FAILURE_KIND="build"')
    expect(verify).toContain('VERIFY_FAILURE_KIND="configuration"')
    expect((install.match(/VERIFY_FAILURE_KIND="configuration"/g) || []).length).toBe(1)
  })

  test("only production-deploy-init is classified as configuration", () => {
    const initCall = verify.indexOf("production-deploy-init.mjs")
    const marker = verify.indexOf('VERIFY_FAILURE_KIND="configuration"')
    expect(initCall).toBeGreaterThan(0)
    expect(marker).toBeGreaterThan(initCall)
    // The health, scheduler, site-identity and asset checks keep plain
    // `return 1`, so a broken build still fails closed.
    expect(verify).toContain("wait_for_health 90 || return 1")
    expect(verify).toContain("run-minute-scheduler.mjs\" --once")
    // Every check other than deployment init keeps its plain fail-closed return.
    expect(verify.match(/\|\| return 1/g)!.length).toBeGreaterThanOrEqual(6)
  })

  test("a configuration failure keeps the runtime running and verifies it", () => {
    const branch = rollback.slice(rollback.indexOf('if [[ "$VERIFY_FAILURE_KIND" == "configuration" ]]'))
    expect(branch).toContain("if ! start_runtime; then")
    expect(branch).toContain("wait_for_health 90")
    expect(branch).toContain("runtime left running on the new build")
    // It must not fall through into the stopping path.
    const stopIndex = rollback.indexOf("stop_runtime")
    const branchIndex = rollback.indexOf('if [[ "$VERIFY_FAILURE_KIND" == "configuration" ]]')
    expect(branchIndex).toBeLessThan(stopIndex)
  })

  test("a build failure still stops the runtime and fails closed", () => {
    expect(rollback).toContain("stop_runtime")
    expect(rollback).toContain("Installation is not production-ready; inspect service logs")
  })
})
