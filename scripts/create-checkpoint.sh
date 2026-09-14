#!/usr/bin/env bash
# Canonical CTS-K-N source checkpoint.
#
# Produces the recoverable checkpoint layout required by AGENTS.md:
#   repository.bundle      complete Git bundle (--all) + `git bundle verify`
#   HEAD.txt               HEAD revision and branch
#   git-status.txt         `git status --porcelain=v1`
#   worktree.patch         `git diff --binary`
#   index.patch            `git diff --binary --cached`
#   untracked-files.txt    untracked, not-ignored files (exclude-standard)
#   untracked.tar.gz       archive of exactly those files (if any)
#   untracked-excluded.txt untracked files withheld by the secret filter
#   checkpoint-info        project / root / label / created_at / head
#   SHA256SUMS + VERIFIED  manifest, `sha256sum -c`, verified marker
#
# What it deliberately never contains: node_modules, .next*, caches, pnpm
# stores, Redis data, .env files, credentials, private keys. Ignored files are
# never archived, so a checkpoint stays in the megabyte range instead of the
# multi-gigabyte hand-rolled copies that repeatedly filled the production disk.
#
# After a successful checkpoint the root is pruned automatically: entries that
# match the timestamped checkpoint name pattern are kept newest-first up to
# --keep (default 5) and --max-total-gb (default 40). A checkpoint containing a
# file named KEEP is never removed. Nothing outside the name pattern is touched.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_NAME="cts-k-n"

ROOT="${CTS_CHECKPOINT_ROOT:-}"
LABEL="checkpoint"
KEEP="${CTS_CHECKPOINT_KEEP:-5}"
MAX_TOTAL_GB="${CTS_CHECKPOINT_MAX_TOTAL_GB:-40}"
UNTRACKED_MAX_MB="${CTS_CHECKPOINT_UNTRACKED_MAX_MB:-512}"
MODE="create"
DRY_RUN=0
NO_PRUNE=0

ENTRY_PATTERN='^[0-9]{8}T[0-9]{6}Z(-[A-Za-z0-9._-]+)?$'
# Paths that must never be archived even when untracked and not ignored.
SECRET_PATTERN='(^|/)(\.env[^/]*|credentials|secrets?|known_hosts|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*\.(pem|key|p12|pfx|rdb|aof))(/|$)|^\.cts-runtime/(?!install-values\.env$)'

usage() {
  cat <<'EOF'
Usage:
  scripts/create-checkpoint.sh [--label NAME] [--root DIR] [--keep N]
                               [--max-total-gb G] [--no-prune] [--dry-run]
  scripts/create-checkpoint.sh --prune-only [--root DIR] [--keep N] [--max-total-gb G] [--dry-run]
  scripts/create-checkpoint.sh --list [--root DIR]

Creates a verified source checkpoint of this checkout and prunes old ones.

Options:
  --label NAME        suffix for the checkpoint directory (default: checkpoint)
  --root DIR          checkpoint root; default /workspace/backups/CTS-K-N when the
                      checkout lives under /workspace, otherwise /var/backups/cts-kn
                      (env: CTS_CHECKPOINT_ROOT)
  --project DIR       checkout to snapshot (default: this repository)
  --keep N            newest checkpoints to retain (default 5, env CTS_CHECKPOINT_KEEP)
  --max-total-gb G    cap for all retained checkpoints together (default 40,
                      env CTS_CHECKPOINT_MAX_TOTAL_GB); at least 2 are always kept
  --untracked-max-mb M refuse to archive more than M MiB of untracked files (default 512)
  --prune-only        only apply retention, create nothing
  --list              show checkpoints with size and KEEP state
  --no-prune          create only, skip retention
  --dry-run           print retention decisions without deleting
  --help              this text

A file named KEEP inside a checkpoint protects it from retention.
EOF
}

fatal() { echo "create-checkpoint: $*" >&2; exit 1; }
info() { echo "create-checkpoint: $*" >&2; }

