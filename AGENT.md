# AGENT.md — runbook: stand this pad up for a new brand

Self-contained operating procedure. Follow it top to bottom. Every command is
copy-pasteable; every verification step states the output you must see. Do not
claim a step passed without seeing that output.

Target example used throughout: brand **starterlens.com** (a verified domain in
Resend, region eu-west-1). Nothing in the kit is specific to it — or to any
other brand — so the same steps work for the next one.

---

## 0. Prerequisites (verify, don't assume)

```bash
node -v            # >= 18   (this kit is tested on Node 26)
python3 -V         # >= 3.8 (only for the Caddy helper / watchdog / seed tool)
curl --version | head -1
```

You also need:

1. **A verified Resend domain** — the pad sends through Resend's API with a
   server-side key. Log into Resend → Domains and confirm the target domain's
   status is `verified` before you start. If it is not verified, sends will be
   rejected by Resend (the pad will faithfully relay the 4xx).
2. **A Resend sending API key** (`re_...`).
3. **A Svix signing secret** (`whsec_...`) if you want the webhook archive:
   Resend → Webhooks → add endpoint → copy the secret.
4. **A free local port** for the pad. Check it first:
   `ss -ltnp | grep -E ':(3001|3099|3100)\b' || echo free`
5. If the box already runs other pads, **do not reuse their port, DATA_DIR or
   route path**. One kit instance = one port + one DATA_DIR + one route.

## 1. Install the kit

```bash
INSTALL_DIR="${INSTALL_DIR:-$HOME/pad-kit}"     # ANY path works; nothing is hardcoded
cp -a /path/to/pad-kit "$INSTALL_DIR"
cd "$INSTALL_DIR"
cp config.example.json config.json
cp .env.example .env
chmod +x boot.sh watchdog.sh add_caddy_route.py tools/seed_drafts.py
```

> Never edit another install's `config.json`, `.env` or `data/` — each install is
> independent. If the kit was copied from a live install, delete any stale
> `data/drafts.json` / `sent-drafts.jsonl` before going live.

## 2. Choose the use case

Open `config.json` and set `useCase`. Pick by intent:

| Intent | `useCase` | Result |
|---|---|---|
| Cold outreach with a review-before-send queue and follow-ups | `outbound` | Tabs: Drafts, Compose, Sent, Received. Templates: intro + follow-up 1/2/3. |
| Drafting/reviewing a newsletter issue before it goes out | `newsletter` | Tabs: Draft issue, Review queue, Sent, Inbox. Templates: issue, re-engagement. |
| One-off/transactional sends with a minimal log | `transactional` | Tabs: Send, Log. Templates: receipt, service notice. |
| Anything else / undecided | `generic` | All four tabs, one blank template. |

The preset only fills `tabs` and `templates`; any explicit `tabs`/`templates` in
`config.json` override it. Full field list: `docs/CONFIG.md`.

## 3. Configure the branding

Minimum viable `config.json` for a new brand:

```json
{
  "useCase": "outbound",
  "brand": {
    "name": "StarterLens",
    "productName": "StarterLens Email Pad",
    "siteUrl": "https://starterlens.com",
    "logoInitials": "SL",
    "tagline": "StarterLens outbound + inbox · powered by Resend"
  },
  "from": "hello@starterlens.com",
  "replyTo": "hello@starterlens.com",
  "signature": { "html": "<p>Best,<br>The StarterLens team</p>" }
}
```

Notes:
* `from` **must be on the verified Resend domain**. The local part of `from` is
  used to build the From dropdown from `GET /api/domains` (verified only).
* `signature.html` is inserted by the **Signature** button and by `{{signature}}`
  inside templates.
* Template placeholders: `{{company}}`, `{{first_name}}`, `{{audience}}`,
  `{{product}}`, `{{brand}}`, `{{site_url}}`, `{{signature}}`.
* `tracking.openTracking` / `tracking.clickTracking` stay **false** unless the
  tracking subdomain is verified in Resend (see README §6).

## 4. Configure the secrets (.env)

