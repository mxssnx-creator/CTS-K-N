"use server"

/**
 * Application Initialization
 * Now Redis-based with automatic initialization on startup
 */

let initializationComplete = false

export async function initializeApplication() {
  if (initializationComplete) {
    return { success: true, message: "Application already initialized" }
  }

  try {
    console.log("[v0] Application initializing with Redis...")
    
    // Initialize Redis with migrations
    const { initRedis } = await import("@/lib/redis-db")
    const { runMigrations } = await import("@/lib/redis-migrations")
    
    await initRedis()
    await runMigrations()
    
    initializationComplete = true
    console.log("[v0] Application initialized successfully")
    
    return { success: true, message: "Application initialized" }
  } catch (error) {
    console.error("[v0] Initialization error:", error)
    return { success: false, error: String(error) }
  }
}

export async function resetInitialization() {
  initializationComplete = false
}
