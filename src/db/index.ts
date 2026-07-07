import { createDatabase, runMigrations } from "@kilocode/app-builder-db";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";

export type Database = SqliteRemoteDatabase<typeof schema>;

const MIGRATIONS_FOLDER = "./src/db/migrations";

let client: Database | null = null;

function getClient(): Database {
  if (!client) client = createDatabase(schema);
  return client;
}

/**
 * Lazy database client. The underlying client is created on first access
 * (i.e. at request time, when DB_URL/DB_TOKEN are present), NOT at module
 * import. This prevents `next build` page-data collection and dev/prod module
 * loading from throwing "Missing database configuration" before the runtime
 * environment variables exist. Method access is bound to the real client so
 * `this` stays correct.
 */
export const db = new Proxy({} as Database, {
  get(_target, prop, _receiver) {
    const instance = getClient();
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

const globalForDb = globalThis as unknown as {
  __coordinatorDbReady?: Promise<void> | null;
};

/**
 * Startup coordinator: ensures the database schema is migrated exactly once per
 * process. In development this survives HMR; in production it prevents the
 * "table does not exist" crashes that occur when a freshly-started server
 * handles requests before migrations have run. Memoized so concurrent requests
 * share a single migration run.
 */
export function ensureDatabase(): Promise<void> {
  if (!globalForDb.__coordinatorDbReady) {
    globalForDb.__coordinatorDbReady = runMigrations(db, {}, { migrationsFolder: MIGRATIONS_FOLDER })
      .then(() => undefined)
      .catch((error) => {
        globalForDb.__coordinatorDbReady = null;
        throw error;
      });
  }
  return globalForDb.__coordinatorDbReady;
}
