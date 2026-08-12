import { readEnvByAliases } from "@/lib/env-credentials"

export type BaseConnectionId = "bingx-x01" | "bingx-x02" | "bybit-x03" | "pionex-x01" | "orangex-x01"

export type BaseConnectionCredentials = {
  apiKey: string
  apiSecret: string
}

const ENV_ALIASES: Record<BaseConnectionId, { key: string[]; secret: string[] }> = {
  "bingx-x01": {
    key: ["BINGX_API_KEY", "BINGX_APIKEY", "NEXT_BINGX_API_KEY"],
    secret: ["BINGX_API_SECRET", "BINGX_SECRET_KEY", "BINGX_SECRET", "NEXT_BINGX_API_SECRET"],
  },
  // X02 is the dedicated BingX Prod-VST connection. It intentionally uses
  // distinct variables so demo credentials can never be injected into X01.
  "bingx-x02": {
    key: ["BINGX_X02_API_KEY"],
    secret: ["BINGX_X02_API_SECRET"],
  },
  "bybit-x03": {
    key: ["BYBIT_API_KEY", "BYBIT_APIKEY", "NEXT_BYBIT_API_KEY"],
    secret: ["BYBIT_API_SECRET", "BYBIT_SECRET_KEY", "BYBIT_SECRET", "NEXT_BYBIT_API_SECRET"],
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

export function getBaseConnectionCredentials(id: BaseConnectionId): BaseConnectionCredentials {
  const aliases = ENV_ALIASES[id]
  const envKey = readEnvByAliases(aliases.key)
  const envSecret = readEnvByAliases(aliases.secret)

  if (envKey.length > 0 && envSecret.length > 0) {
    return { apiKey: envKey, apiSecret: envSecret }
  }

  // Credentials are intentionally never embedded in source or client-side
  // connection templates. Missing server environment values keep live
  // execution fail-closed while simulated mode remains independently usable.
  return { apiKey: "", apiSecret: "" }
}

export const BASE_CONNECTION_CREDENTIALS: Record<BaseConnectionId, BaseConnectionCredentials> = {
  "bingx-x01": getBaseConnectionCredentials("bingx-x01"),
  "bingx-x02": getBaseConnectionCredentials("bingx-x02"),
  "bybit-x03": getBaseConnectionCredentials("bybit-x03"),
  "pionex-x01": getBaseConnectionCredentials("pionex-x01"),
  "orangex-x01": getBaseConnectionCredentials("orangex-x01"),
}
