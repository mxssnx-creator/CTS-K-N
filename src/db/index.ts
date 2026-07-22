import { drizzle } from "drizzle-orm/sqlite-proxy"

import { createKiloDatabaseQuery } from "@/lib/kilo-database-client"

import * as schema from "./schema"

export const executeKiloDatabaseQuery = createKiloDatabaseQuery()

export const db = drizzle(
  async (sql, params, method) => {
    const result = await executeKiloDatabaseQuery(sql, params, method)
    return { rows: result.rows }
  },
  { schema },
)
