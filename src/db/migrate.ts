import { migrate as drizzleMigrate } from "drizzle-orm/sqlite-proxy/migrator"

function hasManagedDatabaseConfiguration(): boolean {
  return Boolean(process.env.DB_URL?.trim() && process.env.DB_TOKEN?.trim())
}

function shouldRunManagedDatabaseMigrations(): boolean {
  // Vercel may discover and invoke `db:migrate` while building the Next
  // application. Its deployment has no Kilo managed-DB contract, even if a
  // generic DB_URL happens to be present for another integration. Running the
  // Kilo HTTP-SQLite migrator there makes an otherwise healthy build fail.
  // Kilo's Worker manifest sets both identifiers; a manual operator run may
  // opt in explicitly without weakening the default Vercel build path.
  return (
    process.env.KILO_DEPLOYMENT === "1" ||
    process.env.CTS_DEPLOYMENT_RUNTIME === "kilo-deploy" ||
    process.env.RUN_MANAGED_DB_MIGRATIONS === "1"
  )
}

async function migrate(): Promise<void> {
  // Kilo Deploy invokes package scripts even when the app has not been given a
  // managed database. Redis remains the primary CTS runtime store in that
  // profile, so a missing optional SQLite binding must not make the deploy fail.
  // When Kilo provisions DB_URL/DB_TOKEN, migrations still run before the app
  // starts and a bad migration correctly fails the deploy.
  if (!shouldRunManagedDatabaseMigrations()) {
    console.info("[db:migrate] Skipped: this deployment does not use Kilo managed SQLite.")
    return
  }

  if (!hasManagedDatabaseConfiguration()) {
    console.info("[db:migrate] Skipped: DB_URL and DB_TOKEN are not configured.")
    return
  }

  console.info("[db:migrate] Applying managed SQLite migrations.")
  // `createDatabase` validates DB_URL/DB_TOKEN eagerly, so defer importing it
  // until after the no-database deployment profile has been handled.
  const { db, executeKiloDatabaseQuery } = await import("./index")
  await drizzleMigrate(
    db,
    async (queries) => {
      for (const query of queries) {
        await executeKiloDatabaseQuery(query, [], "run")
      }
    },
    { migrationsFolder: "./src/db/migrations" },
  )
  console.info("[db:migrate] Managed SQLite migrations completed.")
}

void migrate().catch((error) => {
  console.error("Kilo database migration failed", error)
  process.exitCode = 1
})
