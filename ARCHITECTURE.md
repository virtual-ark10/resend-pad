# pad-kit — architecture

## What it is

A **single-process email pad**: one Node HTTP server (`server.cjs`, `node:http`,
zero npm dependencies) serving one self-contained HTML client (`index.html`) and
a small JSON API in front of the Resend API. All state lives in flat files under
`DATA_DIR`.

```
        browser (single file, no CDN, no build)
                 │  X-Pad-Token on every /api/*
                 ▼
        ┌───────────────────────────────────────────┐
        │ server.cjs  (node:http, CommonJS)         │
        │  • auth + rate limit + body cap           │
        │  • config layer (config.json + presets)   │
        │  • draft store (JSON file, re-read/call)  │
        │  • optional outreach mint/block           │
        └───────┬─────────────────────┬─────────────┘
                │ https               │ fs
                ▼                     ▼
        api.resend.com          DATA_DIR/
        /emails /domains        drafts.json
        /emails/receiving       sent-drafts.jsonl
                                webhooks.jsonl
                ▲
                │ POST /api/webhook  (Svix signature, not PAD_TOKEN)
        Resend → webhook endpoint
```

## Design principles

1. **Zero dependencies, zero build.** No `npm install`, no bundler, no
   transpiler. `node server.cjs` is the whole build. This keeps the deploy
   surface small enough to reason about and immune to supply-chain changes.
2. **Zero external assets in the client.** `index.html` inlines its CSS and JS.
   A CDN outage (or a blocklisted CDN) must never break the pad — this was a real
   production failure in the predecessor app.
3. **Zero brand coupling.** Code and scripts contain no brand name, host, path,
   port or secret. Branding, labels, tabs, templates, tracking flags and limits
   are data (`config.json` + `.env`). One codebase, many installs.
4. **Secrets stay server-side.** `RESEND_API_KEY` and the attribution token are
   read from the process environment and never reach the browser. `GET /api/config`
   returns an explicitly-whitelisted *safe subset*, not "the config minus secrets".
5. **Fail closed where it matters, fail open where it is safer.** The optional
   outreach gate blocks a send it cannot verify (never leaks traffic); the config
   endpoint falls back to defaults in the client (never a blank page); an unknown
   draft id is a JSON 404 (never a crash).
6. **The queue is a file, not a database.** `data/drafts.json` is re-read on
   every request, so an operator (or another agent) can seed/edit drafts with a
   text editor and see them immediately. No migrations, no daemon.

## Config layer

```
built-in DEFAULT_CONFIG ──► use-case PRESET ──► config.json ──► env overrides
        (generic)          (outbound |         (per install)    (PORT, DATA_DIR,
                            newsletter |                          OUTREACH_*,
                            transactional |                       RATE_PER_MINUTE,
                            generic)                              MAX_BODY_BYTES)
```

* `effectiveConfig()` deep-merges those layers (arrays replace, `null`/`undefined`
  never clobber) and is re-evaluated for every `GET /api/config`.
* Limits and the outreach switch are resolved **at boot** (they size buffers and
  pick code paths), so changing them needs a restart; branding does not.
* The presets are the reason a new install can be useful in one edit
  (`"useCase": "outbound"`). Explicit fields always win, so presets are a floor,
  not a cage.

## Request handling

1. `res.setHeader(...)` security headers for every response (nosniff, DENY
   framing, same-origin referrer, CSP with `'self'` only).
2. `/api/*` → `handleApi`, wrapped in a `try/catch` that converts an unexpected
   throw into `500 {"error":"Internal server error"}` instead of a process exit.
3. Rate limit (per socket IP, in-memory bucket) applies to every API route.
4. `/api/health` is the only unauthenticated GET (the watchdog needs it).
   `/api/webhook` authenticates with the **Svix signature** over the raw body
   (`svix-id.svix-timestamp.body`, HMAC-SHA256, 5-minute tolerance,
   `timingSafeEqual`) and is therefore exempt from `PAD_TOKEN`.
5. Everything else requires `X-Pad-Token` (single shared secret, compared
   literally). There are no accounts by design.
6. Static files are served from the kit directory with a resolved-path prefix
   check (directory traversal blocked).

### Send paths

```
POST /api/send                 → payload → maybeInternalize → Resend → relay status
POST /api/drafts/:id/send      → merge client edits over stored draft
                                 → validate from/to/subject (400 if incomplete)
                                 → maybeInternalize
                                 → Resend
                                 → ONLY on 200/201: append sent-drafts.jsonl,
                                   re-read drafts.json, remove the draft
```

