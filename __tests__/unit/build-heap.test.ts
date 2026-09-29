import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const heap = (env: Record<string, string>): number => {
  const module = "file://" + resolve(process.cwd(), "scripts/build-heap.mjs")
  const code = `import { resolveBuildHeapMb } from ${JSON.stringify(module)}; console.log(resolveBuildHeapMb(${JSON.stringify(env)}))`
  return Number(execFileSync("node", ["--input-type=module", "-e", code], { encoding: "utf8" }).trim())
}
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8")

describe("the build heap does not shrink with the neighbours", () => {
  test("2026-09-29 11:14 UTC: a runtime budget of 1282 MB no longer becomes a 1282 MB build", () => {
    expect(heap({ CTS_NODE_HEAP_MB: "1282" })).toBe(3584)
  })
  test("a larger runtime figure is kept, and an unset one falls back to the default", () => {
    expect(heap({ CTS_NODE_HEAP_MB: "4543" })).toBe(4543)
    expect(heap({})).toBe(5632)
  })
  test("CTS_BUILD_NODE_HEAP_MB wins when it is sane, and is ignored when it is not", () => {
    expect(heap({ CTS_BUILD_NODE_HEAP_MB: "6144", CTS_NODE_HEAP_MB: "1282" })).toBe(6144)
    expect(heap({ CTS_BUILD_NODE_HEAP_MB: "512", CTS_NODE_HEAP_MB: "1282" })).toBe(3584)
    expect(heap({ CTS_BUILD_NODE_HEAP_MB: "abc", CTS_NODE_HEAP_MB: "junk" })).toBe(5632)
  })
  test("the package script and the wrapper both take the build figure, not the runtime one", () => {
    const script = JSON.parse(read("package.json")).scripts["build:next"] as string
    expect(script).toContain("${CTS_BUILD_NODE_HEAP_MB:-5632}")
    expect(script).not.toContain("CTS_NODE_HEAP_MB")
    const wrapper = read("scripts/build-next-with-trace-retry.mjs")
    expect(wrapper).toContain('import { resolveBuildHeapMb } from "./build-heap.mjs"')
    expect(wrapper).toContain("CTS_BUILD_NODE_HEAP_MB: String(resolveBuildHeapMb(process.env))")
  })
  test("the installer keeps a floor for the RUNNING app heap on a host with the memory", () => {
    const sh = read("scripts/install.sh")
    expect(sh).toContain('local app_heap_floor_mb="${CTS_APP_HEAP_MB_MIN:-2048}"')
    expect(sh).toContain("(( total_mb >= 8192 && app_heap_mb < app_heap_floor_mb )) && app_heap_mb=$app_heap_floor_mb")
    expect(sh.indexOf("app_heap_floor_mb=$app_heap_floor_mb")).toBeLessThan(sh.indexOf("app_heap_mb=$app_heap_cap_mb"))
  })
})
