/**
 * SQL Error Handler Utility
 * Gracefully handles calls to missing SQL queries during Redis-only operation
 * Provides sensible defaults instead of throwing errors
 */

export const sqlErrorHandler = {
  /**
   * Safe query execution wrapper
   * Returns default/empty results instead of throwing for missing SQL
   */
  async safeQuery<T>(queryName: string, fallbackValue: T): Promise<T> {
    try {
      // If we reach here, the SQL client doesn't exist
      console.warn(`[v0] SQL query "${queryName}" not available in Redis-only mode. Using fallback.`)
      return fallbackValue
    } catch (error) {
      console.warn(`[v0] SQL query "${queryName}" failed:`, error)
      return fallbackValue
    }
  },

  /**
   * Default handlers for common query types
   */
  defaults: {
    emptyArray: () => [],
    emptyObject: () => ({}),
    zeroCount: () => 0,
    falseValue: () => false,
    nullValue: () => null,
  },

  /**
   * Wrap async functions that depend on SQL
   */
  async wrapAsync<T>(
    fn: () => Promise<T>,
    fallbackValue: T,
    context: string = "unknown",
  ): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof ReferenceError && error.message.includes("sql")) {
        console.warn(`[v0] SQL dependency in ${context} not available. Using fallback.`)
        return fallbackValue
      }
      throw error
    }
  },
}