while (($#)); do
  case "$1" in
    --label) [[ $# -ge 2 ]] || fatal "--label requires a value"; LABEL="$2"; shift 2 ;;
    --root) [[ $# -ge 2 ]] || fatal "--root requires a value"; ROOT="$2"; shift 2 ;;
    --project) [[ $# -ge 2 ]] || fatal "--project requires a value"; PROJECT_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --keep) [[ $# -ge 2 ]] || fatal "--keep requires a value"; KEEP="$2"; shift 2 ;;
    --max-total-gb) [[ $# -ge 2 ]] || fatal "--max-total-gb requires a value"; MAX_TOTAL_GB="$2"; shift 2 ;;
    --untracked-max-mb) [[ $# -ge 2 ]] || fatal "--untracked-max-mb requires a value"; UNTRACKED_MAX_MB="$2"; shift 2 ;;
    --prune-only) MODE="prune"; shift ;;
    --list) MODE="list"; shift ;;
    --no-prune) NO_PRUNE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fatal "unknown argument: $1" ;;
  esac
done

[[ "$KEEP" =~ ^[0-9]+$ ]] && (( KEEP >= 1 )) || fatal "--keep must be a positive integer"
[[ "$MAX_TOTAL_GB" =~ ^[0-9]+$ ]] && (( MAX_TOTAL_GB >= 1 )) || fatal "--max-total-gb must be a positive integer"
[[ "$UNTRACKED_MAX_MB" =~ ^[0-9]+$ ]] || fatal "--untracked-max-mb must be an integer"

if [[ -z "$ROOT" ]]; then
  if [[ "$PROJECT_ROOT" == /workspace/* ]]; then ROOT="/workspace/backups/CTS-K-N"; else ROOT="/var/backups/cts-kn"; fi
fi
[[ "$ROOT" == /* && "$ROOT" != "/" ]] || fatal "checkpoint root must be an absolute path other than /: $ROOT"
ROOT="${ROOT%/}"
[[ "$ROOT" != "$PROJECT_ROOT" && "$ROOT" != "$PROJECT_ROOT"/* && "$PROJECT_ROOT" != "$ROOT"/* ]] \
  || fatal "checkpoint root must not overlap the checkout ($PROJECT_ROOT): $ROOT"

git_project() { git -c safe.directory="$PROJECT_ROOT" -C "$PROJECT_ROOT" "$@"; }

if [[ "$MODE" == "create" ]]; then
  git_project rev-parse --is-inside-work-tree >/dev/null 2>&1 || fatal "not a Git work tree: $PROJECT_ROOT"
fi

# ---------------------------------------------------------------- listing --

list_entries() {
  # Prints the checkpoint entries of ROOT in chronological order (name sort).
  [[ -d "$ROOT" ]] || return 0
  local name
  while IFS= read -r name; do
    [[ "$name" =~ $ENTRY_PATTERN ]] || continue
    [[ -d "$ROOT/$name" && ! -L "$ROOT/$name" ]] || continue
    printf '%s\n' "$name"
  done < <(find "$ROOT" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
}

entry_bytes() { du -sb --one-file-system -- "$ROOT/$1" 2>/dev/null | awk '{print $1}'; }

human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || printf '%sB' "$1"; }

if [[ "$MODE" == "list" ]]; then
  total=0
  while IFS= read -r name; do
    bytes="$(entry_bytes "$name")"; bytes="${bytes:-0}"; total=$(( total + bytes ))
    flags=""
    [[ -f "$ROOT/$name/KEEP" ]] && flags="${flags} KEEP"
    [[ -f "$ROOT/$name/VERIFIED" ]] && flags="${flags} verified"
    printf '%10s  %s%s\n' "$(human "$bytes")" "$name" "$flags"
  done < <(list_entries)
  printf '%10s  total in %s\n' "$(human "$total")" "$ROOT"
  exit 0
fi

# ---------------------------------------------------------------- create ---

CREATED=""
if [[ "$MODE" == "create" ]]; then
  safe_label="$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '-' | sed -E 's/^-+//; s/-+$//')"
  [[ -n "$safe_label" ]] || safe_label="checkpoint"
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dir="$ROOT/$timestamp-$safe_label"
  [[ ! -e "$dir" ]] || dir="$dir.$$"
  [[ "$(basename "$dir")" =~ $ENTRY_PATTERN ]] || fatal "internal: checkpoint name does not match the entry pattern"

  install -d -m 0700 -- "$ROOT"
  install -d -m 0700 -- "$dir"
  trap 'status=$?; if (( status != 0 )) && [[ -n "$dir" && -d "$dir" && ! -f "$dir/VERIFIED" ]]; then rm -rf --one-file-system -- "$dir"; info "removed incomplete checkpoint $dir"; fi; exit $status' EXIT

  head="$(git_project rev-parse HEAD 2>/dev/null || true)"
  [[ "$head" =~ ^[0-9a-f]{40}$ ]] || fatal "checkout has no commit to bundle"
  git_project bundle create "$dir/repository.bundle" --all >/dev/null 2>&1 \
    || fatal "git bundle create failed"
  git_project bundle verify "$dir/repository.bundle" >/dev/null 2>&1 \
    || fatal "git bundle verify failed"
  {
    printf 'head=%s\n' "$head"
    printf 'branch=%s\n' "$(git_project rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
  } > "$dir/HEAD.txt"
  git_project status --porcelain=v1 > "$dir/git-status.txt"
  git_project diff --binary > "$dir/worktree.patch"
  git_project diff --binary --cached > "$dir/index.patch"

  # Untracked, not ignored files only. Ignored content (node_modules, .next,
  # caches, .env) is reproducible or secret and is never archived.
  : > "$dir/untracked-files.txt"
  : > "$dir/untracked-excluded.txt"
  while IFS= read -r -d '' path; do
    if printf '%s' "$path" | grep -qP "$SECRET_PATTERN"; then
      printf '%s\n' "$path" >> "$dir/untracked-excluded.txt"
    else
      printf '%s\n' "$path" >> "$dir/untracked-files.txt"
    fi
  done < <(git_project ls-files --others --exclude-standard -z)

  if [[ -s "$dir/untracked-files.txt" ]]; then
    untracked_bytes=0
    while IFS= read -r path; do
      [[ -f "$PROJECT_ROOT/$path" ]] || continue
      size="$(stat -c %s -- "$PROJECT_ROOT/$path" 2>/dev/null || echo 0)"
      untracked_bytes=$(( untracked_bytes + size ))
    done < "$dir/untracked-files.txt"
    if (( UNTRACKED_MAX_MB > 0 && untracked_bytes > UNTRACKED_MAX_MB * 1024 * 1024 )); then
      fatal "untracked files total $(human "$untracked_bytes") which exceeds --untracked-max-mb $UNTRACKED_MAX_MB; add the large files to .gitignore or raise the limit deliberately"
    fi
    tar -C "$PROJECT_ROOT" --no-recursion --verbatim-files-from -czf "$dir/untracked.tar.gz" -T "$dir/untracked-files.txt" \
      || fatal "archiving untracked files failed"
  fi

  {
    printf 'project=%s\n' "$PROJECT_NAME"
    printf 'project_root=%s\n' "$PROJECT_ROOT"
    printf 'label=%s\n' "$safe_label"
    printf 'created_at=%s\n' "$timestamp"
    printf 'head=%s\n' "$head"
    printf 'keep=%s\n' "$KEEP"
    printf 'max_total_gb=%s\n' "$MAX_TOTAL_GB"
  } > "$dir/checkpoint-info"

  ( cd "$dir" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum ) > "$dir/SHA256SUMS"
  [[ -s "$dir/SHA256SUMS" ]] || fatal "checkpoint manifest is empty"
  ( cd "$dir" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ) || fatal "checkpoint checksum verification failed"
  chmod -R go-rwx -- "$dir"
  install -m 0600 /dev/null "$dir/VERIFIED"
  CREATED="$(basename "$dir")"
  trap - EXIT
  info "verified checkpoint: $dir ($(human "$(entry_bytes "$CREATED")"))"
  echo "$dir"
fi

# ----------------------------------------------------------------- prune ---

if [[ "$MODE" == "create" && "$NO_PRUNE" == 1 ]]; then exit 0; fi
[[ -d "$ROOT" ]] || { info "no checkpoint root at $ROOT, nothing to prune"; exit 0; }

mapfile -t entries < <(list_entries)
candidates=()
for name in "${entries[@]}"; do
  [[ -f "$ROOT/$name/KEEP" ]] && continue
  candidates+=("$name")
done

remove=()
excess=$(( ${#candidates[@]} - KEEP ))
if (( excess > 0 )); then
  for name in "${candidates[@]:0:excess}"; do remove+=("$name"); done
  candidates=("${candidates[@]:excess}")
fi

cap_bytes=$(( MAX_TOTAL_GB * 1024 * 1024 * 1024 ))
# Advanced/testing override: an exact byte cap takes precedence over --max-total-gb.
if [[ -n "${CTS_CHECKPOINT_MAX_TOTAL_BYTES:-}" ]]; then
  [[ "$CTS_CHECKPOINT_MAX_TOTAL_BYTES" =~ ^[0-9]+$ ]] || fatal "CTS_CHECKPOINT_MAX_TOTAL_BYTES must be an integer"
  cap_bytes="$CTS_CHECKPOINT_MAX_TOTAL_BYTES"
fi
sizes=()
total=0
for name in "${candidates[@]}"; do
  bytes="$(entry_bytes "$name")"; bytes="${bytes:-0}"
  sizes+=("$bytes"); total=$(( total + bytes ))
done
while (( total > cap_bytes && ${#candidates[@]} > 2 )); do
  remove+=("${candidates[0]}")
  total=$(( total - sizes[0] ))
  candidates=("${candidates[@]:1}"); sizes=("${sizes[@]:1}")
done

if (( ${#remove[@]} == 0 )); then
  info "retention satisfied: ${#candidates[@]} prunable checkpoint(s), $(human "$total") in $ROOT"
  exit 0
fi

for name in "${remove[@]}"; do
  target="$ROOT/$name"
  [[ "$name" != "$CREATED" ]] || continue
  [[ "$name" =~ $ENTRY_PATTERN && -d "$target" && ! -L "$target" && ! -f "$target/KEEP" ]] || continue
  if (( DRY_RUN )); then
    info "would remove $target ($(human "$(entry_bytes "$name")"))"
  else
    bytes="$(entry_bytes "$name")"
    rm -rf --one-file-system -- "$target"
    info "removed expired checkpoint $target ($(human "${bytes:-0}"))"
  fi
done
info "retained ${#candidates[@]} prunable checkpoint(s), $(human "$total") in $ROOT"
