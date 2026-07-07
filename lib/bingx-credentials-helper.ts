import { NextResponse } from "next/server"

/**
 * Helper to submit real BingX credentials
 * Usage: Call this from the UI when user submits their real API credentials
 */
export async function submitBingXCredentials(apiKey: string, apiSecret: string, apiPassphrase: string = "") {
  try {
    const response = await fetch("/api/settings/connections/setup-bingx-real", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiKey,
        apiSecret,
        apiPassphrase,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || "Failed to submit credentials")
    }

    const data = await response.json()
    return { success: true, data }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[v0] Error submitting BingX credentials:", message)
    return { success: false, error: message }
  }
}

/**
 * Check if BingX has valid credentials
 */
export async function checkBingXCredentials() {
  try {
    const response = await fetch("/api/settings/connections/setup-bingx-real", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      const error = await response.json()
      return { ready: false, error: error.error || "Failed to check status" }
    }

    const data = await response.json()
    return data
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[v0] Error checking BingX credentials:", message)
    return { ready: false, error: message }
  }
}

/**
 * Update connection with credentials via PATCH
 */
export async function updateConnectionCredentials(
  connectionId: string,
  apiKey: string,
  apiSecret: string,
  apiPassphrase: string = ""
) {
  try {
    const response = await fetch(`/api/settings/connections/${connectionId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        api_secret: apiSecret,
        api_passphrase: apiPassphrase,
        is_testnet: false, // Always mainnet
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || "Failed to update credentials")
    }

    const data = await response.json()
    return { success: true, data }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error("[v0] Error updating connection credentials:", message)
    return { success: false, error: message }
  }
}