```bash
cd "$INSTALL_DIR"
python3 - <<'PY'
import secrets, pathlib
p = pathlib.Path('.env'); s = p.read_text()
s = s.replace('PAD_TOKEN=change-me-to-a-long-random-string',
              'PAD_TOKEN=' + secrets.token_urlsafe(32))
p.write_text(s)
PY
$EDITOR .env      # set RESEND_API_KEY (and RESEND_WEBHOOK_SECRET if you have one)
grep -c '^PAD_TOKEN=' .env   # must be 1
```

Optional, and only if needed:
`PORT`, `DATA_DIR`, `CONFIG_FILE`, `EXTRA_ENV_FILE`, `PAD_LOG`, `ROUTE_PATH`,
`CADDY_ADMIN`, `RATE_PER_MINUTE`, `MAX_BODY_BYTES`, `OUTREACH_*`.
Leave `OUTREACH_ENABLED` unset unless you are wiring an attribution service —
with it off the send path never calls the mint/block code.

## 5. Smoke-test the API **before** wiring anything public

Use a throwaway port and a throwaway DATA_DIR so you cannot disturb a live pad:

```bash
cd "$INSTALL_DIR"
TOKEN=$(grep -E '^PAD_TOKEN=' .env | cut -d= -f2-)
TESTPORT=3099
PORT=$TESTPORT DATA_DIR=$(mktemp -d) node server.cjs > /tmp/padkit-smoke.log 2>&1 &
SRV=$!
sleep 1

# 1. health -> 200, {"ok":true,...}
curl -s -o /dev/null -w 'health %{http_code}\n' "http://127.0.0.1:$TESTPORT/api/health"
curl -s "http://127.0.0.1:$TESTPORT/api/health"

# 2. no token -> 401
curl -s -o /dev/null -w 'no-token %{http_code}\n' "http://127.0.0.1:$TESTPORT/api/drafts"

# 3. correct token -> 200
curl -s -o /dev/null -w 'authed %{http_code}\n' -H "X-Pad-Token: $TOKEN" "http://127.0.0.1:$TESTPORT/api/drafts"

# 4. config -> 200 with the brand fields
curl -s -H "X-Pad-Token: $TOKEN" "http://127.0.0.1:$TESTPORT/api/config" | python3 -m json.tool

# 5. bogus draft id -> JSON 404 and the server is STILL ALIVE
curl -s -i -H "X-Pad-Token: $TOKEN" "http://127.0.0.1:$TESTPORT/api/drafts/nope-does-not-exist" | head -1
curl -s -H "X-Pad-Token: $TOKEN" "http://127.0.0.1:$TESTPORT/api/drafts/nope-does-not-exist"
curl -s -o /dev/null -w 'still-alive %{http_code}\n' "http://127.0.0.1:$TESTPORT/api/health"

kill $SRV; wait $SRV 2>/dev/null; echo "smoke server stopped"
```

Then seed a draft and prove it appears (use the same throwaway DATA_DIR):

```bash
printf 'id,company,to,cc,subject,text\nacme-inc,Acme Inc,partner@acme.example,,Hello there,"Hi Jane,\n\nQuick note about Acme."\n' > /tmp/seed.csv
python3 tools/seed_drafts.py /tmp/seed.csv --drafts "$TESTDATA/drafts.json"
```

Re-run the smoke server and `GET /api/drafts` — the new draft must be in the
`data` array.

## 6. Start it for real

```bash
cd "$INSTALL_DIR"
./boot.sh                       # foreground check first — watch for the ✓ line
# then hand it to systemd (preferred) or nohup
cp deploy/pad.service ~/.config/systemd/user/pad.service
$EDITOR ~/.config/systemd/user/pad.service     # fix WorkingDirectory/ExecStart if not ~/pad-kit
systemctl --user daemon-reload
systemctl --user enable --now pad.service
systemctl --user status pad.service --no-pager
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/api/health"   # 200
```

## 7. Expose a route (only if it should be public)

```bash
python3 add_caddy_route.py --path /pad --port "$PORT"
curl -s -o /dev/null -w '%{http_code}\n' https://<your-host>/pad/            # 200 (HTML)
```

