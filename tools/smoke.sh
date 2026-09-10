#!/usr/bin/env bash
# Smoke test: prove the pad + engine still run after a change, on throwaway
# ports and a temporary data directory. Safe to run any time - it never touches
# ./data, never sends mail, and cleans up after itself.
#
#   bash tools/smoke.sh
#
# Exit code 0 = everything answered as expected.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 1

PAD_PORT=${PAD_PORT:-39876}
ENGINE_PORT=${ENGINE_PORT:-39875}
T="$(mktemp -d)"
TOKEN=smoke-token
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*"
  echo "--- pad log (last 25) ---"; tail -25 "$T/pad.log" 2>/dev/null
  echo "--- engine log (last 25) ---"; tail -25 "$T/engine.log" 2>/dev/null
  exit 1
}

python3 - "$T" <<'PY'
import json, pathlib, sys
t = pathlib.Path(sys.argv[1])
(t / 'data').mkdir(parents=True, exist_ok=True)
cfg = {
    "useCase": "generic",
    "firstTab": "leads",
    "brand": {"name": "Smoke"},
    "from": "Smoke <hello@example.invalid>",
    "leads": {
        "enabled": True,
        "port": int(__import__('os').environ.get('ENGINE_PORT', '39875')),
        "stages": [
            {"key": "leads", "label": "Leads", "color": "#64748b"},
            {"key": "first_email", "label": "First email", "color": "#2563eb"},
            {"key": "replied", "label": "Replied", "color": "#db2777", "terminal": True},
            {"key": "won", "label": "Won", "color": "#16a34a", "terminal": True},
        ],
        "replyStage": "replied",
        "redraftReasons": ["Too long", "Wrong angle"],
    },
}
(t / 'config.json').write_text(json.dumps(cfg))
(t / 'data' / 'drafts.json').write_text(json.dumps([{
    "id": "smoke-draft", "company": "Smoke Co", "to": "owner@smoke.invalid",
    "subject": "Smoke", "text": "hi", "html": "<p>hi</p>",
    "created_at": "2026-01-01T00:00:00Z"}]))
PY

PORT="$PAD_PORT" DATA_DIR="$T/data" CONFIG_FILE="$T/config.json" RESEND_API_KEY=smoke \
  PAD_TOKEN="$TOKEN" CRM_HOST=127.0.0.1 CRM_PORT="$ENGINE_PORT" node server.cjs > "$T/pad.log" 2>&1 &
PIDS+=($!)
PORT="$ENGINE_PORT" HOST=127.0.0.1 DATA_DIR="$T/data" PAD_URL="http://127.0.0.1:$PAD_PORT" \
  PAD_TOKEN="$TOKEN" LEADPAD_CONFIG="$T/config.json" PAD_CONFIG="$T/config.json" \
  node leads/server.cjs > "$T/engine.log" 2>&1 &
PIDS+=($!)
sleep 2.5

H="x-pad-token: $TOKEN"
C="x-crm-token: $TOKEN"
get() { curl -s -m 5 -H "$H" "$@"; }
getc() { curl -s -m 5 -H "$C" "$@"; }
jget() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

echo "1. pad health";   curl -s -m 5 "http://127.0.0.1:$PAD_PORT/api/health" | grep -q '"ok"' || fail "pad health"
echo "2. engine health"; getc "http://127.0.0.1:$ENGINE_PORT/api/health" | grep -q '"ok"' || fail "engine health"
echo "3. store is sqlite + schema"; get "http://127.0.0.1:$PAD_PORT/api/stats" | jget "'%s v%s' % (d['backend'], d['schema_version'])" | grep -q "sqlite v" || fail "stats/store"
echo "4. draft queue seeded";  get "http://127.0.0.1:$PAD_PORT/api/drafts" | jget "len(d['data'])" | grep -q "^1$" || fail "drafts"
echo "5. pipeline counts";     getc "http://127.0.0.1:$ENGINE_PORT/api/meta" | jget "sum(d['counts'].values())" | grep -q "^1$" || fail "crm meta"
echo "6. send moves the lead (rules engine)"
node -e "
const db=require('$ROOT/db.cjs'); const s=db.open('$T/data');
s.recordSend({id:'smoke-draft', resendId:'re_smoke', to:'owner@smoke.invalid', subject:'Smoke', text:'hi'});
" || fail "recordSend"
curl -s -m 5 -X POST -H "$C" "http://127.0.0.1:$ENGINE_PORT/api/sync" > /dev/null
getc "http://127.0.0.1:$ENGINE_PORT/api/leads" | jget "d['leads'][0]['stage']" | grep -q "first_email" || fail "stage did not advance"
echo "7. reply moves it again"
node -e "
const db=require('$ROOT/db.cjs'); const s=db.open('$T/data');
s.saveReply({id:'smoke-reply', from:'owner@smoke.invalid', subject:'Re: Smoke', text:'yes'});
" || fail "saveReply"
curl -s -m 5 -X POST -H "$C" "http://127.0.0.1:$ENGINE_PORT/api/sync" > /dev/null
getc "http://127.0.0.1:$ENGINE_PORT/api/leads" | jget "d['leads'][0]['stage']" | grep -q "replied" || fail "reply stage"
echo "8. redraft keeps the reason"
curl -s -m 5 -X POST -H "$H" -H 'content-type: application/json' \
  -d '{"reason":"Too long","note":"shorter please"}' \
  "http://127.0.0.1:$PAD_PORT/api/drafts/smoke-draft/redraft" | jget "d['guidance']['total']" | grep -q "^1$" || fail "redraft"
