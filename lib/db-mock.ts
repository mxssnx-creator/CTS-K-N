/**
 * Mock Database Module - Used in dev/preview environments
 * Provides in-memory database implementation with no native dependencies
 */

export const mockDb = {
  prepare: (sql: string) => ({
    run: (...params: any[]) => ({ changes: 0, lastInsertRowid: 0 }),
    get: (...params: any[]) => undefined,
    all: (...params: any[]) => [],
    finalize: () => {},
  }),
  exec: (sql: string) => [],
  pragma: (pragma: string) => ({ value: "" }),
  close: () => {},
}

export function getMockPool() {
  return {
    query: async (sql: string, params: any[]) => ({ rows: [] }),
    connect: async () => ({
      query: async (sql: string, params: any[]) => ({ rows: [] }),
      release: () => {},
    }),
    end: async () => {},
  }
}

export const mockClient = {
  sqlite: mockDb,
  postgresql: getMockPool(),
}

export default mockClient
