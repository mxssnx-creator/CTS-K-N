jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(),
  getRedisClient: jest.fn(),
  getAllConnections: jest.fn(),
  setSettings: jest.fn(),
  getSettings: jest.fn(),
}))

jest.mock("@/lib/redis-migrations", () => ({
  getMigrationStatus: jest.fn(),
  runMigrations: jest.fn(),
}))

import { validateDatabase } from "@/lib/database-validator"
import {
  getAllConnections,
  getRedisClient,
  getSettings,
} from "@/lib/redis-db"
import {
  getMigrationStatus,
  runMigrations,
} from "@/lib/redis-migrations"

const mockGetAllConnections = getAllConnections as jest.MockedFunction<typeof getAllConnections>
const mockGetRedisClient = getRedisClient as jest.MockedFunction<typeof getRedisClient>
const mockGetSettings = getSettings as jest.MockedFunction<typeof getSettings>
const mockGetMigrationStatus = getMigrationStatus as jest.MockedFunction<typeof getMigrationStatus>
const mockRunMigrations = runMigrations as jest.MockedFunction<typeof runMigrations>

describe("database validator migration contract", () => {
  const client = {
    smembers: jest.fn(),
    sadd: jest.fn(),
    hgetall: jest.fn(),
    hset: jest.fn(),
    keys: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetRedisClient.mockReturnValue(client as never)
    mockGetAllConnections.mockResolvedValue([
      { id: "conn-1", name: "Primary", exchange: "bingx" } as never,
    ])
    mockGetSettings.mockResolvedValue({ initialized: "1" } as never)
    client.smembers.mockResolvedValue(["conn-1"])
    client.hgetall.mockResolvedValue({ status: "stopped" })
    client.keys.mockImplementation(async (pattern: string) => (
      pattern === "market_data:*" ? ["market_data:BTCUSDT"] : []
    ))
    mockRunMigrations.mockResolvedValue({ success: true, version: 70 } as never)
  })

  it("accepts the canonical schema/health status without a legacy status key", async () => {
    mockGetMigrationStatus.mockResolvedValue({
      currentVersion: 70,
      latestVersion: 70,
      isMigrated: true,
    })

    const result = await validateDatabase()

    expect(result.valid).toBe(true)
    expect(result.errors).not.toContain("Migration status not found")
    expect(mockRunMigrations).not.toHaveBeenCalled()
  })

  it("repairs pending migrations and verifies readiness again", async () => {
    mockGetMigrationStatus
      .mockResolvedValueOnce({ currentVersion: 69, latestVersion: 70, isMigrated: false })
      .mockResolvedValueOnce({ currentVersion: 70, latestVersion: 70, isMigrated: true })

    const result = await validateDatabase()

    expect(mockRunMigrations).toHaveBeenCalledTimes(1)
    expect(result.valid).toBe(true)
    expect(result.repairs).toEqual(expect.arrayContaining([expect.stringContaining("v69 -> v70")]))
    expect(result.errors).toEqual([])
  })

  it("fails validation when migration readiness is still incomplete after repair", async () => {
    mockGetMigrationStatus.mockResolvedValue({
      currentVersion: 69,
      latestVersion: 70,
      isMigrated: false,
    })

    const result = await validateDatabase()

    expect(mockRunMigrations).toHaveBeenCalledTimes(1)
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([expect.stringContaining("v69/70")])
  })
})