echo "9. events all processed"
getc "http://127.0.0.1:$ENGINE_PORT/api/events" | jget "len(d['pending'])" | grep -q "^0$" || fail "pending events"
echo "10. reply soft-delete hides it"
curl -s -m 5 -X DELETE -H "$H" "http://127.0.0.1:$PAD_PORT/api/replies/smoke-reply" > /dev/null
get "http://127.0.0.1:$PAD_PORT/api/replies" | jget "len(d['data'])" | grep -q "^0$" || fail "reply delete"

echo "11. tracker events land and stay deduped"
node -e "
const db=require('$ROOT/db.cjs'); const s=db.open('$T/data');
s.recordSend({id:'smoke-send', resendId:'re_smoke_1', to:'owner@smoke.invalid', subject:'Smoke', text:'x', status:'sent'});
const at = '2026-01-05T10:00:00.000Z';
s.trackEvent({type:'delivered', resend_id:'re_smoke_1', occurred_at:at, source:'poll'});
s.trackEvent({type:'opened',    resend_id:'re_smoke_1', occurred_at:at});
s.trackEvent({type:'clicked',   resend_id:'re_smoke_1', occurred_at:at, url:'https://example.invalid/x'});
// same event again: a replayed webhook must not be counted twice
console.log('replay ->', JSON.stringify(s.trackEvent({type:'opened', resend_id:'re_smoke_1', occurred_at:at})));
" || fail "tracker events"
get "http://127.0.0.1:$PAD_PORT/api/trackers/summary?days=400" | jget "d['totals']['opened']" | grep -q "^1$" || fail "dedupe (opened counted twice)"
get "http://127.0.0.1:$PAD_PORT/api/trackers/events?limit=50" | jget "sum(1 for e in d['data'] if e['type']=='opened')" | grep -q "^1$" || fail "replayed event stored twice"
get "http://127.0.0.1:$PAD_PORT/api/trackers/summary?days=400" | jget "d['rates']['click']" | grep -q "^100" || fail "click rate"
get "http://127.0.0.1:$PAD_PORT/api/trackers/summary?days=400" | jget "len(d['top_links'])" | grep -q "^1$" || fail "top links"
get "http://127.0.0.1:$PAD_PORT/api/trackers/email/re_smoke_1" | jget "len(d['events'])" | grep -q "^3$" || fail "per-send timeline"
get "http://127.0.0.1:$PAD_PORT/api/trackers/summary?days=400" | jget "d['totals']['delivered']" | grep -q "^1$" || fail "delivered"
echo "12. tracking settings are reported (so the UI can warn)"
get "http://127.0.0.1:$PAD_PORT/api/trackers/summary?days=400" | jget "sorted(d['tracking'].keys())" | grep -q "openTracking" || fail "tracking flags"
echo "13. analytics providers answer without keys, and never fake data"
get "http://127.0.0.1:$PAD_PORT/api/analytics/summary?days=7" | jget "[p['id'] for p in d['providers']]" | grep -q "posthog" || fail "providers"
get "http://127.0.0.1:$PAD_PORT/api/analytics/summary?days=7" | jget "sum(1 for p in d['providers'] if p.get('error'))" | grep -q "^2$" || fail "unconfigured providers should say what they need"
echo "14. an MCP client can push points in"
TODAY=$(date -u +%F)
curl -s -m 5 -X POST -H "$H" -H 'content-type: application/json' \
  -d "{\"provider\":\"posthog\",\"metric\":\"pageviews\",\"points\":[{\"day\":\"$TODAY\",\"value\":9}]}" \
  "http://127.0.0.1:$PAD_PORT/api/analytics/ingest" | jget "d['ok']" | grep -q "True" || fail "ingest"
get "http://127.0.0.1:$PAD_PORT/api/analytics/summary?days=7" | jget "[p['id'] for p in d['providers'] if p['configured']]" | grep -q "mcp" || fail "pushed points visible"

echo
echo "OK: pad + engine + the event loop + trackers + analytics behave."
