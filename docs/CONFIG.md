# pad-kit — config reference

`config.json` lives next to `server.cjs`, is **gitignored**, and is the single
per-install file that carries branding + behaviour. Start from
`config.example.json`:

```bash
cp config.example.json config.json
```

Everything is optional. Missing fields fall back to the **use-case preset**
(`useCase`) and then to built-in defaults. `config.json` is read at boot for
limits/outreach and re-read on every `GET /api/config`, so a branding tweak is
visible after the client reconnects (a **process restart** is only needed for
`limits`, `outreach` and `useCase`, which are applied at boot).

Environment variables always win over `config.json` for the keys that have both
(`PORT`, `DATA_DIR`, `OUTREACH_*`, `RATE_PER_MINUTE`, `MAX_BODY_BYTES`).

## Safe subset (what `GET /api/config` returns)

The endpoint never leaks secrets. It returns exactly: `useCase`, `brand`,
`from`, `replyTo`, `signature`, `labels`, `tabs`, `templates`, `tracking`,
`limits`, and `outreach: {enabled, siteUrl}`. The attribution **API base, bearer
token and store path are never exposed**.

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `useCase` | string | `generic` | One of `outbound`, `newsletter`, `transactional`, `generic`. Selects the tab set + composer templates. |
| `brand.name` | string | `Email Pad` | Human brand name. |
| `brand.productName` | string | `Email Pad` | Product name shown in the header + `<title>`. |
| `brand.siteUrl` | string | `""` | Public site URL. Used for `{{site_url}}` and as the fallback outreach site. |
| `brand.logoInitials` | string | `PAD` | 2–3 letters in the header logo tile. |
| `brand.tagline` | string | generic | Header sub-line. |
| `brand.accentColor` | string | `""` | Optional CSS colour (e.g. `#0E7A66`); overrides the `--brand` accent. |
| `from` | string | `""` | Default sender. Accepts a display name — `Acme Labs <hello@example.com>` — which is what recipients see in their inbox; a bare address shows the address instead. Also the local-part source for the From dropdown built from Resend's verified domains (each option carries the display name when one is set). |
| `replyTo` | string | `""` | Default Reply-To (falls back to From). Use a bare address here. |
| `signature.html` | string | `""` | Signature block inserted by the **Signature** button and by `{{signature}}` in templates. |
| `signature.text` | string | `""` | Plain-text signature (documentation / future use). |
| `labels.*` | string | generic | Section headings: `composeTitle`, `draftsTitle`, `sentTitle`, `receivedTitle`, `footer`. |
| `tabs[]` | array | preset | Ordered tabs: `{id, label, enabled}`. `id` ∈ `compose`, `drafts`, `sent`, `received`. A tab that is absent or `enabled:false` is hidden (its panel is not rendered). |
| `templates.<key>` | object | preset | `{label, subject, body}`. Placeholders: `{{company}}`, `{{first_name}}`, `{{audience}}`, `{{product}}`, `{{brand}}`, `{{site_url}}`, `{{signature}}`. |
| `tracking.openTracking` | bool | `false` | Documented intent flag. **OFF by default**; see README for how to actually enable open tracking in Resend. |
| `tracking.clickTracking` | bool | `false` | Same, for clicks. |
| `tracking.trackingSubdomain` | string | `""` | Optional custom tracking subdomain (CNAME, verified in Resend) — see README. |
| `limits.ratePerMinute` | int | `60` | Per-IP API requests per minute. |
| `limits.maxBodyBytes` | int | `5242880` | Request body cap (5 MB). |
| `limits.maxRecipients` | int | `50` | Client-side recipient cap per send. |
| `limits.maxAttachmentBytes` | int | `8388608` | Per-attachment cap (8 MB). |
| `outreach.enabled` | bool | `false` | Enables send-time mint/block. Prefer the `OUTREACH_ENABLED` env var. |
| `outreach.siteUrl` | string | `""` | Tracking-link site. |
| `outreach.apiBase` | string | `http://127.0.0.1:3000/api/v1` | Attribution API base. |
| `outreach.storePath` | string | `""` | Local attribution store mirror. |
| `outreach.allowedHosts` | array | `[]` | Extra hostnames allowed in outgoing links (the `siteUrl` host is always allowed). |

