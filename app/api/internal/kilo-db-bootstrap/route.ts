import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const BOOTSTRAP_PUBLIC_KEY =
  "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAqaIVTbs7UaDmAbkGi86e7TeJePUd+2RAflhM1bQme/GRmVfD4XTvB/hkiG0+SMCHY3qY6R2VL+jncW7dFwGpgumHCP0f+c25Um09kEh/jeRsISMTVV/LTsBZUP3ekthCuSaq/yTiPAQbdMARfaVC9QD/yDQ5oEET0vgc84kjueaQxV4RjPZANPgHSgOADdI+MrD8ecCUseb37IecVqIWaN79U4ivZSh9bW88xxI1s4FLfut50aTq4wwtSGSaaHTwMPNafdtAe0NyoW77gyBfYDs7JA5VbQ/zWftzO6yhLlTNqJKUyC8sISDSrfiSfrMawYZgBHOKbyNpGaDtH+B1bqqeI0wH28LC9HtRFwiHsAr2SA2zE1RLD1etSOSAv/dJgURiEgLZRCD+JMo+w8DFSYsfw0B+2ektzZ5TC7Q3Zwg8opjikaGYDhykV/v9Ae7hXUhW89ohsMaoyrSLFRs+mXaAE5upkDvooiFj5oMD3h7CvTCLEZn96SubqUdLQc83AgMBAAE="

function bytesFromBase64(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0)).buffer as ArrayBuffer
}

function bytesToBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function isKiloPreviewHost(hostname: string): boolean {
  return /^[a-f0-9-]{36}\.builder\.kiloapps\.(?:io|ai)$/i.test(hostname)
}

export async function GET(request: NextRequest) {
  if (!isKiloPreviewHost(request.nextUrl.hostname)) {
    return new NextResponse(null, { status: 404 })
  }

  const dbUrl = process.env.DB_URL?.trim()
  const dbToken = process.env.DB_TOKEN?.trim()
  if (!dbUrl || !dbToken) {
    return NextResponse.json(
      { ready: false, reason: "managed_database_not_provisioned" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    )
  }

  const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
  ])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify({ dbUrl, dbToken }))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext)
  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey)
  const rsaKey = await crypto.subtle.importKey(
    "spki",
    bytesFromBase64(BOOTSTRAP_PUBLIC_KEY),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  )
  const wrappedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaKey, rawAesKey)

  return NextResponse.json(
    {
      algorithm: "RSA-OAEP-3072/AES-256-GCM",
      wrappedKey: bytesToBase64(wrappedKey),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(ciphertext),
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    },
  )
}
