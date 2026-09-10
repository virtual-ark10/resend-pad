#!/bin/bash
# pad-kit watchdog — per-minute health check + Caddy route self-heal.
#
# Deliberately NOT tied to any personal crontab. Run it however you like:
#   * systemd user timer : deploy/pad-watchdog.timer (+ .service)
#   * classic crontab    : * * * * * /path/to/pad-kit/watchdog.sh
#   * manually           : ./watchdog.sh
#
# Configured through the .env next to this script (or the ambient environment):
#   PORT           — pad port (default 3001)
#   ROUTE_PATH     — public route to re-apply, e.g. /pad   (empty = skip Caddy)
#   CADDY_ADMIN    — Caddy admin API (default http://127.0.0.1:2019)
#   EXTRA_ENV_FILE — optional extra env file to load
#   WATCHDOG_LOG   — log path (default <script dir>/watchdog.log)
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/.env" ]; then set -a; . "$DIR/.env"; set +a; fi
if [ -n "${EXTRA_ENV_FILE:-}" ] && [ -f "${EXTRA_ENV_FILE}" ]; then set -a; . "$EXTRA_ENV_FILE"; set +a; fi

: "${PORT:=3001}"
: "${ROUTE_PATH:=}"
: "${CADDY_ADMIN:=http://127.0.0.1:2019}"
LOG="${WATCHDOG_LOG:-$DIR/watchdog.log}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

# 1. Server up? If not, kill any stale process by explicit PID (never a broad
#    `pkill -f` pattern — that can match the caller's own command line) and boot.
if ! curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  echo "$(ts) pad :$PORT down — restarting" >> "$LOG"
  pids="$(pgrep -f "$DIR/server.cjs" 2>/dev/null || true)"
  if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi
  sleep 1
  nohup "$DIR/boot.sh" >> "$LOG" 2>&1 &
  sleep 2
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    echo "$(ts) restart OK (:$PORT)" >> "$LOG"
  else
    echo "$(ts) restart FAILED (:$PORT)" >> "$LOG"
  fi
fi

# 2. Caddy route present? (idempotent re-apply via admin API; skipped when
#    ROUTE_PATH is empty, e.g. when the pad is fronted by something else)
if [ -n "$ROUTE_PATH" ]; then
  ROUTE_OK=$(curl -sf "$CADDY_ADMIN/config/" | ROUTE_PATH="$ROUTE_PATH" python3 -c '
import json, os, sys
route = os.environ["ROUTE_PATH"].rstrip("/")
try:
    cfg = json.load(sys.stdin)
except Exception:
    print("no"); raise SystemExit(0)
found = False
for srv in cfg.get("apps", {}).get("http", {}).get("servers", {}).values():
    for r in srv.get("routes", []):
        for m in r.get("match", []):
            for pth in m.get("path", []):
                if pth in (route, route + "/*"):
                    found = True
print("yes" if found else "no")
' 2>/dev/null)
  if [ "$ROUTE_OK" != "yes" ]; then
    echo "$(ts) Caddy route $ROUTE_PATH missing — re-applying" >> "$LOG"
    python3 "$DIR/add_caddy_route.py" --path "$ROUTE_PATH" --port "$PORT" --admin "$CADDY_ADMIN" >> "$LOG" 2>&1 \
      || echo "$(ts) route re-apply FAILED" >> "$LOG"
  fi
fi
