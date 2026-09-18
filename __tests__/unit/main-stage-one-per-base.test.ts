import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const src = readFileSync(resolve(process.cwd(), "lib/strategy-coordinator.ts"), "utf8")
// selectActiveVariants is defined BEFORE variantProfiles in this file, so the
// slice must run forward from the profile table itself.
const profilesStart = src.indexOf("private variantProfiles")
const profiles = src.slice(profilesStart, profilesStart + 4000)
const defaultProfile = profiles.slice(profiles.indexOf('name: "default"'), profiles.indexOf('name: "trailing"'))

describe("the Main stage re-evaluates Base 1:1", () => {
  test("the default lane carries exactly one configuration", () => {
    // Count literal tuples only — the profile type declaration also starts
    // with "{ size:" and is not a configuration.
    const configs = defaultProfile.match(/\{ size: [0-9]/g) || []
    expect(configs.length).toBe(1)
  })

  test("that configuration is the neutral one — no bias, no leverage multiple", () => {
    expect(defaultProfile).toContain('{ size: 1.0, leverage: 1, state: "new", pfBias: 1.00, ddtBias: 0 }')
    // A second leverage tuple doubled every Base Set before the axis expansion
    // doubled it again.
    expect(defaultProfile).not.toContain("leverage: 2")
  })

  test("axis expansion stays the intended source of additional Main Sets", () => {
    expect(src).toContain("this.expandAxisSets(")
    // Block is handled after the profile loop, not as a per-base variant.
    expect(src).toContain('activeVariants.filter((p) => p.name !== "block")')
  })
})
