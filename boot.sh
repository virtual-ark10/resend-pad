#!/bin/bash
# pad-kit boot script — starts the server on 127.0.0.1:${PORT:-3001}.
#
# Fully self-locating: it derives its own directory from the script location, so
# the kit can be installed anywhere (/srv/pad, ~/my-pad, /opt/anything) with no
# edit. There is no hardcoded path or brand in this file.
#
# Environment sources, in order:
#   1. .env next to this script        (per-install secrets/config)
#   2. $EXTRA_ENV_FILE, if set         (optional shared env file elsewhere)
#
# PORT and DATA_DIR are OPTIONAL. Defaults: PORT=3001, DATA_DIR=<script dir>/data.
# Everything else (RESEND_API_KEY, PAD_TOKEN, …) comes from the env files.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$DIR/.env"
  set +a
fi

if [ -n "${EXTRA_ENV_FILE:-}" ] && [ -f "${EXTRA_ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$EXTRA_ENV_FILE"
  set +a
fi

: "${PORT:=3001}"
: "${DATA_DIR:=$DIR/data}"
export PORT DATA_DIR

mkdir -p "$DATA_DIR"

# Optional file logging. Leave PAD_LOG unset to log to stdout (systemd/journald).
if [ -n "${PAD_LOG:-}" ]; then
  exec node "$DIR/server.cjs" >> "$PAD_LOG" 2>&1
fi
exec node "$DIR/server.cjs"
