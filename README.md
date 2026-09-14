# resend-pad — the outbound email client + leads CRM in one page

A token-gated web app that fuses a working email client (compose / sent /
received / drafts) with a leads CRM (pipeline stages, per-lead history, notes,
replies) in one screen — so sending a message and running the sales pipeline are
the same motion instead of two tools and two tabs.

The outbound engine NewsletterFIT runs on today is this codebase, brand-agnostic:
every brand name, label, tab, template, sender and limit comes from
`config.json`, so a fresh company can be serving campaigns within an hour. Two
small Node processes, **one shared SQLite store**, one token.

```
browser
   │  https://<host>/pad/             (Caddy: /pad/* -> 127.0.0.1:3001)
   ▼
pad (server.cjs + index.html) :3001        ← the only public surface
   │  ├─ Resend API ......... send / sent / received / webhooks (Svix)
   │  ├─ drafts + mail + leads ......... data/pad.db (one store, WAL)
   │  └─ /api/crm/* ────────────────► leads engine (leads/) :3002
                                        (second process, SAME store)
```

The pad owns the UI and the only public route. The leads engine is internal: it
owns the pipeline rules, and the pad proxies to it, injecting the engine's
credential server-side. One URL, one token.

---

## Sequencing is built in — the stages are the sequence

The CRM is not a contact list, it *is* the campaign. Every lead sits on a stage
machine, and every action moves it:

```
Leads -> First Email -> Follow-up 1 -> 2 -> 3 -> 4 -> Qualified
                                              Replied / Won / No / Archived
```

- A successful send advances a lead **exactly one stage**, and the stage is
  frozen into the message record (`stage_at_send`) — moving the lead later never
  rewrites what the history says.
- **Follow-up cadence is data, not calendar reminders.** `dueDays` maps stages to
  days (`first_email: 3, follow_up_1: 4, ...`), a view computes who is due a
  touch right now (`/api/followups-due`), and the Leads tab sorts overdue first.
- An inbound reply moves the lead to **Replied**. Opens and clicks are recorded
  (Resend webhooks, deduped) but never move a stage — engagement is measurement,
  not state. A bounce cannot look opened; a broken funnel is impossible by
  construction.
- Drafts sitting in the queue are still **Leads** — a lead only leaves the
  bucket when the email was actually sent. No stage is ever auto-advanced to a
  terminal state; a human PATCH decides Won / No / Archived.

## Interpolation: templates that fill themselves

Compose ships with template presets per use case (outbound, newsletter,
transactional, generic — each with an intro + follow-up set, all configurable).
Placeholders `{{company}}`, `{{first_name}}`, `{{audience}}` are interpolated
from the compose form or straight from the lead record:

- "Email this lead" on a CRM row opens Compose pre-filled with the contact and a
  template applied — one click from a lead to a personalised first-touch message.
- Drafts can be queued from CSV/JSON (`tools/seed_drafts.py`), so a batch of
  leads becomes a batch of ready-to-send emails in one command.

## Built for agents to drive

The whole loop is a JSON API behind the same token. Everything the UI can do, an
agent can do: queue drafts, send, read sent/received, advance or patch leads,
log notes, sync inbound mail, answer "who is due a follow-up". Inbound events
arrive over a Svix-verified webhook (`/api/webhook`) into the same store. The
NewsletterFIT pipeline runs exactly this way — AI agents doing the research,
drafting and sequencing, the pad executing sends and collecting replies — and
the optional `outreach-links.cjs` module extends it with send-time link
internalization: every tracking link must be a server-minted token on the
brand's own domain, and any external URL refuses the send (fail-closed).

## What's in here