## Use-case presets

| useCase | Tabs | Templates | Typical install |
|---|---|---|---|
| `outbound` | Drafts, Compose, Sent, Received | intro, follow-up 1/2/3 | Cold outreach with a review-before-send queue |
| `newsletter` | Draft issue, Review queue, Sent, Inbox | issue, re-engagement | Drafting/reviewing broadcasts before handing to Resend Broadcasts |
| `transactional` | Send, Log | receipt, service notice | Send a one-off / transactional email and see the log |
| `generic` | Compose, Drafts, Sent, Received | blank note | Anything else — everything on, no opinions |

Explicit `tabs`/`templates` in `config.json` override the preset, so you can mix
(e.g. `useCase: "outbound"` plus your own five tabs).

## Example switch

```bash
python3 - <<'PY'
import json
c = json.load(open('config.json'))
c['useCase'] = 'newsletter'
json.dump(c, open('config.json','w'), indent=2)
PY
# restart, then: curl -s -H "X-Pad-Token: $PAD_TOKEN" localhost:3001/api/config | python3 -m json.tool
```

## Leads CRM tab (optional)

The pad can front a small **leads engine** — a second zero-dependency Node
service that owns a JSON lead store and the outreach pipeline, reached through
this server so the browser only ever needs the pad token.

```
pad-kit/leads/
├── server.cjs           # lead store + pipeline API (node:http, no deps)
├── boot.sh              # starts it on 127.0.0.1:3002
├── watchdog.sh          # per-minute health check
└── config.example.json  # optional pipeline definition (stages, cadence)
```

Extra `config.json` fields:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `firstTab` | string | `leads` if present, else `compose` | Which tab opens first. Set `compose` for a mail-first pad. |
| `tabs` | array | preset | Ordered tab list. `{ "id": "leads", "label": "Leads" }` puts the CRM first; `"enabled": false` hides any tab. |
| `leads.enabled` | bool | `true` | `false` hides the tab and makes `/api/crm/*` return 404 — correct when no engine is wired up. |
| `leads.port` | number | `3002` | Must match the engine's `PORT` (env `CRM_PORT` overrides). |

```json
{
  "firstTab": "leads",
  "tabs": [
    { "id": "leads", "label": "Leads" },
    { "id": "compose", "label": "Compose" },
    { "id": "drafts", "label": "Drafts" },
    { "id": "sent", "label": "Sent" },
    { "id": "received", "label": "Received" }
  ],
  "leads": { "enabled": true, "port": 3002 }
}
```

The engine configures itself: brand, stages and follow-up cadence come from
`leads/config.json`, `LEAD_STAGES`, `LEAD_DUE_DAYS` or `LEADPAD_CONFIG`, and it
inherits the brand name from this pad's `config.json` when `BRAND_NAME` is unset.

Same token on purpose — the pad proxies `/api/crm/*` and injects the engine
credential server-side (`X-CRM-Token: $PAD_TOKEN`), which the engine also
accepts. Keep it on localhost; it must never get its own public route.

### Leads tab troubleshooting

| Symptom | Cause / fix |
|---|---|
| Leads tab missing | `leads.enabled: false`, or no engine running — the tab hides itself when `/api/config` reports the engine off. |
| `502 Leads engine unavailable` | Start it: `./leads/boot.sh`; check `leads/watchdog.log`. |
| Tab empty but email works | Engine up, store empty: `GET /api/crm/meta` shows `total: 0`. Seed with `POST /api/crm/leads`. |
| Stage never advances after a send | The send must match a lead's `contact_email` — click "Sync email" in the tab, or `POST /api/crm/sync`. |
