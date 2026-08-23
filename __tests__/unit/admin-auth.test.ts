import { authorizeAdminBearer, authorizeAdminRequest } from "@/lib/admin-auth"

describe("admin bearer authentication", () => {
  const secret = "a-secure-admin-secret-for-tests"

  test.each([undefined, "", "short", "replace_me_admin_secret"])(
    "fails closed for an unconfigured secret (%s)",
    (configured) => {
      expect(authorizeAdminBearer(`Bearer ${secret}`, configured)).toMatchObject({
        ok: false,
        status: 503,
      })
    },
  )

  test.each([null, "", "Basic value", "Bearer wrong-secret-value"])(
    "rejects an invalid authorization header (%s)",
    (header) => {
      expect(authorizeAdminBearer(header, secret)).toMatchObject({
        ok: false,
        status: 401,
      })
    },
  )

  test("accepts only the exact configured bearer secret", () => {
    expect(authorizeAdminBearer(`Bearer ${secret}`, secret)).toMatchObject({ ok: true })
  })

  test("accepts the built-in same-origin admin session without exposing ADMIN_SECRET", async () => {
    const request = new Request("https://trade.example/api/admin/clear-progressions", {
      method: "POST",
      headers: {
        host: "trade.example",
        origin: "https://trade.example",
        "sec-fetch-site": "same-origin",
      },
    })
    await expect(authorizeAdminRequest(request, undefined, async () => ({
      authenticated: true,
      user: { id: "1", username: "admin", email: "admin@example.test", role: "admin" },
    }))).resolves.toEqual({ ok: true })
  })

  test("rejects non-admin and cross-origin session mutations", async () => {
    const userVerifier = async () => ({
      authenticated: true,
      user: { id: "2", username: "user", email: "user@example.test", role: "user" },
    })
    await expect(authorizeAdminRequest(new Request("https://trade.example/api/admin/clear-progressions", {
      method: "POST",
      headers: { host: "trade.example", origin: "https://trade.example" },
    }), secret, userVerifier)).resolves.toMatchObject({ ok: false, status: 401 })

    await expect(authorizeAdminRequest(new Request("https://trade.example/api/admin/clear-progressions", {
      method: "POST",
      headers: {
        host: "trade.example",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    }), secret, async () => ({
      authenticated: true,
      user: { id: "1", username: "admin", email: "admin@example.test", role: "admin" },
    }))).resolves.toMatchObject({ ok: false, status: 403 })
  })
})