| Path | What it is |
| --- | --- |
| `server.cjs` | Pad process (`:3001`): send, drafts, inbox, webhook receiver, `/api/crm/*` proxy. |
| `index.html` | The whole client — single file, no build, no CDNs. |
| `db.cjs` | The shared store: `node:sqlite` (falls back to JSON/JSONL on older Node), WAL, bind-safe queries, derived counters. |
| `hooks.cjs` | Event rules — the backbone that turns a fired event into the next action (same rules for pad and engine, one store). |
| `leads/` | The CRM engine (`:3002`): pipeline API, stages, cadence, auth, rate limits — reads the pad's store, never a copy. |
| `outreach-links.cjs` | Optional send-time link minting/blocking for attribution services (default OFF). |
| `boot.sh` / `watchdog.sh` | Launcher + per-minute health check (restarts on failure, re-applies the Caddy route). |
| `add_caddy_route.py` | Parameterised Caddy route helper (`--path --port`), idempotent, no sudo. |
| `tools/` | `seed_drafts.py` (queue a batch from CSV/JSON, safely). |
| `tests/` | Engagement-store and tracking HTTP tests. |
| `deploy/` | systemd user unit + watchdog timer. |
| `Dockerfile` / `docker-compose.yml` | Containerised run (see `docs/CONTAINER.md`). |
| `docs/CONFIG.md` | Full config reference. |

## Run it

Requirements: Linux, Node ≥ 22.5 (for `node:sqlite`; JSON fallback on older),
a Resend account with a verified sending domain. Plain stdlib — no npm install.

```bash
cp config.example.json config.json   # branding, tabs, templates (docs/CONFIG.md)
cp .env.example .env                 # RESEND_API_KEY, RESEND_WEBHOOK_SECRET, PAD_TOKEN
./boot.sh                            # pad on 127.0.0.1:3001
./leads/boot.sh                      # leads engine on 127.0.0.1:3002
```

Open `http://127.0.0.1:3001/`, paste `PAD_TOKEN`, and you are in. The token is
remembered in the browser afterwards; the API key never leaves the server.

`config.json` picks the use case — which tabs and templates you get:

| `useCase` | Tabs | Templates |
| --- | --- | --- |
| `outbound` | Drafts, Compose, Sent, Received, Leads | intro + 3 follow-ups |
| `newsletter` | Draft issue, Review queue, Sent, Inbox | issue, re-engagement |
| `transactional` | Send, Log | receipt, service notice |
| `generic` | Compose, Drafts, Sent, Received | blank note |

## API (the agent surface)

Pad (token: `X-Pad-Token`):

```
GET  /api/health                     no auth — used by the watchdogs
GET  /api/config                     safe config subset for the UI
POST /api/send                       send, with send-time link internalization
GET  /api/sent | /api/received | /api/archive
GET  /api/drafts   POST /api/drafts/:id/send   PUT|DELETE /api/drafts/:id
POST /api/webhook                    Resend events (Svix signature)
ANY  /api/crm/*                      proxied to the leads engine
```

Leads engine (token: `X-CRM-Token`; the pad injects it):

```
GET   /api/meta                      brand + stages + per-stage counts
GET   /api/leads[?stage=]            leads with derived last-touch / next-due
GET   /api/leads/:id                 one lead + activity timeline
POST  /api/leads                     create      PATCH /api/leads/:id
POST  /api/leads/:id/note            append a note
GET   /api/followups-due             who is due a touch, overdue first
POST  /api/sync                      log pad sent+inbox mail against leads
```

## Deploy

- **Public path** — `python3 add_caddy_route.py --path /pad --port 3001` talks to
  the local Caddy admin API (no sudo, idempotent).
- **Supervision** — `deploy/` has systemd user units for the pad and a
  per-minute watchdog timer; `watchdog.sh` also re-applies a vanished Caddy
  route. Your choice of crontab, systemd, or Docker.
- **Multiple brands on one Resend account** — `PAD_DOMAINS` filters Sent/Received
  to this brand's addresses, because Resend's APIs are account-wide. The UI says
  how many messages were hidden.

## Operations notes

- **Both services run `server.cjs`** — the engine under
  `node server.cjs --leads-engine`. Never `pkill -f 'node server.cjs'`; kill by
  port owner, or a pad restart takes the CRM down with it.
- **Editing `index.html`?** It is re-read per request, so changes are live
  immediately — and never linted. Extract the inline script and
  `node --check` it before reloading; one nested quote takes the whole UI down.

## License

MIT — see [LICENSE](LICENSE).