import { SiteLogger } from "./site-logger"

export function logApiCall(method: string, endpoint: string, status: number, duration: number, error?: any) {
  const level = status >= 500 ? "error" : status >= 400 ? "warning" : "info"
  const category = "API"
  const message = `${method} ${endpoint} - ${status}`

  SiteLogger[level](category, message, {
    method,
    endpoint,
    status,
    duration: `${duration}ms`,
    error: error?.message,
    stack: error?.stack,
  })
}

export function createApiLogger() {
  const startTime = Date.now()

  return {
    success: (method: string, endpoint: string, status = 200) => {
      const duration = Date.now() - startTime
      logApiCall(method, endpoint, status, duration)
    },
    error: (method: string, endpoint: string, status: number, error: any) => {
      const duration = Date.now() - startTime
      logApiCall(method, endpoint, status, duration, error)
    },
  }
}
