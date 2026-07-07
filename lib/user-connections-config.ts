/**
 * User Exchange Connections Configuration
 * 
 * This file contains pre-configured exchange API credentials.
 * These connections can be quickly imported into the system.
 * 
 * SECURITY NOTE: In production, store credentials in environment variables
 * or use a secure secrets manager. This file should be added to .gitignore.
 */

export interface UserConnectionConfig {
  id: string
  name: string
  exchange: string
  displayName: string
  apiType: string
  connectionType: string
  apiKey: string
  apiSecret: string
  isTestnet: boolean
  marginType?: string
  positionMode?: string
  maxLeverage?: number
  documentation?: {
    npm?: string
    pip?: string
    official?: string
  }
  installCommands?: {
    npm?: string
    pip?: string
  }
}

export const USER_CONNECTIONS: UserConnectionConfig[] = [
  // Bybit X03 is available for manual addition — not auto-assigned to Main Connections.
  {
    id: "bybit-x03-unified",
    name: "X03",
    exchange: "bybit",
    displayName: "Bybit X03 (Unified)",
    apiType: "unified_trading",
    connectionType: "Unified",
    apiKey: "4Gba1MjGbrTTfDAauP",
    apiSecret: "QYtOgsHZThh3koyBUDK0DCMUjq3ihmD7YBB2",
    isTestnet: false,
    marginType: "cross",
    positionMode: "hedge",
    maxLeverage: 100,
    documentation: {
      npm: "https://www.npmjs.com/package/bybit-api/v/3.10.32",
      pip: "https://github.com/bybit-exchange/pybit",
      official: "https://bybit-exchange.github.io/docs/v5/intro",
    },
    installCommands: {
      npm: "npm install --save bybit-api",
      pip: "pip install pybit",
    },
  },
  {
    id: "bingx-x01-futures",
    name: "X01",
    exchange: "bingx",
    displayName: "BingX X01 (Futures)",
    apiType: "futures",
    connectionType: "Futures",
    apiKey: "5MdpxA3eWbqSH3JZ5w6cdCK3Sd19Z2mPiNpmfAPfa5kmPB5bquHn8D8qDXzx2HhnyRLmrCQgpphI8DbLLZQw",
    apiSecret: "5uRfPgalVBD9DFAD5McQfbpAWmtiYGiinwiWSMX4Bii9SNPigJXsM1KnLCXT1reH5Wzcvj6RQmIvJrCUgaIhuw",
    isTestnet: false,
    marginType: "cross",
    positionMode: "hedge",
    maxLeverage: 150,
    documentation: {
      npm: "https://github.com/mnguyenz/bingx-api",
      pip: "https://github.com/ccxt/bingx-python",
      official: "https://bingx-api.github.io/docs/#/en-us/swapV2/introduce",
    },
    installCommands: {
      npm: "npm install bingx-trading-api",
      pip: "pip install bingx",
    },
  },
  {
    id: "pionex-x01-futures",
    name: "X01",
    exchange: "pionex",
    displayName: "Pionex X01 (Futures)",
    apiType: "futures",
    connectionType: "Futures",
    apiKey: "5qYgjSMoB4yZHbyEmvUZXNS9CbxePn8JZPGVPX583dSavuradn5Ph2RBCKhMrZ2A36",
    apiSecret: "BpIL7YjAyXkWIoLWgCw3PMmCCr1uJsIttSA8VMhBMBFcLX3mziuQUM1KQ31S1BYW",
    isTestnet: false,
    marginType: "cross",
    positionMode: "hedge",
    maxLeverage: 100,
    documentation: {
      pip: "https://www.piwheels.org/project/pionex-py/",
      official: "https://pionex-doc.gitbook.io/apidocs/",
    },
    installCommands: {
      pip: "pip install pionex-python",
    },
  },
  {
    id: "orangex-x01-futures",
    name: "X01",
    exchange: "orangex",
    displayName: "OrangeX X01 (Futures)",
    apiType: "futures",
    connectionType: "Futures",
    apiKey: "c0c89d0f",
    apiSecret: "b89147149b54e11e36e1514b",
    isTestnet: false,
    marginType: "cross",
    positionMode: "hedge",
    maxLeverage: 125,
    documentation: {
      official: "https://openapi-docs.orangex.com/",
    },
    installCommands: {
      npm: "From Documentation, REST, Websocket; no Library available",
    },
  },
]

/**
 * Get a user connection by ID
 */
export function getUserConnection(id: string): UserConnectionConfig | undefined {
  return USER_CONNECTIONS.find((conn) => conn.id === id)
}

/**
 * Get all user connections for a specific exchange
 */
export function getUserConnectionsByExchange(exchange: string): UserConnectionConfig[] {
  return USER_CONNECTIONS.filter((conn) => conn.exchange.toLowerCase() === exchange.toLowerCase())
}

/**
 * Check if a user connection exists
 */
export function hasUserConnection(id: string): boolean {
  return USER_CONNECTIONS.some((conn) => conn.id === id)
}
