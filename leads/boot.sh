#!/bin/bash
# Leads engine boot — starts the internal HTTP service (default 127.0.0.1:3002).
#
# Portable by design: every path is derived from this file's location, so the
# checkout can live anywhere and be run through a symlink.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT" || exit 1

# The engine authenticates callers with the same token the pad uses, and shares
# its branding, so it lifts a few keys from the pad's .env (override with PAD_ENV).
# NB: it deliberately does NOT source that file wholesale — it holds PORT=3001
# for the pad, which would collide with this service.
PAD_ENV="${PAD_ENV:-$ROOT/../.env}"
if [ -f "$PAD_ENV" ]; then
  for key in PAD_TOKEN BRAND_NAME FROM_EMAIL PAD_DOMAINS PUBLIC_BASE_URL; do
    line="$(grep -E "^${key}=" "$PAD_ENV" | head -1)"
    [ -n "$line" ] && export "${key}=${line#*=}"
  done
fi
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi

: "${PORT:=3002}"
: "${HOST:=127.0.0.1}"
: "${PAD_URL:=http://127.0.0.1:3001}"
: "${DATA_DIR:=$ROOT/data}"
: "${CRM_TOKEN:=$PAD_TOKEN}"
: "${SERVICE_NAME:=leads}"
export PORT HOST PAD_URL DATA_DIR CRM_TOKEN PAD_TOKEN SERVICE_NAME
export LEADPAD_ENGINE=1     # marker: gives this process a unique cmdline

# The trailing marker is load-bearing: the pad's server is launched as
# "node server.cjs", so the pad watchdog must never match this process.
exec node server.cjs --leads-engine
