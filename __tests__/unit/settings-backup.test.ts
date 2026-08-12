import {
  buildSettingsBackup,
  importedConnectionPatch,
  parseSettingsBackup,
} from "@/lib/settings-backup"

describe("settings backup", () => {
  it("round-trips one canonical JSON format without exporting credentials", () => {
    const backup = buildSettingsBackup(
      { theme: "blackwhiteblue", nested: { apiSecret: "never-export" } },
      [{
        id: "bingx-x02",
        exchange: "bingx",
        name: "Prod-VST",
        api_key: "key-value",
        api_secret: "secret-value",
        connection_settings: { max_concurrent_trades: 7, passphrase: "hidden" },
        last_test_status: "success",
      }],
      "2026-08-11T10:00:00.000Z",
    )

    expect(JSON.stringify(backup)).not.toContain("never-export")
    expect(JSON.stringify(backup)).not.toContain("key-value")
    expect(JSON.stringify(backup)).not.toContain("secret-value")
    expect(JSON.stringify(backup)).not.toContain("hidden")
    expect(backup.connections[0].last_test_status).toBeUndefined()
    expect(parseSettingsBackup(backup)).toEqual(backup)
  })

  it("preserves connection identity and rejects secret/runtime writes on import", () => {
    expect(importedConnectionPatch({
      id: "immutable",
      exchange: "bingx",
      name: "Updated",
      api_key: "blocked",
      last_test_balance: 12,
      margin_type: "isolated",
    })).toEqual({ name: "Updated", margin_type: "isolated" })
  })

  it("rejects arbitrary JSON", () => {
    expect(() => parseSettingsBackup({ settings: {} })).toThrow("Unsupported")
  })
})
