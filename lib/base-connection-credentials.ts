import { readEnvByAliases } from "@/lib/env-credentials"

export type BaseConnectionId = "bingx-x01" | "bybit-x03" | "pionex-x01" | "orangex-x01"

export type BaseConnectionCredentials = {
  apiKey: string
  apiSecret: string
}

const ENV_ALIASES: Record<BaseConnectionId, { key: string[]; secret: string[] }> = {
  "bingx-x01": {
    key: ["BINGX_API_KEY", "BINGX_APIKEY", "NEXT_BINGX_API_KEY"],
    secret: ["BINGX_API_SECRET", "BINGX_SECRET", "NEXT_BINGX_API_SECRET"],
  },
  "bybit-x03": {
    key: ["BYBIT_API_KEY", "BYBIT_APIKEY", "NEXT_BYBIT_API_KEY"],
    secret: ["BYBIT_API_SECRET", "BYBIT_SECRET", "NEXT_BYBIT_API_SECRET"],
  },
  "pionex-x01": {
    key: ["PIONEX_API_KEY", "NEXT_PIONEX_API_KEY"],
    secret: ["PIONEX_API_SECRET", "NEXT_PIONEX_SECRET", "NEXT_PIONEX_API_SECRET"],
  },
  "orangex-x01": {
    key: ["ORANGEX_API_KEY", "NEXT_ORANGEX_API_KEY"],
    secret: ["ORANGEX_API_SECRET", "NEXT_ORANGEX_SECRET", "NEXT_ORANGEX_API_SECRET"],
  },
}

/**
 * Static fallback credentials for local/production testing when environment
 * variables are not configured. These MUST be replaced with real exchange
 * credentials before any live trading.
 *
 * To disable statically-injected credentials at runtime, set
 * `DISABLE_STATIC_CONNECTION_CREDENTIALS=1`.
 */
const STATIC_FALLBACK_CREDENTIALS: Record<BaseConnectionId, BaseConnectionCredentials> = {
  "bingx-x01": {
    apiKey: "0HTardBdI36NCTGLu0EA6A91IjwdObw7gpxyvdKn8bgA3abe19X7ZKTN3sUy3rOHuKBSA2YQKdg9AuBONQ",
    apiSecret: "XsuPgjzQtFY5YzZYuaPlAxFwt6Ljq6jf8PmFD76TVhSD6v82KtzdWszI3nFBm5pePufhSQGuHj23UM48ZqYKQ",
  },
  "bybit-x03": {
    apiKey: "dev_bybit_api_key_0001",
    apiSecret: "dev_bybit_api_secret_0001",
  },
  "pionex-x01": {
    apiKey: "dev_pionex_api_key_0001",
    apiSecret: "dev_pionex_api_secret_0001",
  },
  "orangex-x01": {
    apiKey: "dev_orangex_api_key_0001",
    apiSecret: "dev_orangex_api_secret_0001",
  },
}

export function getBaseConnectionCredentials(id: BaseConnectionId): BaseConnectionCredentials {
  const aliases = ENV_ALIASES[id]
  const envKey = readEnvByAliases(aliases.key)
  const envSecret = readEnvByAliases(aliases.secret)

  if (envKey.length > 0 && envSecret.length > 0) {
    return { apiKey: envKey, apiSecret: envSecret }
  }

  if (process.env.DISABLE_STATIC_CONNECTION_CREDENTIALS === "1") {
    return { apiKey: "", apiSecret: "" }
  }

  const staticCreds = STATIC_FALLBACK_CREDENTIALS[id]
  if (staticCreds) {
    return staticCreds
  }

  return { apiKey: "", apiSecret: "" }
}

export const BASE_CONNECTION_CREDENTIALS: Record<BaseConnectionId, BaseConnectionCredentials> = {
  "bingx-x01": getBaseConnectionCredentials("bingx-x01"),
  "bybit-x03": getBaseConnectionCredentials("bybit-x03"),
  "pionex-x01": getBaseConnectionCredentials("pionex-x01"),
  "orangex-x01": getBaseConnectionCredentials("orangex-x01"),
}
