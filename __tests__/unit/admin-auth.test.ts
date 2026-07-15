import { authorizeAdminBearer } from "@/lib/admin-auth"

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
})
