import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const PROJECT_ID = "7fa946be-249f-4c4d-bf50-3daf3f5f392d"
const EXPECTED_HOST = `${PROJECT_ID}.builder.kiloapps.io`
const EXPECTED_DB_URL = `https://db-proxy.engineering-e11.workers.dev/api/${PROJECT_ID}/query`
const TRANSFER_PUBLIC_KEY = "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA0UMIn3OHBUV7pQQiiUSa1mAR6knENwzL9DLMsgLeQH/TIDn/cnm2XLTD7HBKvZoPj5MuXhKCYNk/kRfLYwLWOKmDiNRNagQLeS0tWJAf1uuRu/aI8kVc64Np7MGq13mcyN1XDoOknfRTe6MvKkUJbDMwkwqMZAMv3lyYx/YVS7HNFxvkeVOVvFL7Rkm7k+hSOcBMbn+4vKF/F615ID8PIUs+/3ysxjsEjvS7DwbS9QzRbHT8QT6eIK2xj+Z6Sd99C7Xh6Sx7Zie7MeGM4MGpOHWk2JJuiwu68B1M7KXt7mxxSSsrLTgBunqbXxzpZYuNu+pRMmN0eLxSMj8Lku/yNr6Xn6dNDPl7bdjbd7AKmW8xRdvZUeeXluBfhTtgYz+wD7CSAfGgpCLZrs+dvyuLMN8W8q1dN8hW76hWVb78xqHyQSTicJbbzzJUTWj19Fq194FMuf+gnsN79/jsdv8QdrAEAEBD7ZqZIz1VXKhBAvF1ypxQKBUbKtNykEvb3YYfAgMBAAE="

function decodeBase64(value: string): ArrayBuffer {
  const bytes = Buffer.from(value, "base64")
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function encodeBase64(value: ArrayBuffer): string {
  return Buffer.from(value).toString("base64")
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(":")[0]
  const host = (forwardedHost || request.headers.get("host")?.split(":")[0] || requestUrl.hostname).toLowerCase()
  if (host !== EXPECTED_HOST) {
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": "no-store, max-age=0" },
    })
  }

  const dbUrl = String(process.env.DB_URL || "").trim()
  const dbToken = String(process.env.DB_TOKEN || "").trim()
  if (dbUrl !== EXPECTED_DB_URL || dbToken.length < 16) {
    return NextResponse.json(
      { ready: false },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    )
  }

  const publicKey = await crypto.subtle.importKey(
    "spki",
    decodeBase64(TRANSFER_PUBLIC_KEY),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  )
  const dataKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify({ dbUrl, dbToken }))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, plaintext)
  const rawKey = await crypto.subtle.exportKey("raw", dataKey)
  const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawKey)

  return NextResponse.json(
    {
      version: 1,
      algorithm: "RSA-OAEP-3072/AES-256-GCM",
      iv: Buffer.from(iv).toString("base64"),
      ciphertext: encodeBase64(ciphertext),
      wrappedKey: encodeBase64(wrappedKey),
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  )
}
