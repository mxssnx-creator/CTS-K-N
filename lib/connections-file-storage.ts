/**
 * File-based connections storage - replaces Redis
 * Stores connections in a JSON file in the data directory
 */

import type { ExchangeConnection } from "@/lib/types"

let connectionsCache: ExchangeConnection[] | null = null

function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && typeof process.cwd === "function" && typeof require !== "undefined"
}

async function getFilePaths() {
  const path = (await import("path")).default || await import("path")
  const cwd = typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : "/tmp"
  const dataDir =
    (typeof process !== "undefined" && (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME))
      ? path.join("/tmp", "cts-data")
      : path.join(cwd, "data")
  return { dataDir, connectionsFile: path.join(dataDir, "connections.json") }
}

async function readFromDisk(): Promise<ExchangeConnection[] | null> {
  if (!isNodeRuntime()) return null
  try {
    const fs = (await import("fs")).default || await import("fs")
    const { dataDir, connectionsFile } = await getFilePaths()

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    if (!fs.existsSync(connectionsFile)) {
      return null
    }

    const data = fs.readFileSync(connectionsFile, "utf-8")
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function writeToDisk(connections: ExchangeConnection[]): Promise<void> {
  if (!isNodeRuntime()) return
  try {
    const fs = (await import("fs")).default || await import("fs")
    const { dataDir, connectionsFile } = await getFilePaths()

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    fs.writeFileSync(connectionsFile, JSON.stringify(connections, null, 2), "utf-8")
  } catch (error) {
    console.warn("[v0] Could not write connections to disk:", error)
  }
}

export async function getAllConnections(): Promise<ExchangeConnection[]> {
  if (connectionsCache) {
    return [...connectionsCache]
  }

  try {
    const diskConnections = await readFromDisk()
    if (diskConnections) {
      connectionsCache = diskConnections
      return [...diskConnections]
    }
  } catch {
    // Ignore - Edge runtime or other non-Node environment
  }

  return []
}

export async function getConnection(id: string): Promise<ExchangeConnection | null> {
  const connections = await getAllConnections()
  return connections.find((c) => c.id === id) || null
}

export async function createConnection(connection: ExchangeConnection): Promise<void> {
  const connections = await getAllConnections()
  
  // Avoid duplicates
  const existingIndex = connections.findIndex((c) => c.id === connection.id)
  if (existingIndex >= 0) {
    connections[existingIndex] = connection
  } else {
    connections.push(connection)
  }

  connectionsCache = connections
  await writeToDisk(connections)
}

export async function updateConnection(id: string, updates: Partial<ExchangeConnection>): Promise<void> {
  const connections = await getAllConnections()
  const index = connections.findIndex((c) => c.id === id)
  
  if (index >= 0) {
    connections[index] = { ...connections[index], ...updates }
    connectionsCache = connections
    await writeToDisk(connections)
  }
}

export async function deleteConnection(id: string): Promise<void> {
  const connections = await getAllConnections()
  const filtered = connections.filter((c) => c.id !== id)
  
  connectionsCache = filtered
  await writeToDisk(filtered)
}

export async function filterConnections(
  filters: {
    exchange?: string
    apiType?: string
    enabled?: boolean
    active?: boolean
  },
): Promise<ExchangeConnection[]> {
  let connections = await getAllConnections()

  if (filters.exchange) {
    connections = connections.filter((c) => c.exchange?.toLowerCase() === filters.exchange?.toLowerCase())
  }

  if (filters.apiType) {
    connections = connections.filter((c) => c.api_type === filters.apiType)
  }

  if (filters.enabled !== undefined) {
    connections = connections.filter((c) => Boolean(c.is_enabled) === filters.enabled)
  }

  if (filters.active !== undefined) {
    connections = connections.filter((c) => Boolean(c.is_active) === filters.active)
  }

  return connections
}

export async function initializeConnections(predefinedConnections: ExchangeConnection[]): Promise<void> {
  const existing = await getAllConnections()
  
  if (existing.length === 0 && predefinedConnections.length > 0) {
    connectionsCache = predefinedConnections
    await writeToDisk(predefinedConnections)
  }
}
