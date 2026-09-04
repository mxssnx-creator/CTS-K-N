#!/usr/bin/env bash
# Bound high-churn CTS and supporting infrastructure text logs without
# touching databases, trading histories, reports, credentials, or backups.

set -euo pipefail
umask 027

MAX_LINES="${CTS_LOG_MAX_LINES:-1000}"
MAX_BYTES="${CTS_LOG_MAX_BYTES:-8388608}"
SCAN_ROOT="${CTS_LOG_SCAN_ROOT:-/}"
SKIP_JOURNAL="${CTS_LOG_SKIP_JOURNAL:-0}"
JOURNAL_MAX_USE="${CTS_JOURNAL_MAX_USE:-256M}"

[[ "$MAX_LINES" =~ ^[0-9]+$ ]] && (( MAX_LINES >= 100 && MAX_LINES <= 10000 )) \
  || { echo "CTS_LOG_MAX_LINES must be 100..10000" >&2; exit 2; }
[[ "$MAX_BYTES" =~ ^[0-9]+$ ]] && (( MAX_BYTES >= 1048576 && MAX_BYTES <= 67108864 )) \
  || { echo "CTS_LOG_MAX_BYTES must be 1..64 MiB" >&2; exit 2; }
[[ "$SCAN_ROOT" == /* && "$SCAN_ROOT" != *".."* ]] \
  || { echo "CTS_LOG_SCAN_ROOT must be an absolute path without '..'" >&2; exit 2; }

rooted() {
  local path="$1"
  if [[ "$SCAN_ROOT" == "/" ]]; then printf '%s' "$path"; else printf '%s%s' "${SCAN_ROOT%/}" "$path"; fi
}

trim_log() {
  local file="$1" line_count byte_count temp byte_temp
  [[ -f "$file" && ! -L "$file" ]] || return 0
  line_count="$(wc -l < "$file" 2>/dev/null || printf '0')"
  byte_count="$(stat -c %s "$file" 2>/dev/null || printf '0')"
  [[ "$line_count" =~ ^[0-9]+$ && "$byte_count" =~ ^[0-9]+$ ]] || return 0
  if (( line_count <= MAX_LINES && byte_count <= MAX_BYTES )); then return 0; fi

  temp="$(mktemp "$(dirname "$file")/.cts-log-trim.XXXXXX")"
  tail -n "$MAX_LINES" -- "$file" > "$temp"
  if (( $(stat -c %s "$temp") > MAX_BYTES )); then
    byte_temp="${temp}.bytes"
    tail -c "$MAX_BYTES" -- "$temp" > "$byte_temp"
    mv -f -- "$byte_temp" "$temp"
  fi
  # Copy back into the same inode so long-running writers do not continue to
  # consume an unlinked file. These are diagnostics; trading state is never a
  # candidate for this function.
  cp -- "$temp" "$file"
  rm -f -- "$temp"
  printf '[cts-log-retention] trimmed %s from %s lines/%s bytes\n' "$file" "$line_count" "$byte_count"
}

scan_logs() {
  local root="$1"
  [[ -d "$root" ]] || return 0
  while IFS= read -r -d '' file; do trim_log "$file"; done < <(
    find "$root" -xdev -type f \
      \( -name '*.log' -o -name '*.out' -o -name '*.err' -o -name 'errors-*.jsonl' \) \
      -print0 2>/dev/null
  )
}

# Bound regular text logs below /var/log, including Redis, nginx, XRDP and
# network-agent logs. Binary accounting files such as wtmp/btmp/journal do not
# match the deliberately narrow filename set below.
scan_logs "$(rooted /var/log)"

# Only scan canonical runtime log locations below persistent/application
# roots. Never descend through data, Redis, credentials, reports or backups,
# even when one of those contains a file whose name happens to end in .log.
shopt -s nullglob
for log_dir in \
  "$(rooted /var/lib/cts/instances)"/*/logs \
  "$(rooted /var/lib)"/cts-*/logs \
  "$(rooted /var/lib)"/grok-*/logs \
  "$(rooted /opt)"/cts-*/logs \
  "$(rooted /opt)"/cts-*/.agent-logs \
  "$(rooted /opt)"/grok-*/logs; do
  scan_logs "$log_dir"
done

# Some legacy CTS-G/Pulse processes write their bounded diagnostic files at
# the checkout root. maxdepth=1 prevents accidental traversal into state.
for project_root in "$(rooted /opt)"/cts-* "$(rooted /opt)"/grok-*; do
  [[ -d "$project_root" ]] || continue
  while IFS= read -r -d '' file; do trim_log "$file"; done < <(
    find "$project_root" -maxdepth 1 -type f \
      \( -name '*.log' -o -name '*.out' -o -name '*.err' -o -name 'errors-*.jsonl' \) \
      -print0 2>/dev/null
  )
done
shopt -u nullglob

if [[ "$SCAN_ROOT" == "/" && "$SKIP_JOURNAL" != "1" ]] && command -v journalctl >/dev/null 2>&1; then
  journalctl --vacuum-time=7d --vacuum-size="$JOURNAL_MAX_USE" >/dev/null
fi
