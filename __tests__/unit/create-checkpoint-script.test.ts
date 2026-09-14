import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const SCRIPT = resolve(process.cwd(), "scripts/create-checkpoint.sh")

const ENV = { ...process.env, LC_ALL: "C", CTS_CHECKPOINT_ROOT: "", CTS_CHECKPOINT_MAX_TOTAL_BYTES: "" }

function sh(args: string[], cwd: string, env: NodeJS.ProcessEnv = ENV): string {
  return execFileSync("bash", [SCRIPT, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env })
}

// stdout and stderr merged, for asserting on retention messages.
function shAll(args: string[], cwd: string, env: NodeJS.ProcessEnv = ENV): string {
  const quoted = [SCRIPT, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")
  return execFileSync("bash", ["-c", `bash ${quoted} 2>&1`], { cwd, encoding: "utf8", env })
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function makeRepo(base: string): string {
  const repo = join(base, "checkout")
  mkdirSync(repo)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "test@example.invalid")
  git(repo, "config", "user.name", "checkpoint test")
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.next/\n.env*\n")
  writeFileSync(join(repo, "tracked.txt"), "tracked\n")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "initial")
  // Reproducible or secret content that must never be archived.
  mkdirSync(join(repo, "node_modules", "big"), { recursive: true })
  writeFileSync(join(repo, "node_modules", "big", "blob.bin"), Buffer.alloc(2 * 1024 * 1024, 7))
  mkdirSync(join(repo, ".next"), { recursive: true })
  writeFileSync(join(repo, ".next", "build.js"), "// build output\n")
  writeFileSync(join(repo, ".env.production.local"), "SECRET=never\n")
  mkdirSync(join(repo, "credentials"))
  writeFileSync(join(repo, "credentials", "exchange.json"), "{}\n")
  writeFileSync(join(repo, "server.key"), "private\n")
  // Legitimate untracked work plus an uncommitted tracked change.
  writeFileSync(join(repo, "notes.md"), "untracked note\n")
  writeFileSync(join(repo, "tracked.txt"), "tracked changed\n")
  return repo
}

