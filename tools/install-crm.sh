#!/usr/bin/env bash
# Install or repair the leads engine (CRM) from the upstream repo.
#
# The pad's Leads tab needs the engine; if leads/ is missing or broken (a fresh
# checkout, a partial copy, a host that never had it), this fetches just the
# files it needs from the project's GitHub repo and leaves the rest alone.
#
#   bash tools/install-crm.sh              # install where this script lives
#   REPO_URL=... REF=v1.2.0 bash tools/install-crm.sh
#
# Nothing here is brand-specific: the URL and ref are overridable env vars.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REPO_URL="${REPO_URL:-https://github.com/virtual-ark10/resend-pad}"
REF="${REF:-main}"
FILES=(leads/server.cjs leads/boot.sh leads/watchdog.sh leads/config.example.json db.cjs hooks.cjs)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[install-crm] target: $ROOT"
echo "[install-crm] source: $REPO_URL @ $REF"

missing=0
for f in "${FILES[@]}"; do
  [ -s "$ROOT/$f" ] || missing=$((missing + 1))
done
if [ "$missing" -eq 0 ]; then
  echo "[install-crm] engine files already present (use FORCE=1 to refresh)"
  [ "${FORCE:-0}" = "1" ] || exit 0
fi

# GitHub serves a tarball for any ref without needing git or a token.
url="$REPO_URL"
url="${url%.git}"
url="${url/github.com/codeload.github.com}/tar.gz/refs/heads/$REF"
echo "[install-crm] downloading $url"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$TMP/src.tar.gz"
else
  wget -qO "$TMP/src.tar.gz" "$url"
fi
tar -xzf "$TMP/src.tar.gz" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name '*-*' | head -1)"
[ -n "$SRC" ] || { echo "[install-crm] could not unpack the archive"; exit 1; }

for f in "${FILES[@]}"; do
  if [ -f "$SRC/$f" ]; then
    mkdir -p "$ROOT/$(dirname "$f")"
    cp "$SRC/$f" "$ROOT/$f"
    echo "[install-crm] installed $f"
  else
    echo "[install-crm] WARN: $f not found upstream"
  fi
done
chmod +x "$ROOT/leads/boot.sh" "$ROOT/leads/watchdog.sh" 2>/dev/null || true
mkdir -p "$ROOT/leads/data"
echo "[install-crm] done. Start it with: bash leads/boot.sh (or docker compose up -d)"

# Where the browser finds it: the pad proxies /api/crm/* to LEADPAD_ENGINE.
cat <<'EOF'

[install-crm] checklist
  1. config.json -> "leads": { "enabled": true, "port": 3002 }
  2. the engine shares the pad's token: CRM_TOKEN defaults to PAD_TOKEN
  3. docker: the compose file already defines the leads service; bare metal: bash leads/boot.sh
EOF
