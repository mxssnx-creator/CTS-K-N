import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { CONNECTION_AUDITED_FIELDS, diffAuditedConnectionFields } from "@/lib/redis-db"

describe("connection settings changes are audited with their writer", () => {
  test("only operator fields count, and only real changes", () => {
    const prev = { is_live_trade: "1", is_assigned: "1", name: "X", live_volume_factor: "10", selected_symbols: "[\"A\"]" }
    const d = diffAuditedConnectionFields(prev, { is_live_trade: "0", is_assigned: "1", name: "Y", live_volume_factor: 10, updated_at: "now" })
    expect(d).toEqual([{ field: "is_live_trade", from: "1", to: "0" }])
  })
  test("a field set for the first time and a field cleared are both changes", () => {
    expect(diffAuditedConnectionFields({}, { max_leverage: "20" })).toEqual([{ field: "max_leverage", from: "", to: "20" }])
    expect(diffAuditedConnectionFields({ is_active: "1" }, { is_active: null })).toEqual([{ field: "is_active", from: "1", to: "" }])
  })
  test("the flags that reset on X02 are all audited", () => {
    for (const f of ["is_live_trade", "is_active", "is_assigned", "is_enabled_dashboard", "symbol_order", "dev_symbol_count_override"]) expect(CONNECTION_AUDITED_FIELDS.has(f)).toBe(true)
  })
  test("both write paths record the audit before writing", () => {
    const db = readFileSync(resolve(process.cwd(), "lib/redis-db.ts"), "utf8")
    expect(db).toContain('recordConnectionChangeAudit(client, id, "updateConnection", diffAuditedConnectionFields(existing, connectionPatch))')
    expect(db).toContain('recordConnectionChangeAudit(client, id, "saveConnection", diffAuditedConnectionFields(previous, data))')
  })
  test("the installer caps the app heap at 3 GB unless overridden", () => {
    const sh = readFileSync(resolve(process.cwd(), "scripts/install.sh"), "utf8")
    expect(sh).toContain('local app_heap_cap_mb="${CTS_APP_HEAP_MB_MAX:-3072}"')
  })
})

describe("dashboard state switches are audited too", () => {
  test("updateConnectionState records the change with its writer", () => {
    const db = readFileSync(resolve(process.cwd(), "lib/redis-db.ts"), "utf8")
    expect(db).toContain('recordConnectionChangeAudit(client, id, "updateConnectionState", diffAuditedConnectionFields(existing, connectionPatch))')
  })
})
