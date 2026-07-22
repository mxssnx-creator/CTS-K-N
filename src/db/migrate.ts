import { runMigrations } from "@kilocode/app-builder-db"

function hasManagedDatabaseConfiguration(): boolean {
  return Boolean(process.env.DB_URL?.trim() && process.env.DB_TOKEN?.trim())
}

async function migrate(): Promise<void> {
  // Kilo Deploy invokes package scripts even when the app has not been given a
  // managed database. Redis remains the primary CTS runtime store in that
  // profile, so a missing optional SQLite binding must not make the deploy fail.
  // When Kilo provisions DB_URL/DB_TOKEN, migrations still run before the app
  // starts and a bad migration correctly fails the deploy.
  if (!hasManagedDatabaseConfiguration()) {
    console.info("[db:migrate] Skipped: DB_URL and DB_TOKEN are not configured.")
    return
  }

  console.info("[db:migrate] Applying managed SQLite migrations.")
  // `createDatabase` validates DB_URL/DB_TOKEN eagerly, so defer importing it
  // until after the no-database deployment profile has been handled.
  const { db } = await import("./index")
  await runMigrations(db, {}, { migrationsFolder: "./src/db/migrations" })
  console.info("[db:migrate] Managed SQLite migrations completed.")
}

void migrate().catch((error) => {
  console.error("Kilo database migration failed", error)
  process.exitCode = 1
})
