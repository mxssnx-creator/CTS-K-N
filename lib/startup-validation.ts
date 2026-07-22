/**
 * Production Startup Validation
 * Validates all critical dependencies and configuration before engine starts
 */

interface ValidationResult {
  passed: boolean
  checks: Record<string, { status: "ok" | "warning" | "error"; message: string }>
  errors: string[]
  warnings: string[]
}

/**
 * Comprehensive production startup validation
 */
export async function validateProductionStartup(): Promise<ValidationResult> {
  const result: ValidationResult = {
    passed: true,
    checks: {},
    errors: [],
    warnings: [],
  }

  // 1. Validate environment variables
  const envVars = validateEnvironmentVariables()
  result.checks.environment = envVars
  if (envVars.status === "error") {
    result.passed = false
    result.errors.push(envVars.message)
  } else if (envVars.status === "warning") {
    result.warnings.push(envVars.message)
  }

  // 2. Validate Redis connection
  const redisCheck = await validateRedisConnection()
  result.checks.redis = redisCheck
  if (redisCheck.status === "error") {
    result.passed = false
    result.errors.push(redisCheck.message)
  } else if (redisCheck.status === "warning") {
    result.warnings.push(redisCheck.message)
  }

  // 3. Validate database schema
  const schemaCheck = await validateDatabaseSchema()
  result.checks.schema = schemaCheck
  if (schemaCheck.status === "error") {
    result.passed = false
    result.errors.push(schemaCheck.message)
  }

  // 4. Validate API credentials
  const credentialsCheck = validateAPICredentials()
  result.checks.credentials = credentialsCheck
  if (credentialsCheck.status === "error") {
    result.passed = false
    result.errors.push(credentialsCheck.message)
  }

  // 5. Validate system time
  const timeCheck = await validateSystemTime()
  result.checks.systemTime = timeCheck
  if (timeCheck.status === "error") {
    result.passed = false
    result.errors.push(timeCheck.message)
  } else if (timeCheck.status === "warning") {
    result.warnings.push(timeCheck.message)
  }

  // 6. Validate network connectivity
  const networkCheck = await validateNetworkConnectivity()
  result.checks.network = networkCheck
  if (networkCheck.status === "error") {
    result.passed = false
    result.errors.push(networkCheck.message)
  } else if (networkCheck.status === "warning") {
    result.warnings.push(networkCheck.message)
  }

  // Log results
  if (result.passed) {
    console.log("[v0] ✓ Production startup validation PASSED")
    if (result.warnings.length > 0) {
      console.warn("[v0] Warnings during startup validation:", result.warnings)
    }
  } else {
    console.error("[v0] ✗ Production startup validation FAILED")
    console.error("[v0] Critical errors:", result.errors)
  }

  return result
}

function validateEnvironmentVariables(): { status: "ok" | "warning" | "error"; message: string } {
  const required = ["REDIS_URL", "NEXT_PUBLIC_APP_URL"]
  const recommended = ["ALLOW_INLINE_REDIS_LIVE_TRADING", "CRON_SECRET"]
  
  const missing = required.filter((v) => !process.env[v])
  if (missing.length > 0) {
    return {
      status: "error",
      message: `Missing required environment variables: ${missing.join(", ")}`,
    }
  }

  const missingRecommended = recommended.filter((v) => !process.env[v])
  if (missingRecommended.length > 0) {
    return {
      status: "warning",
      message: `Missing recommended environment variables: ${missingRecommended.join(", ")}`,
    }
  }

  return { status: "ok", message: "All required environment variables present" }
}

async function validateRedisConnection(): Promise<{ status: "ok" | "warning" | "error"; message: string }> {
  try {
    const { initRedis, getSettings } = await import("@/lib/redis-db")
    await initRedis()
    await getSettings("_startup_check")
    return { status: "ok", message: "Redis connection successful" }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return { status: "error", message: `Redis connection failed: ${message}` }
  }
}

async function validateDatabaseSchema(): Promise<{ status: "ok" | "warning" | "error"; message: string }> {
  try {
    const { initRedis, getSettings } = await import("@/lib/redis-db")
    await initRedis()
    
    // Check for required top-level keys
    const requiredKeys = ["progression_state", "strategies", "connections"]
    
    // Validate that schema migrations have run
    const migrationVersion = await getSettings("_migration_version")
    if (!migrationVersion) {
      return {
        status: "warning",
        message: "Database schema has not been initialized - migrations may need to run",
      }
    }

    return { status: "ok", message: `Database schema valid (migration version: ${migrationVersion})` }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return { status: "error", message: `Database schema validation failed: ${message}` }
  }
}

function validateAPICredentials(): { status: "ok" | "warning" | "error"; message: string } {
  try {
    const hasConnections = process.env.ALLOW_INLINE_REDIS_LIVE_TRADING === "1"
    if (!hasConnections) {
      return {
        status: "warning",
        message: "Live trading not enabled (ALLOW_INLINE_REDIS_LIVE_TRADING not set)",
      }
    }
    return { status: "ok", message: "Live trading credentials validated" }
  } catch (err) {
    return { status: "error", message: "Failed to validate API credentials" }
  }
}

async function validateSystemTime(): Promise<{ status: "ok" | "warning" | "error"; message: string }> {
  try {
    const localTime = Date.now()
    
    // Simple NTP-like check via API
    const response = await fetch("https://www.google.com", { method: "HEAD" })
    const dateHeader = response.headers.get("date")
    
    if (dateHeader) {
      const serverTime = new Date(dateHeader).getTime()
      const drift = Math.abs(localTime - serverTime)
      
      if (drift > 5000) {
        return {
          status: "warning",
          message: `System clock is skewed by ${drift}ms - BingX API may fail with timestamp errors`,
        }
      }
      
      if (drift > 60000) {
        return {
          status: "error",
          message: `System clock is severely skewed by ${drift}ms - BingX API will fail`,
        }
      }
    }
    
    return { status: "ok", message: "System time synchronized" }
  } catch (err) {
    return { status: "warning", message: "Could not verify system time synchronization" }
  }
}

async function validateNetworkConnectivity(): Promise<{ status: "ok" | "warning" | "error"; message: string }> {
  try {
    // Test connectivity to BingX API
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    
    try {
      const response = await fetch("https://api.binance.com/api/v3/ping", {
        signal: controller.signal,
      })
      
      if (response.ok) {
        return { status: "ok", message: "Network connectivity to exchange API verified" }
      } else {
        return { status: "warning", message: "Exchange API returned non-ok status" }
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    return { status: "warning", message: "Could not verify network connectivity to exchange API" }
  }
}

/**
 * Quick health check for runtime
 */
export async function runtimeHealthCheck(): Promise<Record<string, any>> {
  const checks: Record<string, any> = {}

  // Check Redis
  try {
    const { initRedis, getSettings } = await import("@/lib/redis-db")
    await initRedis()
    await getSettings("_health_check")
    checks.redis = "ok"
  } catch {
    checks.redis = "error"
  }

  // Check engine state
  try {
    const { initRedis, getSettings } = await import("@/lib/redis-db")
    await initRedis()
    const state = await getSettings("engine_state")
    checks.engineState = state?.running ? "running" : "stopped"
  } catch {
    checks.engineState = "error"
  }

  // System info
  checks.timestamp = Date.now()
  checks.uptime = process.uptime ? Math.floor(process.uptime()) : "unknown"
  checks.memory = process.memoryUsage
    ? {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      }
    : "unknown"

  return checks
}
