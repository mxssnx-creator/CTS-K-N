const BINGX_KEY_ALIASES = ["BINGX_API_KEY", "BINGX_APIKEY", "NEXT_BINGX_API_KEY"]
const BINGX_SECRET_ALIASES = ["BINGX_API_SECRET", "BINGX_SECRET_KEY", "BINGX_SECRET", "NEXT_BINGX_API_SECRET"]

function cleanEnvValue(raw: string | undefined): string {
  if (!raw) return ""
  return raw.trim().replace(/^['\"]|['\"]$/g, "")
}

export function readEnvByAliases(aliases: string[]): string {
  // Credential isolation between connections (e.g. bingx-x01 vs bingx-x02)
  // depends on each connection's aliases resolving independently and on an
  // operator/test being able to make a credential genuinely absent. A dotenv
  // file fallback (previously read from `.env*.local` here) defeats both
  // guarantees: it silently resurrects whatever value is on disk regardless
  // of what the caller intended for *this* connection, and it cannot be
  // overridden by deleting `process.env[key]` (the standard way to signal
  // "this credential is not configured"). `process.env` is the single source
  // of truth for credentials — Next.js already loads project env files into
  // `process.env` before this code runs, so a separate dotenv read only
  // reintroduces stale or cross-connection values without adding real
  // capability.
  for (const key of aliases) {
    const value = cleanEnvValue(process.env[key])
    if (value.length > 0) return value
  }
  return ""
}

export function readBingxCredentialsFromEnv(): { apiKey: string; apiSecret: string; hasCredentials: boolean } {
  const apiKey = readEnvByAliases(BINGX_KEY_ALIASES)
  const apiSecret = readEnvByAliases(BINGX_SECRET_ALIASES)
  const hasCredentials = apiKey.length > 10 && apiSecret.length > 10
  return { apiKey, apiSecret, hasCredentials }
}
