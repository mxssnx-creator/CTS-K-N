import { readFileSync } from "node:fs"
import { resolve } from "node:path"
describe("boot never overwrites the operator's symbol count", () => {
  const src = readFileSync(resolve(process.cwd(), "lib/redis-migrations.ts"), "utf8")
  test("existing connections get symbol defaults only where the field is missing", () => {
    expect(src).toContain("const fillMissing = async (key: string, defaults: Record<string, string>) => {")
    expect(src).toContain("await fillMissing(`settings:trade_engine_state:${cfg.id}`, {")
    expect(src).toContain("await fillMissing(`settings:connection:${cfg.id}`, {")
  })
  test("fill-missing semantics: a saved 30 survives, an absent field gets the default", async () => {
    const store: Record<string, Record<string, string>> = { k: { symbol_count: "30" }, e: {} }
    const client = { hgetall: async (k: string) => store[k] || {}, hset: async (k: string, v: Record<string, string>) => { store[k] = { ...(store[k] || {}), ...v } } }
    const fillMissing = async (key: string, defaults: Record<string, string>) => {
      const current = ((await client.hgetall(key).catch(() => ({}))) || {}) as Record<string, string>
      const missing = Object.fromEntries(Object.entries(defaults).filter(([field]) => !String(current[field] ?? "").trim()))
      if (Object.keys(missing).length > 0) await client.hset(key, missing)
    }
    await fillMissing("k", { symbol_count: "4", symbol_order: "volatility_1h" })
    await fillMissing("e", { symbol_count: "4" })
    expect(store.k).toEqual({ symbol_count: "30", symbol_order: "volatility_1h" })
    expect(store.e).toEqual({ symbol_count: "4" })
  })
})
