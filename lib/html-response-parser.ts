/**
 * HTML Response Parser
 * Extracts meaningful information from HTML error pages returned by APIs
 */

export function parseHTMLResponse(html: string): { title: string; message: string; statusCode?: number } {
  let title = "Server Error"
  let message = "An unexpected error occurred"
  let statusCode: number | undefined

  try {
    // Extract title from <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].trim()
    }

    // Try to extract status code from various patterns
    const statusMatch = html.match(/(\d{3})\s+(\w+)/i)
    if (statusMatch) {
      statusCode = parseInt(statusMatch[1])
      message = `${statusMatch[1]} ${statusMatch[2]}`
    }

    // Look for common error patterns
    const errorPatterns = [
      /<h1[^>]*>([^<]+)<\/h1>/i,
      /<p[^>]*class="[^"]*error[^"]*"[^>]*>([^<]+)<\/p>/i,
      /<span[^>]*class="[^"]*message[^"]*"[^>]*>([^<]+)<\/span>/i,
      /<div[^>]*class="[^"]*error[^"]*"[^>]*>([^<]+)<\/div>/i,
    ]

    for (const pattern of errorPatterns) {
      const match = html.match(pattern)
      if (match && match[1]) {
        message = match[1].trim().substring(0, 200)
        break
      }
    }

    // Map status codes to friendly messages with actionable guidance
    if (statusCode === 429) {
      message = "Rate limit exceeded. Please wait before retrying. Consider spreading requests over time."
    } else if (statusCode === 503) {
      message = "Service temporarily unavailable. API maintenance or server overload. Retry in 30 seconds."
    } else if (statusCode === 502) {
      message = "Bad gateway. Server may be restarting. Retry your request shortly."
    } else if (statusCode === 504) {
      message = "Gateway timeout. The request took too long. Check connection and retry."
    } else if (statusCode === 500) {
      message = "Internal server error. Try again in a moment. Contact support if it persists."
    } else if (statusCode === 403) {
      message = "Access forbidden. Check that API key has required permissions and IP whitelist is correct."
    } else if (statusCode === 401) {
      message = "Unauthorized. Verify API key, secret are correct and not expired."
    } else if (statusCode === 400) {
      message = "Bad request. Check parameters and request format are correct."
    }
  } catch (error) {
    console.error("[v0] Error parsing HTML response:", error)
  }

  return { title, message, statusCode }
}

export function isHTMLResponse(contentType: string, text: string): boolean {
  return contentType.includes("text/html") || text.includes("<!DOCTYPE") || text.includes("<html")
}

export function createErrorFromHTML(
  html: string,
  defaultMessage: string = "An error occurred"
): Error {
  const parsed = parseHTMLResponse(html)
  const message = parsed.statusCode
    ? `${parsed.statusCode}: ${parsed.message}`
    : parsed.message || defaultMessage
  return new Error(message)
}

/**
 * Extract HTTP status code from HTML response
 */
export function extractStatusCode(html: string): number {
  const match = html.match(/(\d{3})/)
  return match ? parseInt(match[1]) : 500
}

/**
 * Parse Cloudflare error pages specifically
 */
export function parseCloudflareError(html: string): { code: string; message: string } {
  let code = "UNKNOWN"
  let message = "Cloudflare error"

  try {
    // Cloudflare uses specific patterns
    const codeMatch = html.match(/Ray ID: <code>([^<]+)<\/code>/i)
    if (codeMatch) {
      code = codeMatch[1]
    }

    // Extract error type
    if (html.includes("429")) {
      message = "Rate limited by Cloudflare. Too many requests."
    } else if (html.includes("522")) {
      message = "Cloudflare - Connection Timeout. Origin server not responding."
    } else if (html.includes("524")) {
      message = "Cloudflare - Origin Timeout. Request took too long."
    } else if (html.includes("520")) {
      message = "Cloudflare - Origin Error. Origin server error."
    } else if (html.includes("521")) {
      message = "Cloudflare - Origin Down. Origin server is down."
    } else if (html.includes("523")) {
      message = "Cloudflare - Origin Unreachable. Cannot reach origin."
    }
  } catch (error) {
    console.error("[v0] Error parsing Cloudflare response:", error)
  }

  return { code, message }
}
