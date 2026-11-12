import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

/** Persist one complete private recovery snapshot before a potentially ambiguous venue write. */
export function writeVstSoakCheckpoint(path: string, report: unknown, secrets: readonly string[] = []): void {
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (secrets.some(secret => secret.length > 0 && serialized.includes(secret))) {
    throw new Error("Credential redaction invariant failed; refusing to write the soak report")
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, "wx", 0o600)
    writeFileSync(fd, serialized, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    const directory = openSync(dirname(path), "r")
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch { /* already renamed or never created */ }
  }
}

const REQUEST_FIELDS = new Set([
  "symbol", "side", "positionSide", "type", "quantity", "stopPrice", "price",
  "orderId", "clientOrderID", "clientOrderId", "reduceOnly", "workingType",
])

/** Keep query and body identities separate; never copy signed URLs, auth headers, or secrets. */
export function vstSoakRequestEvidence(url: URL, body?: unknown): {
  query: Record<string, string>; body: Record<string, string | number | boolean>
} {
  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams) if (REQUEST_FIELDS.has(key)) query[key] = value
  const fields: Record<string, string | number | boolean> = {}
  let parsed: unknown = null
  if (typeof body === "string") {
    try { parsed = JSON.parse(body) } catch { parsed = Object.fromEntries(new URLSearchParams(body)) }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (REQUEST_FIELDS.has(key) && ["string", "number", "boolean"].includes(typeof value)) {
        fields[key] = value as string | number | boolean
      }
    }
  }
  return { query, body: fields }
}