Then set `ROUTE_PATH=/pad` and `CADDY_ADMIN=http://127.0.0.1:2019` in `.env` and
enable the watchdog so the route self-heals:

```bash
cp deploy/pad-watchdog.service deploy/pad-watchdog.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now pad-watchdog.timer
```

## 8. Verification checklist (all must be literally observed)

| # | Check | Expected |
|---|---|---|
| 1 | `node -c server.cjs && node -c outreach-links.cjs` | no output (syntax OK) |
| 2 | `GET /api/health` | `200` `{"ok":true,...}` |
| 3 | `GET /api/drafts` no token | `401` |
| 4 | `GET /api/drafts` with `X-Pad-Token` | `200` `{"data":[…]}` |
| 5 | `GET /api/config` | `200`, contains `brand`, `tabs`, `templates`, `useCase` |
| 6 | `GET /api/drafts/<bogus>` | JSON `404` **and** `/api/health` still `200` |
| 7 | `python3 tools/seed_drafts.py sample.csv` | `appended: 1`, and the id shows in `GET /api/drafts` |
| 8 | After any restart: live sibling pads untouched | their `/api/health` still `200` |
| 9 | `grep -rn -e brand -e oldhost server.cjs index.html outreach-links.cjs boot.sh watchdog.sh add_caddy_route.py` | zero hits for any previous brand/host |

## 9. Common pitfalls (each one actually bit the original build)

1. **A removed variable crashed the server mid-request.** After ANY `server.cjs`
   edit: `node -c server.cjs` first, then probe every touched route with a bogus
   id. A `ReferenceError` is not caught by a syntax check.
2. **Unknown draft ids must return a JSON 404, never crash.** This kit already
   does (`GET/PUT/DELETE /api/drafts/:id` → 404 JSON) and wraps the whole API
   handler in a try/catch, but keep testing it after edits — a crash means the
   process dies and the watchdog restarts it with stale on-disk state.
3. **`pkill -f '<pattern>'` can kill your own shell.** The harness wrapper's
   command line contains the pattern you are matching. Always `pgrep -af` first
   and kill explicit PIDs (`pgrep -f '<kit>/server.cjs'`), never a bare
   `pkill -f 'node server.cjs'` — that would take out *every* pad instance on the
   box. `watchdog.sh` here kills by explicit PID for exactly this reason.
4. **Do not restart a live pad blindly.** Identify the PID and port first
   (`ss -ltnp`), confirm which DATA_DIR it serves, and never re-point it at
   another install's data.
5. **The draft queue is externally mutable.** Re-read `data/drafts.json` before
   writing (the seed tool and the send path both do) — a draft can be edited or
   discarded in the UI between your read and your write.
6. **HTML escaping.** When generating `html` for the contenteditable from lead
   data, escape `&`, `<`, `>` first or the editor shows broken entities.
   `tools/seed_drafts.py` escapes by default; use `--raw-html` only for
   pre-built markup.
7. **Keep `index.html` a single self-contained file.** No CDNs, no external
   assets, no build step — v1 of this app died in an incognito browser where the
   CDNs were blocked. Inline everything.
8. **`/api/config` is authed on purpose.** The client falls back to built-in
   defaults before Connect; that is expected, not a bug.
9. **Open/click tracking defaults OFF.** Turning the flags on before the tracking
   subdomain is verified in Resend produces misleading metrics.
10. **`EXTRA_ENV_FILE` is optional.** Missing file is silently skipped; a
    malformed one aborts boot (`set -euo pipefail`), which is the safe direction.
11. **`DATA_DIR` must be writable** by the user running the service; the server
    `mkdir -p`s it at boot but cannot fix ownership.
12. **Resend's `from` must be on a verified domain.** A 403 from Resend for an
    unverified sender is a Resend-side fact, not a pad bug — check the domain
    first.

## 10. Handover notes

* Everything a human needs is in `README.md`; everything config-related is in
  `docs/CONFIG.md`.
* This kit is derived from an in-production pad, generalised: no brand name,
  host, path, port or secret remains in the code or scripts. If you find one,
  that is a bug — remove it and re-run the §8 checklist.
