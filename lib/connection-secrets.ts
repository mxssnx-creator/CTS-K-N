import { normalizeMarketType } from "@/lib/market-types"
import {
  isForexBridgeSelected,
  isValidForexBridgeUrl,
  resolveForexExecutionMode,
} from "@/lib/forex-market"

const CONNECTION_SECRET_FIELDS = [
  "api_key",
  "api_secret",
  "api_passphrase",
  "api_key_secret",
  "apiKey",
  "apiSecret",
  "apiPassphrase",
  "secret_key",
  "secretKey",
  "passphrase",
  "account_password",
  "accountPassword",
  "trading_password",
  "tradingPassword",
  "trader_password",
  "traderPassword",
  "mt5_password",
  "mt5Password",
  "bridge_token",
  "bridgeToken",
] as const

const CONNECTION_SECRET_FIELD_SET = new Set<string>(CONNECTION_SECRET_FIELDS)

function isUsableStoredSecret(value: unknown): boolean {
  if (typeof value !== "string") return false
  const normalized = value.trim()
  return normalized.length > 0 &&
    !normalized.includes("••••") &&
    !/placeholder|changeme|your[_ -]?(api|secret)/i.test(normalized)
}

export interface ConnectionCredentialStatus {
  credentials_configured: boolean
  api_key_configured: boolean
  api_secret_configured: boolean
  api_passphrase_configured: boolean
  account_id_configured: boolean
  account_password_configured: boolean
  bridge_token_configured: boolean
  bridge_configured: boolean
}

/** Public metadata that lets the UI distinguish stored secrets from blanks. */
export function getConnectionCredentialStatus(
  connection: Record<string, any>,
): ConnectionCredentialStatus {
  const apiKeyConfigured = isUsableStoredSecret(connection.api_key ?? connection.apiKey)
  const apiSecretConfigured = isUsableStoredSecret(connection.api_secret ?? connection.apiSecret)
  const apiPassphraseConfigured = isUsableStoredSecret(
    connection.api_passphrase ?? connection.apiPassphrase ?? connection.passphrase,
  )
  const isForex = normalizeMarketType(
    connection.market_type ?? connection.asset_class,
    connection.exchange,
  ) === "forex"
  const accountId = String(connection.account_id ?? connection.accountId ?? (isForex ? (connection.api_key ?? connection.apiKey ?? "") : "")).trim()
  const accountIdConfigured = /^[0-9]{4,12}$/.test(accountId)
  const accountPasswordConfigured = isUsableStoredSecret(
    connection.account_password ?? connection.accountPassword ?? connection.trading_password ?? connection.trader_password ?? connection.mt5_password ?? connection.mt5Password,
  )
  const bridgeTokenConfigured = isUsableStoredSecret(connection.bridge_token ?? connection.bridgeToken)
  const bridgeUrl = String(connection.bridge_url ?? connection.bridgeUrl ?? "").trim()
  const bridgeMode = resolveForexExecutionMode(connection)
  const bridgeConfigured = isForex &&
    isForexBridgeSelected(connection) &&
    bridgeMode === "mt5_bridge" &&
    accountIdConfigured &&
    accountPasswordConfigured &&
    isValidForexBridgeUrl(bridgeUrl)
  return {
    credentials_configured: isForex ? accountIdConfigured : apiKeyConfigured && apiSecretConfigured,
    api_key_configured: apiKeyConfigured,
    api_secret_configured: apiSecretConfigured,
    api_passphrase_configured: apiPassphraseConfigured,
    account_id_configured: accountIdConfigured,
    account_password_configured: accountPasswordConfigured,
    bridge_token_configured: bridgeTokenConfigured,
    bridge_configured: bridgeConfigured,
  }
}

export function maskConnectionSecret(value: unknown): unknown {
  return typeof value === "string" && value.length > 4
    ? `••••${value.slice(-4)}`
    : value
      ? "••••"
      : value
}

function maskSecretsDeep(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (Array.isArray(value)) return value.map((entry) => maskSecretsDeep(entry, seen))
  if (!value || typeof value !== "object") return value
  const object = value as Record<string, unknown>
  const existing = seen.get(object)
  if (existing) return existing
  const safe: Record<string, unknown> = {}
  seen.set(object, safe)
  for (const [field, fieldValue] of Object.entries(object)) {
    if (CONNECTION_SECRET_FIELD_SET.has(field)) {
      safe[field] = maskConnectionSecret(fieldValue)
      continue
    }
    if (typeof fieldValue === "string" && /^[{[]/.test(fieldValue.trim())) {
      try {
        safe[field] = JSON.stringify(maskSecretsDeep(JSON.parse(fieldValue), new WeakMap()))
        continue
      } catch { /* ordinary string */ }
    }
    safe[field] = maskSecretsDeep(fieldValue, seen)
  }
  return safe
}

/** Return a UI-safe connection/settings snapshot without exposing credentials. */
export function maskConnectionSecrets<T extends Record<string, any>>(connection: T): T {
  const credentialStatus = getConnectionCredentialStatus(connection)
  const safe = maskSecretsDeep(connection, new WeakMap()) as T
  const safeRecord = safe as Record<string, any>
  Object.assign(safeRecord, credentialStatus)
  // Some legacy rows keep the settings envelope as serialized JSON. Redact it
  // too while preserving the string storage shape expected by old clients.
  const serializedSettings = safeRecord.connection_settings
  if (typeof serializedSettings === "string" && serializedSettings.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(serializedSettings)
      safeRecord.connection_settings = JSON.stringify(maskSecretsDeep(parsed, new WeakMap()))
    } catch { /* malformed legacy settings are returned unchanged */ }
  }
  return safe
}

export function maskConnectionSettings<T>(settings: T): T {
  return maskSecretsDeep(settings, new WeakMap()) as T
}

/** Masked values returned by GET are placeholders, never credential updates. */
export function isMaskedOrEmptyConnectionSecret(value: unknown): boolean {
  return typeof value === "string" && (value.trim() === "" || value.includes("••••"))
}

export function preserveMaskedConnectionSecrets(
  patch: Record<string, any>,
  existing: Record<string, any>,
): Record<string, any> {
  const sanitized = { ...patch }
  for (const field of CONNECTION_SECRET_FIELDS) {
    if (existing[field] && isMaskedOrEmptyConnectionSecret(sanitized[field])) delete sanitized[field]
  }
  return sanitized
}
