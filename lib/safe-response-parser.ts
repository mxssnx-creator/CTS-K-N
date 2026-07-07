/**
 * Safe Response Parser
 * Handles JSON and HTML responses properly with error recovery
 */

export async function safeParseResponse(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") || ""
  const responseText = await response.text()

  try {
    // If content-type is JSON or looks like JSON
    if (contentType.includes("application/json") || responseText.trim().startsWith("{")) {
      return JSON.parse(responseText)
    }

    // If it's HTML (error page), extract error message if possible
    if (contentType.includes("text/html") || responseText.includes("<!DOCTYPE")) {
      // Try to extract meaningful error from HTML
      const titleMatch = responseText.match(/<title[^>]*>([^<]+)<\/title>/i)
      const title = titleMatch ? titleMatch[1].trim() : "Gateway Error"

      // Extract status code from common patterns
      const statusMatch = responseText.match(/(\d{3})\s+(\w+)/i)
      const status = statusMatch ? `${statusMatch[1]} ${statusMatch[2]}` : "Unknown Status"

      const errorMessage =
        response.status === 502
          ? "Bad Gateway - API temporarily unavailable"
          : response.status === 503
            ? "Service Unavailable - Server overloaded"
          : response.status === 504
            ? "Gateway Timeout - Request took too long"
          : response.status === 429
            ? "Rate Limited - Too many requests"
          : title || status

      return {
        success: false,
        error: errorMessage,
        statusCode: response.status,
      }
    }

    // Try to parse as JSON anyway (might be malformed)
    return JSON.parse(responseText)
  } catch (parseError) {
    // If all parsing fails, return the raw text with context
    return {
      success: false,
      error: `Failed to parse response: ${response.status} ${response.statusText}`,
      raw: responseText.substring(0, 200),
      statusCode: response.status,
    }
  }
}
