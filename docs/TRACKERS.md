# Trackers and Analytics

Two sidebar groups, one rule: only what a source actually reported is shown.

- **Emails → Trackers**: delivery and engagement for what this pad sends (Resend).
- **Insights → Analytics**: website-side metrics (Google Analytics 4, PostHog, or
  anything pushed in over the MCP bridge).

## Trackers

Every event Resend reports lands in `tracker_events` (SQLite, same store as the
rest of the pad) and the Dashboard charts it.

| Event | Meaning |
| --- | --- |
| `sent` | accepted by Resend |
| `delivered` | accepted by the receiving server |
| `delivery_delayed` | the receiving server asked Resend to retry |
| `opened` | open pixel fired (needs open tracking on the domain) |
| `clicked` | a tracked link was followed (needs click tracking on the domain) |
| `bounced` | hard or soft bounce, with the bounce type recorded |
| `complained` | marked as spam by the recipient |
| `failed` | rejected outright |
| `scheduled`, `canceled` | scheduled sends and cancellations |

Where the events come from:

1. **Webhook** (`POST /api/webhook`, Svix-signed): the live feed. Point a Resend
   webhook at `https://<your-pad>/api/webhook` with `RESEND_WEBHOOK_SECRET` set
   and every event arrives as it happens.
2. **Refresh** (`POST /api/trackers/refresh`): polls `GET /emails?limit=100` and
   records each send's `last_event`. This is how the dashboard shows anything at
   all when the webhook is not configured yet, and it is the button in the UI.

Deduplication is on `(resend_id, type, occurred_at, url)`, so a replayed webhook
or a repeated poll never inflates a number. A second `opened` at a different time
is a second open, which is what Resend reports and what the counts mean.

Rates shown: delivery, open, click, click-to-open, bounce, complaint. Funnel and
per-lead engagement count **unique sends**, not events.

Charts: volume per day (line), delivery quality per day (stacked bar), funnel
(horizontal bar), event mix (doughnut), plus most-clicked links, most-engaged
leads and the recent event feed.

Open and click tracking must be enabled per domain in Resend, and the pad says so
in the panel when `tracking.openTracking` / `tracking.clickTracking` are false.
Those two flags live in `config.json`; the Resend-side setting is the one that
actually decides whether opens and clicks are ever reported.

## Analytics

Providers are fetched **server-side**; no key ever reaches the browser.

| Provider | Needs | Notes |
| --- | --- | --- |
| Google Analytics 4 | `analytics.ga4.propertyId` + a service-account key at `analytics.ga4.credentialsFile` | The service account must have read access to the property. Metrics default to sessions, totalUsers, screenPageViews, conversions, fetched from the Data API `runReport` per day. |
| PostHog | `analytics.posthog.host`, `.projectId`, `.apiKey` (personal API key) | Uses the insights trend endpoint for `$pageview` (total and daily uniques). |
| MCP push | nothing beyond the pad token | `POST /api/analytics/ingest` with `{"provider":"posthog","metric":"pageviews","points":[{"day":"2026-09-10","value":42}]}`. Use it when the provider's API is not reachable from the pad host, or when an MCP client already holds the data. |

Nothing is invented. A provider that is not configured says exactly which key is
missing; one that is configured but returns nothing says what the provider
answered. Points pushed in are stored in `analytics_points` (keyed by provider,
metric and day) and shown in the "Pushed over MCP" card.

### Pushing from an MCP client

```bash
curl -s -X POST "https://<your-pad>/api/analytics/ingest" \
  -H "x-pad-token: $PAD_TOKEN" -H 'content-type: application/json' \
  -d '{"provider":"posthog","metric":"pageviews",
       "points":[{"day":"2026-09-10","value":42},{"day":"2026-09-11","value":51}]}'
```

Re-pushing the same day updates it rather than adding a second row, so a client
can safely re-send a window.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/trackers/summary?days=30` | totals, rates, series, funnel, top links, top leads, recent events, tracking settings |
| GET | `/api/trackers/events?limit=&type=&resend_id=` | raw event feed |
| GET | `/api/trackers/email/:resendId` | one send plus its event timeline |
| POST | `/api/trackers/refresh` | poll Resend for current statuses |
| GET | `/api/analytics/summary?days=30` | provider cards with metrics, totals and any error |
| POST | `/api/analytics/ingest` | MCP bridge |

## Making opens and clicks actually arrive

Three things must all be true at once, and each one fails silently:

1. **Tracking is on for the domain** - Resend -> Domains -> the domain -> open
   and click tracking. The domain object reports `open_tracking` /
   `click_tracking`; the pad reads those into its own config.
2. **A tracking subdomain is verified.** Click links and the open pixel are
   rewritten to it, so without it nothing can be observed. This install uses
   `analytics`:

   ```
   CNAME  analytics  ->  links1.resend-dns.com.   (region eu-west-1, status verified)
   ```

   Proof in a delivered message: the links read `https://analytics.starterlens.com/...`
   and the injected open pixel is an `img` on the same host. The API shows
   `tracking_subdomain: "analytics"` on the domain.
3. **The webhook is subscribed to `email.opened` and `email.clicked`.** A Resend
   webhook defaults to delivery events only, and an event it is not subscribed
   to is never sent - the dashboard then shows zero opens forever with no error
   anywhere. The pad checks the subscription on every Refresh and prints it in
   the panel when a type is missing. To fix it:

   ```bash
   curl -X PATCH https://api.resend.com/webhooks/<webhook-id> \
     -H "Authorization: Bearer $RESEND_API_KEY" -H 'Content-Type: application/json' \
     -d '{"events":["email.sent","email.delivered","email.delivery_delayed","email.opened",
                    "email.clicked","email.bounced","email.complained","email.failed","email.received"]}'
   ```

   Note: the PATCH reply is only `{object, id}` - it does not echo the events, so
   read the webhook back with `GET /webhooks` to confirm. `email.canceled` is not
   a valid event type and is rejected; `email.scheduled` is accepted.

Without (2) the events cannot be generated; without (3) they are generated and
thrown away. The `Refresh from Resend` button only recovers what `GET /emails`
reports as `last_event`, which never includes opens or clicks.
