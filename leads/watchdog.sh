#!/bin/bash
# Leads engine watchdog — keeps the internal service on 127.0.0.1:3002 alive.
# Runs every minute from crontab. No Caddy logic: this service is never exposed
# publicly, the pad proxies to it (see ../server.cjs /api/crm/*).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
LOG="$ROOT/watchdog.log"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
PORT="${PORT:-3002}"

if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
  exit 0
fi

echo "$(ts) leads engine down — restarting" >> "$LOG"
# Kill only whatever holds the port (precise), falling back to a pattern that
# cannot match the pad's process or a shell that merely mentions the marker.
PID=$(ss -tlnp 2>/dev/null | grep ":$PORT" | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "${PID:-}" ]; then kill "$PID" 2>/dev/null; else pkill -f 'server\.cjs --leads-engine' 2>/dev/null; fi
sleep 1
nohup "$ROOT/boot.sh" >> "$LOG" 2>&1 &
sleep 2
if curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then
  echo "$(ts) leads engine back up" >> "$LOG"
else
  echo "$(ts) leads engine FAILED to start — see log above" >> "$LOG"
fi
