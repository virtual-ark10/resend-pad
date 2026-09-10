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
