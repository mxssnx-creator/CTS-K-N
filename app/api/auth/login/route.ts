import { type NextRequest, NextResponse } from "next/server"
import { verifyPassword, createToken, setSession } from "@/lib/auth"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json()

    // Validate input
    if (!email || !password) {
      return NextResponse.json({ success: false, error: "Missing email or password" }, { status: 400 })
    }

    // Initialize Redis and find user
    await initRedis()
    const client = getRedisClient()
    
    // Find user in Redis
    const userKeys = await (client as any).keys("user:*")
    let user = null
    
    for (const key of userKeys) {
      const userData = await (client as any).hgetall(key)
      if (userData?.email === email) {
        user = userData
        break
      }
    }

    if (!user) {
      return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 401 })
    }

    // Check if user is active
    if (user.is_active === "false" || user.is_active === false || user.is_active === "0") {
      return NextResponse.json({ success: false, error: "Account is disabled" }, { status: 403 })
    }

    // Verify password
    const isValid = await verifyPassword(password, user.password_hash)

    if (!isValid) {
      return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 401 })
    }

    // Create JWT token
    const token = await createToken({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role || "user",
    })

    // Set session cookie
    await setSession(token)

    return NextResponse.json({
      success: true,
      data: {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role || "user",
        },
        token,
      },
    })
  } catch (error) {
    console.error("[v0] Login error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
