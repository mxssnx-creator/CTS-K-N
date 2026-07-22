import { runMigrations } from "@kilocode/app-builder-db"

import { db } from "./index"

async function migrate(): Promise<void> {
  await runMigrations(db, {}, { migrationsFolder: "./src/db/migrations" })
}

void migrate().catch((error) => {
  console.error("Kilo database migration failed", error)
  process.exitCode = 1
})
