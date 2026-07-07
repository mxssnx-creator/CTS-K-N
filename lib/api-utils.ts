/**
 * Utility functions for handling API responses robustly
 * Handles cases where servers return HTML error pages instead of JSON
 */

export interface SafeFetchOptions extends RequestInit {
  headers?: Record<string, string>
}

/**
 * Safe fetch wrapper that handles HTML responses gracefully
 * Returns parsed JSON or throws descriptive error
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {}
): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  try {
    const response = await fetch(url, options)
    const contentType = response.headers.get("content-type") || ""
    const responseText = await response.text()

    // Check if response is HTML (error page)
    if (responseText.includes("<!DOCTYPE") || responseText.includes("<html")) {
      console.error("[v0] [API] Received HTML error response from", url, "Status:", response.status)
      return {
        ok: false,
        status: response.status,
        data: null,
        error: `Server Error (HTTP ${response.status} ${response.statusText}). Server may be temporarily unavailable.`,
      }
    }

    // Try to parse as JSON
    if (contentType.includes("application/json") || responseText.startsWith("{") || responseText.startsWith("[")) {
      try {
        const data = JSON.parse(responseText)
        return {
          ok: response.ok,
          status: response.status,
          data,
          error: response.ok ? undefined : data?.error || data?.message || "Unknown error",
        }
      } catch (parseError) {
        console.error("[v0] [API] Failed to parse JSON from", url, parseError)
        return {
          ok: false,
          status: response.status,
          data: null,
          error: `Failed to parse server response. Server may be experiencing issues.`,
        }
      }
    }

    // Response is neither JSON nor HTML - unexpected format
    console.warn("[v0] [API] Unexpected response format from", url, "Content-Type:", contentType)
    return {
      ok: response.ok,
      status: response.status,
      data: responseText,
      error: response.ok ? undefined : `Unexpected response format: ${contentType}`,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] [API] Fetch error from", url, errorMsg)

    // Categorize the error
    let categorizedError = errorMsg
    if (errorMsg.includes("Failed to fetch") || errorMsg.includes("NetworkError")) {
      categorizedError = "Network error: Cannot reach the server"
    } else if (errorMsg.includes("timeout")) {
      categorizedError = "Request timeout: Server took too long to respond"
    }

    return {
      ok: false,
      status: 0,
      data: null,
      error: categorizedError,
    }
  }
}

/**
 * Check if an error response is due to server issues vs client issues
 */
export function isServerError(status: number): boolean {
  return status >= 500 // 500, 502, 503, etc.
}

/**
 * Check if an error is temporary/retriable
 */
export function isRetriableError(status: number | string): boolean {
  if (typeof status === "string") {
    return status.includes("timeout") || status.includes("temporarily") || status.includes("unavailable")
  }
  // 429: Rate limit, 503: Service unavailable, 502: Bad gateway, 504: Gateway timeout
  return [429, 502, 503, 504].includes(status)
}

/**
 * Format error message for display to users
 */
export function formatErrorMessage(
  error: string,
  context?: string
): { title: string; description: string } {
  if (error.includes("Network")) {
    return {
      title: "Connection Error",
      description: "Cannot reach the server. Check your internet connection.",
    }
  }
  if (error.includes("timeout")) {
    return {
      title: "Request Timeout",
      description: "Server took too long to respond. Please try again.",
    }
  }
  if (error.includes("HTML") || error.includes("500") || error.includes("502") || error.includes("503")) {
    return {
      title: "Server Error",
      description: "Server is experiencing issues. Please try again in a moment.",
    }
  }
  if (error.includes("rate limit") || error.includes("429")) {
    return {
      title: "Rate Limited",
      description: "Too many requests. Please wait before trying again.",
    }
  }
  if (error.includes("Unexpected response")) {
    return {
      title: "Invalid Response",
      description: "Server returned unexpected response format.",
    }
  }
  return {
    title: "Error",
    description: error || "An error occurred. Please try again.",
  }
}