describe("create-checkpoint.sh", () => {
  let base: string
  let repo: string
  let root: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cts-checkpoint-"))
    repo = makeRepo(base)
    root = join(base, "backups")
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it("writes the verified checkpoint layout without ignored or secret content", () => {
    const out = sh(["--project", repo, "--root", root, "--label", "Unit Test!"], repo).trim()
    const entries = readdirSync(root)
    expect(entries).toHaveLength(1)
    const name = entries[0]
    expect(name).toMatch(/^\d{8}T\d{6}Z-Unit-Test$/)
    expect(out).toBe(join(root, name))

    const dir = join(root, name)
    for (const file of [
      "repository.bundle",
      "HEAD.txt",
      "git-status.txt",
      "worktree.patch",
      "index.patch",
      "untracked-files.txt",
      "untracked.tar.gz",
      "untracked-excluded.txt",
      "checkpoint-info",
      "SHA256SUMS",
      "VERIFIED",
    ]) {
      expect(existsSync(join(dir, file))).toBe(true)
    }

    expect(readFileSync(join(dir, "HEAD.txt"), "utf8")).toContain(`head=${git(repo, "rev-parse", "HEAD").trim()}`)
    expect(readFileSync(join(dir, "worktree.patch"), "utf8")).toContain("tracked changed")

    const untracked = readFileSync(join(dir, "untracked-files.txt"), "utf8").trim().split("\n")
    expect(untracked).toEqual(["notes.md"])
    const excluded = readFileSync(join(dir, "untracked-excluded.txt"), "utf8").trim().split("\n").sort()
    expect(excluded).toEqual(["credentials/exchange.json", "server.key"])

    const archived = execFileSync("tar", ["-tzf", join(dir, "untracked.tar.gz")], { encoding: "utf8" })
    expect(archived.trim()).toBe("notes.md")
    expect(archived).not.toContain("node_modules")
    expect(archived).not.toContain(".env")
    expect(archived).not.toContain(".next")

    // The bundle carries every ref and verifies against the checkout.
    expect(() => git(repo, "bundle", "verify", join(dir, "repository.bundle"))).not.toThrow()
    // Manifest verification passes and the whole tree is owner-only.
    execFileSync("bash", ["-c", 'cd "$1" && sha256sum -c SHA256SUMS >/dev/null', "_", dir])
    const mode = execFileSync("stat", ["-c", "%a", dir], { encoding: "utf8" }).trim()
    expect(mode).toBe("700")
    // A checkpoint is megabytes, not gigabytes: the 2 MiB node_modules blob is absent.
    const bytes = Number(execFileSync("du", ["-sb", dir], { encoding: "utf8" }).split("\t")[0])
    expect(bytes).toBeLessThan(1024 * 1024)
  })

  it("refuses to archive oversized untracked content instead of inflating the checkpoint", () => {
    writeFileSync(join(repo, "huge.bin"), Buffer.alloc(3 * 1024 * 1024, 1))
    expect(() => sh(["--project", repo, "--root", root, "--untracked-max-mb", "1"], repo)).toThrow(/exceeds --untracked-max-mb/)
    expect(existsSync(root) ? readdirSync(root) : []).toHaveLength(0)
  })

  it("prunes to --keep newest, honours KEEP markers and --dry-run, and never touches foreign entries", () => {
    mkdirSync(root, { recursive: true })
    // Legacy hand-rolled checkpoints without VERIFIED markers, chronological by name.
    const legacy = [
      "20260901T000000Z-old-a",
      "20260902T000000Z-old-b",
      "20260903T000000Z-keep-me",
      "20260904T000000Z-old-c",
      "20260905T000000Z-old-d",
    ]
    for (const name of legacy) {
      mkdirSync(join(root, name))
      writeFileSync(join(root, name, "payload.bin"), Buffer.alloc(64 * 1024, 3))
    }
    writeFileSync(join(root, "20260903T000000Z-keep-me", "KEEP"), "")
    mkdirSync(join(root, "not-a-checkpoint"))
    writeFileSync(join(root, "README"), "foreign file\n")

    const dry = shAll(["--prune-only", "--root", root, "--keep", "2", "--dry-run"], repo)
    expect(dry).toMatch(/would remove .*20260901T000000Z-old-a/)
    expect(dry).not.toMatch(/keep-me/)
    expect(readdirSync(root).sort()).toEqual([...legacy, "README", "not-a-checkpoint"].sort())

    // Create two new checkpoints; retention keeps the 2 newest prunable ones.
    sh(["--project", repo, "--root", root, "--label", "first", "--keep", "2"], repo)
    sh(["--project", repo, "--root", root, "--label", "second", "--keep", "2"], repo)

    const remaining = readdirSync(root).sort()
    expect(remaining).toContain("20260903T000000Z-keep-me")
    expect(remaining).toContain("not-a-checkpoint")
    expect(remaining).toContain("README")
    for (const gone of ["20260901T000000Z-old-a", "20260902T000000Z-old-b", "20260904T000000Z-old-c", "20260905T000000Z-old-d"]) {
      expect(remaining).not.toContain(gone)
    }
    const created = remaining.filter((n) => /-(first|second)$/.test(n))
    expect(created).toHaveLength(2)
  })

  it("applies the total-size cap while always retaining at least two checkpoints", () => {
    mkdirSync(root, { recursive: true })
    for (const name of ["20260901T000000Z-a", "20260902T000000Z-b", "20260903T000000Z-c"]) {
      mkdirSync(join(root, name))
      writeFileSync(join(root, name, "payload.bin"), Buffer.alloc(1024 * 1024, 5))
    }
    // A 1 GiB cap is far above 3 MiB, so nothing is removed by size.
    sh(["--prune-only", "--root", root, "--keep", "10", "--max-total-gb", "1"], repo)
    expect(readdirSync(root)).toHaveLength(3)
    // An exact byte cap below the total removes the oldest, but never below two.
    const tight = { ...ENV, CTS_CHECKPOINT_MAX_TOTAL_BYTES: String(1024) }
    const out = shAll(["--prune-only", "--root", root, "--keep", "10"], repo, tight)
    expect(out).toMatch(/removed expired checkpoint .*20260901T000000Z-a/)
    expect(readdirSync(root).sort()).toEqual(["20260902T000000Z-b", "20260903T000000Z-c"])
  })

  it("rejects dangerous roots", () => {
    expect(() => sh(["--prune-only", "--root", "/"], repo)).toThrow(/absolute path other than/)
    expect(() => sh(["--prune-only", "--project", repo, "--root", join(repo, "inside")], repo)).toThrow(/must not overlap/)
  })

  it("is the checkpoint tool AGENTS.md prescribes", () => {
    const agents = readFileSync(resolve(process.cwd(), "AGENTS.md"), "utf8")
    expect(agents).toContain("scripts/create-checkpoint.sh")
    expect(agents).toContain("KEEP")
  })
})
