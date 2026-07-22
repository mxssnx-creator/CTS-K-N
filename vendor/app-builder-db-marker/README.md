# Kilo managed-database provisioning marker

Kilo App Builder provisions its per-project SQLite store by checking whether
`@kilocode/app-builder-db` is present in `package.json`. CTS uses the same HTTP
query protocol through `lib/kilo-database-client.ts`, avoiding a Git-hosted
runtime dependency, but retains this local package so App Builder still creates
and injects `DB_URL` and `DB_TOKEN` for previews.

No application code imports this marker.
