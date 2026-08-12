const SECRET_FIELD = /^(api_?key|api_?secret|api_?passphrase|apiKey|apiSecret|apiPassphrase|secret_?key|secretKey|passphrase)$/i
const RUNTIME_CONNECTION_FIELD = /^(last_test_|last_error|last_balance|runtime_|health|status$|created_at$|updated_at$)/i

export const SETTINGS_BACKUP_SCHEMA = "cts-settings-backup"
export const SETTINGS_BACKUP_VERSION = 1

export interface SettingsBackupDocument {
  schema: typeof SETTINGS_BACKUP_SCHEMA
  version: typeof SETTINGS_BACKUP_VERSION
  exportedAt: string
  security: { credentialsIncluded: false }
  settings: Record<string, unknown>
  connections: Array<Record<string, unknown>>
}

function copyWithoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyWithoutSecrets)
  if (!value || typeof value !== "object") return value
  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key)) continue
    output[key] = copyWithoutSecrets(nested)
  }
  return output
}

export function buildSettingsBackup(
  settings: Record<string, unknown>,
  connections: Array<Record<string, unknown>>,
  exportedAt = new Date().toISOString(),
): SettingsBackupDocument {
  return {
    schema: SETTINGS_BACKUP_SCHEMA,
    version: SETTINGS_BACKUP_VERSION,
    exportedAt,
    security: { credentialsIncluded: false },
    settings: copyWithoutSecrets(settings) as Record<string, unknown>,
    connections: connections.map((connection) => {
      const safe = copyWithoutSecrets(connection) as Record<string, unknown>
      for (const key of Object.keys(safe)) {
        if (RUNTIME_CONNECTION_FIELD.test(key) || key.endsWith("_configured")) delete safe[key]
      }
      return safe
    }),
  }
}

export function parseSettingsBackup(value: unknown): SettingsBackupDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Backup must be a JSON object")
  }
  const input = value as Record<string, unknown>
  if (input.schema !== SETTINGS_BACKUP_SCHEMA || input.version !== SETTINGS_BACKUP_VERSION) {
    throw new Error(`Unsupported settings backup schema/version`)
  }
  if (!input.settings || typeof input.settings !== "object" || Array.isArray(input.settings)) {
    throw new Error("Backup settings snapshot is missing")
  }
  if (!Array.isArray(input.connections)) throw new Error("Backup connections list is missing")
  return buildSettingsBackup(
    input.settings as Record<string, unknown>,
    input.connections.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)),
    typeof input.exportedAt === "string" ? input.exportedAt : new Date().toISOString(),
  )
}

/** Existing connection IDs are identities; imports can only update safe configuration fields. */
export function importedConnectionPatch(connection: Record<string, unknown>): Record<string, unknown> {
  const safe = copyWithoutSecrets(connection) as Record<string, unknown>
  for (const key of Object.keys(safe)) {
    if (["id", "exchange", "environment", "base_url", "is_testnet", "is_predefined"].includes(key) ||
        RUNTIME_CONNECTION_FIELD.test(key) || key.endsWith("_configured")) {
      delete safe[key]
    }
  }
  return safe
}
