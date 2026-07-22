const APP_ID = "7fa946be-249f-4c4d-bf50-3daf3f5f392d"
const EXPECTED_HOST = `${APP_ID}.builder.kiloapps.io`
const PUBLIC_KEY = "MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA98J4CowQv/czoOccV2u6NqcYBF9wWAnHt6wGsCKbGawio/zJ3NQkCV5NOehxtoHUplTwHGch7Ap+1aHr3ZpRzWbshxWNBTgvNUYFkY29j9oADKEgIuVasruOvYW4vmiwkP0prS0qtkVI5bxemykqX2dnsgYlnf+wNB3mwH86JxN6nzmoY42dSJvx85/6a14sUMl5arLHi2WpUZpKyitBb+ag1OYlnUhi6GWrbO48AL1CFyVTGu6y4LTbvWkKpjDuMHISw0Zi9hz2HyX+uooP7zdodta3nAa96KOh2aJxAXj5DzKlFO7HbifLUbDu0DqSWjTSe3UelDRVd1cWhHz8n3MLRwBl7ZxVZUjKplPc4YlHdpTVxVHIuYT9eZaI7TZCLRr406qY1iT8tgbwEpmKGtTyq9nzOVgVqnEQ3Bvuw+cheigZTXZ8r70RkqlZi+9c5+cGvpCxJRClZ1UTpqL2npQM5LyQoHB0jkGuXNglTUXIQyRdTreAvS6HSoecuspNAgMBAAE="

function fromBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function toBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function encryptedCredentials() {
  const dbUrl = String(process.env.DB_URL || "").trim()
  const dbToken = String(process.env.DB_TOKEN || "").trim()
  if (!dbUrl || !dbToken) return null

  const publicKey = await crypto.subtle.importKey(
    "spki",
    fromBase64(PUBLIC_KEY),
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
  return {
    version: 1,
    algorithm: "RSA-OAEP-3072/AES-256-GCM",
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
    wrappedKey: toBase64(wrappedKey),
  }
}

Bun.serve({
  port: Number(process.env.PORT || 8080),
  async fetch(request) {
    const url = new URL(request.url)
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(":")[0]
    const host = forwardedHost || url.hostname
    if (host !== EXPECTED_HOST || url.pathname !== "/api/internal/kilo-db-bootstrap") {
      return new Response(null, { status: 404 })
    }
    const envelope = await encryptedCredentials()
    if (!envelope) {
      return Response.json({ ready: false }, { status: 503 })
    }
    return Response.json(envelope, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    })
  },
})
