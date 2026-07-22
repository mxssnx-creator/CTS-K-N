import { sql } from "drizzle-orm"
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Singleton checkpoint used by the Kilo request workers. The payload contains
 * the bounded Redis-compatible runtime snapshot; revision is the optimistic
 * concurrency token and the lease columns serialize mutating engine cycles.
 */
export const ctsRuntimeSnapshot = sqliteTable(
  "cts_runtime_snapshot",
  {
    id: integer("id").primaryKey(),
    revision: integer("revision").notNull().default(0),
    payload: text("payload").notNull(),
    updatedAt: integer("updated_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseScope: text("lease_scope"),
    leaseUntil: integer("lease_until"),
  },
  (table) => [check("cts_runtime_snapshot_singleton", sql`${table.id} = 1`)],
)
