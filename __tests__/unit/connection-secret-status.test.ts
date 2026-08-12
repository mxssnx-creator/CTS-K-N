import {
  getConnectionCredentialStatus,
  maskConnectionSecrets,
  preserveMaskedConnectionSecrets,
} from "@/lib/connection-secrets"

describe("connection credential status", () => {
  it("reports configured credentials without exposing them", () => {
    const safe = maskConnectionSecrets({ api_key: "1234567890", api_secret: "abcdefghij" })
    expect(safe.credentials_configured).toBe(true)
    expect(safe.api_key).toBe("••••7890")
    expect(safe.api_secret).toBe("••••ghij")
  })

  it("does not treat placeholders as configured", () => {
    expect(getConnectionCredentialStatus({ api_key: "PLACEHOLDER", api_secret: "changeme" }))
      .toMatchObject({ credentials_configured: false })
  })

  it("keeps stored values when a masked edit form is saved", () => {
    expect(preserveMaskedConnectionSecrets(
      { api_key: "••••7890", api_secret: "", name: "Updated" },
      { api_key: "1234567890", api_secret: "abcdefghij" },
    )).toEqual({ name: "Updated" })
  })
})
