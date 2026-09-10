# pad-kit

A **brand-agnostic, config-driven email pad** built on the [Resend](https://resend.com)
API. One small Node process serves a single self-contained web client for
composing, queuing, sending and reading email, plus JSON files on disk for the
draft queue, the send log and a Svix-verified webhook archive.

* **Zero npm dependencies** — plain `node:http`, CommonJS (`.cjs`), no build step.
* **Zero external assets** in the client — hand-rolled CSS/JS, no CDNs (that is a
  hard rule; a CDN-blocked browser killed v1 of this app).
* **Zero brand coupling** — every brand name, label, tab, template, sender and
  limit comes from `config.json`. The same code runs a cold-outreach pad, a
  newsletter drafting pad or a transactional send log.
* **Optional leads CRM** — add a `Leads` tab backed by the bundled `leads/`
  engine: pipeline stages with colours, per-lead email history, notes, and
  automatic stage advancement when you email a lead. Off in one config line.
* **Send-time outreach link minting/blocking is optional and OFF by default.**

```
pad-kit/
├── server.cjs           # the whole HTTP API (node:http, no deps)
├── index.html           # single-file client (no CDNs, no build)
├── outreach-links.cjs   # OPTIONAL link mint/block + linkify helper
├── leads/               # OPTIONAL leads CRM engine (own process, own store)
│   ├── server.cjs       #   lead store + pipeline API
│   ├── boot.sh          #   starts it on 127.0.0.1:3002
│   ├── watchdog.sh      #   per-minute health check
│   └── config.example.json  #  optional pipeline definition
├── boot.sh              # self-locating launcher (loads .env)
├── watchdog.sh          # per-minute health check + Caddy route self-heal
├── add_caddy_route.py   # parameterised Caddy route helper (--path --port)
├── config.example.json  # copy to config.json (gitignored)
├── .env.example         # copy to .env (gitignored)
├── deploy/              # systemd user unit + timer for the watchdog
├── tools/seed_drafts.py # seed the draft queue from CSV/JSON, safely
├── docs/CONFIG.md       # full config reference
└── data/                # drafts.json, sent-drafts.jsonl, webhooks.jsonl
```

---

## 1. Requirements

* Linux, Node.js ≥ 18 (tested on Node 26), `python3` (only for the Caddy helper,
  the watchdog's route check and the seed tool).
* A Resend account with **a verified sending domain**.
* A place to keep a long random `PAD_TOKEN` — that token *is* the pad's login.

## 2. Install

```bash
git clone <this repo> pad-kit      # or copy the directory anywhere
cd pad-kit
cp config.example.json config.json # then edit branding (see docs/CONFIG.md)
cp .env.example .env               # then fill in the secrets
chmod +x boot.sh watchdog.sh
```

Nothing assumes a particular path: `boot.sh` derives its own directory from
`$(cd "$(dirname "$0")" && pwd)`, and `DATA_DIR` defaults to `<kit>/data`.

## 3. Configure

### `.env` (secrets — gitignored)

```bash
RESEND_API_KEY=re_...            # required for send / sent / received
RESEND_WEBHOOK_SECRET=whsec_...  # required for the webhook archive
PAD_TOKEN=$(head -c 32 /dev/urandom | base64)   # the pad's login
#PORT=3001
#DATA_DIR=/srv/pad-kit/data
#EXTRA_ENV_FILE=/etc/mybrand/shared.env   # optional second env file
```

### `config.json` (branding + behaviour — gitignored)

```json
{
  "useCase": "outbound",
  "brand": { "name": "StarterLens", "productName": "StarterLens Email Pad",
             "siteUrl": "https://starterlens.com", "logoInitials": "SL" },
  "from": "hello@starterlens.com",
  "signature": { "html": "<p>Best,<br>The StarterLens team</p>" },
  "tracking": { "openTracking": false, "clickTracking": false }
}
```

Full field reference: **[docs/CONFIG.md](docs/CONFIG.md)**. Pick a use case:

| `useCase` | Tabs | Templates |
|---|---|---|
| `outbound` | Drafts, Compose, Sent, Received | intro + 3 follow-ups |
| `newsletter` | Draft issue, Review queue, Sent, Inbox | issue, re-engagement |
| `transactional` | Send, Log | receipt, service notice |
| `generic` | Compose, Drafts, Sent, Received | blank note |

## 4. Run

```bash
./boot.sh                     # foreground; Ctrl-C stops it
PAD_LOG=./pad.log ./boot.sh & # background with a log file
```

The client is served at **`/`** on the port (`http://127.0.0.1:3001/` by
default). Open it, paste `PAD_TOKEN`, press **Connect**.

## 5. Verify (copy-paste)

```bash
PORT=3001
TOKEN=$(grep -E '^PAD_TOKEN=' .env | cut -d= -f2-)

curl -s -o /dev/null -w 'health %{http_code}\n' "http://127.0.0.1:$PORT/api/health"      # 200
curl -s -o /dev/null -w 'no-token %{http_code}\n' "http://127.0.0.1:$PORT/api/drafts"    # 401
curl -s -o /dev/null -w 'authed %{http_code}\n' \
     -H "X-Pad-Token: $TOKEN" "http://127.0.0.1:$PORT/api/drafts"                        # 200
curl -s -H "X-Pad-Token: $TOKEN" "http://127.0.0.1:$PORT/api/config" | python3 -m json.tool
curl -s -o /dev/null -w 'bogus-id %{http_code}\n' \
     -H "X-Pad-Token: $TOKEN" "http://127.0.0.1:$PORT/api/drafts/does-not-exist"         # 404 (server stays up)
```

### Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | none | Liveness (`{ok, uptime, useCase}`) — for the watchdog |
| GET | `/api/config` | token | Safe config subset (brand, labels, tabs, templates, useCase, limits) |
| POST | `/api/send` | token | Send an arbitrary email via Resend |
| GET | `/api/domains` | token | Verified domains (populates the From dropdown) |
| GET | `/api/sent?page=` | token | Recent sent emails |
| GET | `/api/email/:id` | token | One sent email |
| GET | `/api/received?limit=` | token | Received emails (Resend receiving API) |
| GET | `/api/received/:id` | token | One received email |
| POST | `/api/webhook` | Svix signature | Webhook receiver → `data/webhooks.jsonl` |
| GET | `/api/archive?limit=` | token | Read the webhook archive back |
| GET | `/api/drafts` | token | The draft queue (re-read from disk every call) |
| GET | `/api/drafts/:id` | token | One draft — **JSON 404** for unknown ids, never a crash |
| PUT | `/api/drafts/:id` | token | Save edits |
| DELETE | `/api/drafts/:id` | token | Discard |
| POST | `/api/drafts/:id/send` | token | Send a draft; removed on Resend 200/201 only |

## 6. Resend wiring

1. **Domain** — Resend → Domains → add your domain and publish the DNS records
   it shows, until it reads *verified*. The pad works with **any** verified
   domain: it never hardcodes one; the From dropdown is built from
   `GET /api/domains` filtered to `status === "verified"`, using the local part
   of `config.from`.
2. **API key** — Resend → API Keys → create a *sending* key → `RESEND_API_KEY`.
   It stays server-side; the browser never sees it.
3. **Webhooks** — Resend → Webhooks → add `https://<your-host>/<route>/api/webhook`
   and copy the **Svix signing secret** (`whsec_...`) into
   `RESEND_WEBHOOK_SECRET`. Verify:

   ```bash
   curl -s -H "X-Pad-Token: $TOKEN" "http://127.0.0.1:$PORT/api/archive" | python3 -m json.tool
   ```
   Events land in `data/webhooks.jsonl`. Unsigned/expired requests get `400`.
4. **Open/click events (optional, OFF by default)** — in the same webhook, tick
   `email.opened` and `email.clicked` alongside `email.received`/`email.delivered`.
   The archive stores them; nothing else changes. Set
   `tracking.openTracking` / `tracking.clickTracking` to `true` in `config.json`
   only once you have decided you want them.
5. **Custom tracking subdomain (optional)** — to have opens/clicks served from
   your own domain rather than Resend's link host, add e.g. `track.yourdomain.com`
   in Resend → Domains as a **CNAME** pointing at the target Resend shows, wait
   for verification, then put the host in `config.tracking.trackingSubdomain`
   and turn the flags on. Keep both flags **false** until the CNAME is verified —
   half-configured tracking silently inflates your open rates.

## 7. Drafts

The queue is `data/drafts.json` — a plain JSON array, **re-read on every
request**, so editing the file is visible in the UI without a restart.

Draft shape: `{id, company, to, cc, subject, from, reply_to, text, html, created_at}`
where `to`/`cc` are comma-separated strings and `html` **must be escaped**
(`&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`) when the data came from a lead list, or the
editor shows broken entities.

Seed a batch safely (creates the file, never duplicates an id, preserves
existing drafts, re-reads and writes atomically, escapes html by default):

```bash
python3 tools/seed_drafts.py sample.csv
python3 tools/seed_drafts.py leads.json --dry-run
```

CSV header: `id,company,to,cc,subject,from,reply_to,text,html` (only the ones you
need). A draft with `text` but no `html` gets an escaped `<p>` body generated so
it opens correctly in the editor.

## 8. Deploy without touching anyone's crontab

**systemd user unit** (no sudo):

```bash
cp deploy/pad.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pad.service
systemctl --user status pad.service
journalctl --user -u pad.service -f
# optional, so it survives logout:  sudo loginctl enable-linger "$USER"
```
Edit `WorkingDirectory`/`ExecStart` if the kit is not at `~/pad-kit`.

**Per-minute health watchdog** — either the systemd timer that ships with it:

```bash
cp deploy/pad-watchdog.{service,timer} ~/.config/systemd/user/
systemctl --user enable --now pad-watchdog.timer
```
…or run `watchdog.sh` from any scheduler (classic crontab works too:
`* * * * * /path/to/pad-kit/watchdog.sh`). It restarts the pad if
`/api/health` fails and re-applies the Caddy route if it vanished.

**Expose it publicly through Caddy** (route + upstream port are arguments):

```bash
python3 add_caddy_route.py --path /pad --port 3001
python3 add_caddy_route.py --path /email --port 3100 --admin http://127.0.0.1:2019
```
Idempotent, talks to the local Caddy admin API on `127.0.0.1:2019`, **no sudo**.
It adds `{path}` → 301 → `{path}/` and `{path}/*` → strip prefix → reverse_proxy.
Set `ROUTE_PATH` / `CADDY_ADMIN` in `.env` so the watchdog can re-apply it.

## 9. Outreach link minting (optional)

Only for installs that run an attribution service. **Default: disabled** — the
send path then never touches mint/block code. To enable:

```bash
OUTREACH_ENABLED=1
OUTREACH_API_BASE=http://127.0.0.1:3000/api/v1
OUTREACH_BEARER_TOKEN=...
OUTREACH_STORE_PATH=/var/lib/yoursite/attribution.json
OUTREACH_SITE_URL=https://yoursite.example
```

With it on, `POST /api/send` and `POST /api/drafts/:id/send` re-mint tracking
links their API no longer knows about, and refuse (HTTP 400 with a readable
message) to send an email containing a link to a host outside
`OUTREACH_SITE_URL` (+ `outreach.allowedHosts`). Fail-closed by design. Bare URLs
in the HTML body are always linkified before sending, whether or not outreach is
enabled.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` on every call | Wrong/missing `X-Pad-Token`; the browser stores it in `sessionStorage`, so a new tab needs the token again. |
| Send works, sent list 503 | `RESEND_API_KEY` missing/invalid. |
| `/api/webhook` always 400 | `RESEND_WEBHOOK_SECRET` missing, or the body was re-encoded in transit. |
| Drafts invisible | You edited `DATA_DIR`; the server reads `$DATA_DIR/drafts.json`. |
| Server died after a route call | You found the old crash class — this kit already returns JSON 404s for unknown ids and wraps the API handler in a try/catch. Re-check with `node -c server.cjs` after any edit. |
| Watchdog and a manual restart fight | Kill the exact PID (`pgrep -f '<kit>/server.cjs'`), confirm it is down, then start once. |

## 11. License

MIT — see [LICENSE](LICENSE).