`maybeInternalize()` is the outreach seam:

* **disabled (default):** returns the body untouched (plus HTML linkify) and can
  never fail a send.
* **enabled:** re-mints tracking links the attribution API no longer knows, then
  refuses (400) if any link host is outside the allow-list. Fail-closed.

`linkifyHtml()` (in `outreach-links.cjs`, pure and brand-agnostic) always runs
over the HTML body: bare URLs become anchors, idempotently (existing anchors and
attribute values are masked first). Plain-text bodies keep bare URLs.

## Data model (`DATA_DIR`, default `<kit>/data`)

| File | Shape | Semantics |
|---|---|---|
| `drafts.json` | JSON array of `{id, company, to, cc, subject, from, reply_to, text, html, created_at}` | Review-before-send queue. Re-read on every request. `to`/`cc` are comma-separated strings; `html` must be escaped when generated from lead data. |
| `sent-drafts.jsonl` | one JSON object per line `{id, company, subject, to, sent_at, resend_id}` | Append-only send log. Written only after Resend accepts. |
| `webhooks.jsonl` | one `{received_at, event}` per line | Svix-verified archive of every webhook event (received, delivered, opened, clicked…). |

## Deployment layer (no root, no personal crontab)

| Piece | Role |
|---|---|
| `boot.sh` | Self-locating launcher (`$(cd "$(dirname "$0")" && pwd)`), loads `.env` then optional `$EXTRA_ENV_FILE`, defaults `PORT=3001` / `DATA_DIR=<kit>/data`, `exec`s node. |
| `deploy/pad.service` | systemd **user** unit: `Restart=always`, logs to the journal. `systemctl --user enable --now pad.service`. |
| `watchdog.sh` | Per-minute health check: restarts a dead pad (killing explicit PIDs, never a broad pattern) and re-applies the Caddy route when `ROUTE_PATH` is set. |
| `deploy/pad-watchdog.{service,timer}` | Runs `watchdog.sh` every minute under systemd instead of cron. |
| `add_caddy_route.py` | `--path/--port/--admin` parameterised, idempotent Caddy admin-API route insertion (`{path}` → 301, `{path}/*` → strip + reverse_proxy). No sudo. |

## Front end

Single file, three responsibilities:

1. **Auth** — token in `sessionStorage`, sent as `X-Pad-Token`; 401 clears it and
   prompts to reconnect.
2. **Config-driven rendering** — on Connect it fetches `GET /api/config` and
   renders brand name/initials/tagline, the tab bar (order + labels + which tabs
   exist), the composer template list and the limits. If the fetch fails it keeps
   a built-in `DEFAULTS` object, so the UI is never blank.
3. **Flows** — compose/send, draft queue (open/edit/discard), sent list with
   per-email detail, received inbox with reply-into-compose, attachment
   handling, and a signature insert button.

## Security model

| Concern | Handling |
|---|---|
| API key exposure | Server-side only; browser talks to the pad, pad talks to Resend. |
| Authentication | Single shared `PAD_TOKEN` header; constant literal comparison; auth failures logged with masked values. |
| Webhook forgery | Svix HMAC over the raw body with a timestamp tolerance. |
| Abuse | Per-IP rate limit + request body cap, both configurable. |
| Clickjacking / MIME sniffing / XSS | `X-Frame-Options: DENY`, `nosniff`, CSP `default-src 'self'`, output escaping, no remote script origins. |
| Directory traversal | Static file paths resolved and prefix-checked against the kit directory. |
| Secret leakage via config | `GET /api/config` builds a whitelist; API base/token/store path are never returned. |
| Crash-on-bad-input | JSON 404 for unknown ids; `try/catch` around the API handler; syntax check + bogus-id probe after every edit. |

## Extension points

* **New use case** — add an entry to `PRESETS` in `server.cjs` and mirror a
  fallback in `index.html`'s `DEFAULTS` (one object each). No other change.
* **New tab** — add `{id, label}` to `config.tabs` and a matching
  `<section id="panel-<id>">` in `index.html`; the tab bar and visibility are
  driven entirely by config.
* **Different mail provider** — replace `resendRequest()`; the rest of the API
  surface is provider-neutral.
* **Attribution** — flip `OUTREACH_ENABLED` and point the four `OUTREACH_*`
  variables at your service; no code change.

## Deliberate non-goals

No accounts, no database, no ORM, no bundler, no client framework, no external
fonts/icons/CDNs, no background workers inside the pad. The pad is a *review and
send* surface; heavy automation belongs beside it, not inside it.
