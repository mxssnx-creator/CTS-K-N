#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${CTS_LOCAL_REDIS_DIR:-$PROJECT_ROOT/.cts-runtime/local-redis}"
REDIS_PORT="${CTS_LOCAL_REDIS_PORT:-6379}"
REDIS_HOST="127.0.0.1"
PID_FILE="$RUNTIME_DIR/redis.pid"
LOG_FILE="$RUNTIME_DIR/redis.log"

resolve_binary() {
  local name="$1" explicit="$2" persistent="/workspace/.network-clients/redis-8.10.1/bin/$1"
  if [[ -n "$explicit" ]]; then
    [[ -x "$explicit" ]] || { printf '[local-redis] %s is not executable\n' "$explicit" >&2; return 1; }
    printf '%s\n' "$explicit"
  elif [[ -x "$persistent" ]]; then
    printf '%s\n' "$persistent"
  elif command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
  else
    printf '[local-redis] %s is unavailable\n' "$name" >&2
    return 1
  fi
}

REDIS_SERVER="$(resolve_binary redis-server "${CTS_REDIS_SERVER_BIN:-}")"
REDIS_CLI="$(resolve_binary redis-cli "${CTS_REDIS_CLI_BIN:-}")"

redis_ping() {
  "$REDIS_CLI" -h "$REDIS_HOST" -p "$REDIS_PORT" --no-auth-warning ping 2>/dev/null | grep -qx PONG
}

owned_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid command_line
  pid="$(<"$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  [[ "$command_line" == *"$REDIS_SERVER"* && "$command_line" == *"--port $REDIS_PORT"* ]] || return 1
  printf '%s\n' "$pid"
}

start_redis() {
  mkdir -p "$RUNTIME_DIR"
  chmod 700 "$RUNTIME_DIR"
  if redis_ping; then
    printf '[local-redis] already ready at redis://%s:%s\n' "$REDIS_HOST" "$REDIS_PORT"
    return 0
  fi
  if [[ -f "$PID_FILE" ]] && ! owned_pid >/dev/null; then
    rm -f -- "$PID_FILE"
  fi
  "$REDIS_SERVER" \
    --bind "$REDIS_HOST" \
    --protected-mode yes \
    --port "$REDIS_PORT" \
    --dir "$RUNTIME_DIR" \
    --dbfilename dump.rdb \
    --appendonly yes \
    --appendfsync everysec \
    --save "900 1 300 10 60 10000" \
    --maxmemory-policy noeviction \
    --daemonize yes \
    --pidfile "$PID_FILE" \
    --logfile "$LOG_FILE" \
    --loglevel notice \
    >/dev/null
  if [[ ! -s "$PID_FILE" ]]; then
    printf '[local-redis] daemon did not publish %s; see %s\n' "$PID_FILE" "$LOG_FILE" >&2
    return 1
  fi
  local pid="$(<"$PID_FILE")"
  for _ in {1..80}; do
    if redis_ping; then
      printf '[local-redis] ready at redis://%s:%s (pid %s, AOF everysec)\n' "$REDIS_HOST" "$REDIS_PORT" "$pid"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  printf '[local-redis] startup failed; see %s\n' "$LOG_FILE" >&2
  return 1
}

stop_redis() {
  local pid
  if ! pid="$(owned_pid)"; then
    printf '[local-redis] no owned Redis process is running\n'
    return 0
  fi
  kill -TERM "$pid"
  for _ in {1..100}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    printf '[local-redis] process %s did not stop cleanly\n' "$pid" >&2
    return 1
  fi
  rm -f -- "$PID_FILE"
  printf '[local-redis] stopped pid %s; persistent data retained in %s\n' "$pid" "$RUNTIME_DIR"
}

status_redis() {
  local pid=""
  pid="$(owned_pid 2>/dev/null || true)"
  if [[ -n "$pid" ]] && redis_ping; then
    printf '[local-redis] healthy at redis://%s:%s (pid %s)\n' "$REDIS_HOST" "$REDIS_PORT" "$pid"
    "$REDIS_CLI" -h "$REDIS_HOST" -p "$REDIS_PORT" --no-auth-warning INFO persistence \
      | grep -E '^(aof_enabled|aof_last_write_status|rdb_last_bgsave_status):' || true
    return 0
  fi
  printf '[local-redis] not running\n'
  return 1
}

case "${1:-start}" in
  start) start_redis ;;
  stop) stop_redis ;;
  restart) stop_redis; start_redis ;;
  status) status_redis ;;
  *) printf 'Usage: %s {start|stop|restart|status}\n' "$0" >&2; exit 2 ;;
esac
