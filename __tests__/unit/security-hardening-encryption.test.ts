import * as crypto from "crypto"
import { SecurityManager } from "@/lib/security-hardening"

describe("production encryption contract", () => {
  const manager = new SecurityManager({
    enableAuditLog: false,
    enableRateLimit: false,
    enableValidation: false,
  })

  test("round-trips arbitrary-length configured keys with authenticated AES-GCM", () => {
    const plaintext = "exchange-secret:never-store-as-plaintext"
    const encrypted = manager.encryptData(plaintext, "a-64-character-style-secret-key-that-is-longer-than-thirty-two-bytes")
    expect(encrypted).toMatch(/^v2:[a-f0-9]{24}:[a-f0-9]{32}:[a-f0-9]+$/)
    expect(encrypted).not.toContain(plaintext)
    expect(manager.decryptData(encrypted, "a-64-character-style-secret-key-that-is-longer-than-thirty-two-bytes"))
      .toBe(plaintext)
  })

  test("rejects tampering instead of returning ciphertext or plaintext", () => {
    const key = "tamper-test-encryption-key-0000000000"
    const encrypted = manager.encryptData("protected", key)
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("0") ? "1" : "0"}`
    expect(() => manager.decryptData(tampered, key)).toThrow()
  })

  test("can read the legacy CBC envelope with an exact 32-byte key", () => {
    const key = "12345678901234567890123456789012"
    const iv = Buffer.alloc(16, 7)
    const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(key), iv)
    const body = cipher.update("legacy-value", "utf8", "hex") + cipher.final("hex")
    expect(manager.decryptData(`${iv.toString("hex")}:${body}`, key)).toBe("legacy-value")
  })
})
