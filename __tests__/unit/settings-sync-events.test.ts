import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("same-page settings sync", () => {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  beforeAll(() => {
    ;(global as any).window = {
      addEventListener: (type: string, listener: (event: Event) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(listener)
      },
      removeEventListener: (type: string, listener: (event: Event) => void) => listeners.get(type)?.delete(listener),
      dispatchEvent: (event: Event) => { listeners.get(event.type)?.forEach((listener) => listener(event)); return true },
    }
  })
  afterAll(() => { delete (global as any).window })

  test("a value saved by one control reaches every subscriber until it unsubscribes", async () => {
    const { publishAppSettingSaved, subscribeAppSettingSaved } = await import("@/lib/settings-sync-events")
    const seen: unknown[] = []
    const unsubscribe = subscribeAppSettingSaved(({ key, value }) => seen.push([key, value]))
    publishAppSettingSaved("autoEnabled", false)
    unsubscribe()
    publishAppSettingSaved("autoEnabled", true)
    expect(seen).toEqual([["autoEnabled", false]])
  })

  test("the Auto card publishes its save and the Settings page adopts it", () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8")
    expect(read("components/settings/auto-indication-settings.tsx")).toContain('publishAppSettingSaved("autoEnabled", data.settings.enabled)')
    const page = read("app/settings/page.tsx")
    expect(page).toContain("subscribeAppSettingSaved(({ key, value })")
    expect(page).toContain('publishAppSettingSaved("autoEnabled", settingsData.settings.autoEnabled)')
  })
})
