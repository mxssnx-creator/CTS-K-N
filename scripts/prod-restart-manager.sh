#!/bin/bash

# Production Restart and Recovery Manager
# Ensures continuous 8-hour operation with automatic restarts on failure
# Monitors health and restarts engine if needed

set -e

PROD_URL="http://localhost:3002"
RESTART_LOG="/tmp/prod-restart-manager.log"
MAX_RESTART_DELAY=60
CHECK_INTERVAL=30

log_to_file() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" >> "$RESTART_LOG"
  echo "$1"
}

check_server_health() {
  local health=$(curl -sS --max-time 5 "$PROD_URL/api/health" 2>/dev/null | jq -r '.status // "error"')
  [ "$health" = "healthy" ]
}

check_engine_running() {
  local status=$(curl -sS --max-time 5 "$PROD_URL/api/trade-engine/progression" 2>/dev/null | jq -r '.connections[0].engineProgression.phase // "none"')
  [ "$status" = "live_trading" ]
}

restart_engine() {
  log_to_file "Attempting engine restart..."
  curl -sS -X POST "$PROD_URL/api/engine/startup" > /dev/null 2>&1
  sleep 5
}

restart_server() {
  log_to_file "Performing server restart..."
  : "${CRON_SECRET:?CRON_SECRET must be supplied by the production environment}"
  fuser -k 3002/tcp 2>/dev/null || true
  sleep 2
  
  cd "/vercel/share/v0-project"
  NEXT_DIST_DIR=".next" \
  NODE_ENV="production" \
  CRON_SECRET="${CRON_SECRET}" \
  ALLOW_INLINE_REDIS_LIVE_TRADING="1" \
  pnpm run start > /tmp/prod-20sym-8h.log 2>&1 &
  
  sleep 15
  log_to_file "Server restarted"
}

main() {
  log_to_file "Production Restart Manager started"
  log_to_file "Configuration: 20 symbols, 8-hour run, automatic recovery"
  
  restart_count=0
  start_time=$(date +%s)
  
  while true; do
    current_time=$(date +%s)
    elapsed=$((current_time - start_time))
    hours=$((elapsed / 3600))
    
    # Check 8-hour limit
    if [ $elapsed -ge 28800 ]; then
      log_to_file "8-hour production run completed"
      break
    fi
    
    # Health checks
    if ! check_server_health; then
      log_to_file "WARNING: Server health check failed"
      restart_count=$((restart_count + 1))
      log_to_file "Restart attempt #$restart_count"
      restart_server
      continue
    fi
    
    if ! check_engine_running; then
      log_to_file "WARNING: Engine not in live_trading phase"
      restart_count=$((restart_count + 1))
      log_to_file "Engine restart attempt #$restart_count"
      restart_engine
      continue
    fi
    
    # Get status for logging
    local status=$(curl -sS --max-time 5 "$PROD_URL/api/trade-engine/progression" 2>/dev/null | jq '.connections[0].progression | {cycles: .cyclesCompleted, positions: .totalPositionCount, trades: .totalTrades}' 2>/dev/null)
    
    if [ -n "$status" ]; then
      local cycles=$(echo "$status" | jq -r '.cycles // 0')
      log_to_file "Status [${hours}h elapsed]: cycles=$cycles"
    fi
    
    sleep $CHECK_INTERVAL
  done
  
  log_to_file "Production run complete (${hours}h elapsed, $restart_count restarts)"
}

# Initial startup
echo "=== PRODUCTION RESTART MANAGER ===" 
echo "Starting 8-hour continuous monitoring with automatic recovery"
echo ""

main "$@"
