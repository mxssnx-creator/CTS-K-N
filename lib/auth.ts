// Authentication utilities
import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"
import bcrypt from "bcryptjs"

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "your-secret-key-change-in-production")

export interface User {
  id: number
  username: string
  email: string
  role: string
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function createToken(user: User): Promise<string> {
  return new SignJWT({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(JWT_SECRET)
}

export async function verifyToken(token: string): Promise<User | null> {
  try {
    const verified = await jwtVerify(token, JWT_SECRET)
    return verified.payload as unknown as User
  } catch (error) {
    return null
  }
}

export async function getSession(): Promise<User | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get("auth_token")

  if (!token) {
    return null
  }

  return verifyToken(token.value)
}

export async function setSession(token: string) {
  const cookieStore = await cookies()
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: "/",
  })
}

export async function clearSession() {
  const cookieStore = await cookies()
  cookieStore.delete("auth_token")
}

export async function verifyAuth(request: Request): Promise<{
  authenticated: boolean
  user: User | null
}> {
  try {
    const cookieHeader = request.headers.get("cookie")
    if (!cookieHeader) {
      return { authenticated: false, user: null }
    }

    // Parse the auth_token from cookies
    const cookies = cookieHeader.split(";").map((c) => c.trim())
    const authCookie = cookies.find((c) => c.startsWith("auth_token="))

    if (!authCookie) {
      return { authenticated: false, user: null }
    }

    const token = authCookie.split("=")[1]
    const user = await verifyToken(token)

    if (!user) {
      return { authenticated: false, user: null }
    }

    return { authenticated: true, user }
  } catch (error) {
    console.error("[v0] Auth verification error:", error)
    return { authenticated: false, user: null }
  }
}
