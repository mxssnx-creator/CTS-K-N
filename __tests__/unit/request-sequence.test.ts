import { createRequestSequence } from "@/lib/request-sequence"

describe("request sequence", () => {
  test("a stale request cannot apply data or clear a newer request's spinner", async () => {
    const seq = createRequestSequence()
    let loading = false
    let applied: string | null = null
    const run = async (label: string, parse: Promise<void>) => {
      const token = seq.begin()
      loading = true
      try {
        await parse
        if (!seq.isCurrent(token)) return
        applied = label
      } finally {
        if (seq.isCurrent(token)) loading = false
      }
    }
    let releaseOld!: () => void
    const oldParse = new Promise<void>((r) => { releaseOld = r })
    const old = run("old", oldParse)
    let releaseNew!: () => void
    const newer = run("new", new Promise<void>((r) => { releaseNew = r }))
    releaseOld(); await old
    expect(applied).toBeNull()
    expect(loading).toBe(true)
    releaseNew(); await newer
    expect(applied).toBe("new")
    expect(loading).toBe(false)
    seq.invalidate()
    expect(seq.isCurrent(2)).toBe(false)
  })
})
