jest.mock("jose", () => ({
  SignJWT: class {
    setProtectedHeader() { return this }
    setIssuedAt() { return this }
    setExpirationTime() { return this }
    async sign() { return "unit-signed-token" }
  },
  jwtVerify: async () => ({
    payload: {
      id: "runtime-user",
      username: "runtime-user",
      email: "runtime-user@example.test",
      role: "operator",
    },
  }),
}))

jest.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}))

describe("JWT runtime-secret loading", () => {
  const originalJwtSecret = process.env.JWT_SECRET

  afterEach(() => {
    jest.resetModules()
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = originalJwtSecret
  })

  it("does not require JWT_SECRET while a route module is imported for build", async () => {
    delete process.env.JWT_SECRET
    const auth = await import("@/lib/auth")

    await expect(auth.createToken({
      id: "build-check",
      username: "build-check",
      email: "build-check@example.test",
      role: "user",
    })).rejects.toThrow("JWT_SECRET is not configured")
  })

  it("signs and verifies only after a runtime secret is supplied", async () => {
    process.env.JWT_SECRET = "unit-runtime-jwt-secret-000000000000000000"
    const { createToken, verifyToken } = await import("@/lib/auth")
    const user = {
      id: "runtime-user",
      username: "runtime-user",
      email: "runtime-user@example.test",
      role: "operator",
    }

    const token = await createToken(user)
    await expect(verifyToken(token)).resolves.toMatchObject(user)
  })
})
