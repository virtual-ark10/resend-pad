// pad-kit server — brand-agnostic email pad (zero npm dependencies, plain node:http)
// ---------------------------------------------------------------------------
// This file is deliberately generic. Every brand/host specific value comes from
// config.json (see config.example.json) or from environment variables loaded by
// boot.sh (.env). There is no hardcoded host, path, or brand anywhere.
//
// Guarantees:
//   - Server-side Resend API key (never exposed to browsers)
//   - X-Pad-Token auth on all /api/* except /api/health and /api/webhook
//   - /api/webhook is authenticated by Svix signature (RESEND_WEBHOOK_SECRET)
//   - In-memory rate limiting + body cap (both configurable)
//   - Draft queue (review-before-send) re-read from disk on EVERY request
//   - OPTIONAL outreach link minting/blocking (OUTREACH_ENABLED, default OFF)
//
// DRAFT-STORE RULE: never let an unknown draft id crash the process. Every
// draft route returns a JSON 404 for an unknown id (see the crash pitfall in
// AGENT.md). A top-level try/catch also converts any unexpected throw into a
// 500 JSON response instead of killing the server.
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_DIR = __dirname;

// ---------------------------------------------------------------------------
// Config layer
// ---------------------------------------------------------------------------

const CONFIG_FILE = process.env.CONFIG_FILE || path.join(BASE_DIR, 'config.json');

// Built-in defaults (used when config.json is missing or a field is omitted).
const DEFAULT_CONFIG = {
  brand: {
    name: 'Email Pad',
    productName: 'Email Pad',
    siteUrl: '',
    logoInitials: 'PAD',
    tagline: 'Outbound + inbox · powered by Resend',
  },
  from: '',
  replyTo: '',
  signature: { html: '', text: '' },
  useCase: 'generic',
  labels: {
    composeTitle: 'Compose',
    draftsTitle: 'Ready to send',
    sentTitle: 'Sent emails',
    receivedTitle: 'Received (last 30 days)',
    footer: 'Self-contained client — no external assets, no build step.',
  },
  tabs: null,        // null => the use-case preset decides
  templates: null,   // null => the use-case preset decides
  tracking: {
    openTracking: false,   // OFF by default — enable deliberately
    clickTracking: false,  // OFF by default — enable deliberately
    trackingSubdomain: '',
  },
  limits: {
    ratePerMinute: 60,
    maxBodyBytes: 5 * 1024 * 1024,
    maxRecipients: 50,
    maxAttachmentBytes: 8 * 1024 * 1024,
  },
  outreach: {
    enabled: false,
    siteUrl: '',
    apiBase: 'http://127.0.0.1:3000/api/v1',
    storePath: '',
    allowedHosts: [],
  },
};

// Use-case presets. `config.json -> useCase` selects one; explicit fields in
// config.json override anything the preset sets.
const PRESETS = {
  outbound: {
    tabs: [
      { id: 'drafts', label: 'Drafts', enabled: true },
      { id: 'compose', label: 'Compose', enabled: true },
      { id: 'sent', label: 'Sent', enabled: true },
      { id: 'received', label: 'Received', enabled: true },
    ],
    templates: {
      intro: {
        label: 'Intro (first contact)',
        subject: '{{company}} × {{product}} — quick idea',
        body: '<p>Hi {{first_name}},</p><p>I work on <strong>{{product}}</strong> and wanted to reach out about {{company}}.</p><p>One line on why I think it is relevant: {{audience}}.</p><p>Would you be open to a short note on what we do and whether it fits?</p>{{signature}}',
      },
      fu1: {
        label: 'Follow-up 1 (3–5 days)',
        subject: 'Re: {{company}} × {{product}} — quick idea',
        body: '<p>Hi {{first_name}},</p><p>Just floating this back up — making sure my last note did not get buried.</p><p>Happy to send over a one-pager if that is easier than a call.</p>{{signature}}',
      },
      fu2: {
        label: 'Follow-up 2 (1 week)',
        subject: 'Re: {{company}} × {{product}} — quick idea',
        body: '<p>Hi {{first_name}},</p><p>One more follow-up on this. If the timing is wrong I will close the loop, no hard feelings.</p>{{signature}}',
      },
      fu3: {
        label: 'Follow-up 3 (final)',
        subject: 'Re: {{company}} × {{product}} — quick idea',
        body: '<p>Hi {{first_name}},</p><p>Last note from me on this. If it is not a fit right now, thanks for your time either way.</p>{{signature}}',
      },
    },
  },
  newsletter: {
    tabs: [
      { id: 'compose', label: 'Draft issue', enabled: true },
      { id: 'drafts', label: 'Review queue', enabled: true },
      { id: 'sent', label: 'Sent', enabled: true },
      { id: 'received', label: 'Inbox', enabled: true },
    ],
    templates: {
      issue: {
        label: 'Issue draft',
        subject: '{{product}} — issue #…',
        body: '<p>Hi {{first_name}},</p><p>Here is this week\'s edition.</p><h3>The lead</h3><p>…</p><h3>What I am reading</h3><ul><li>…</li></ul>{{signature}}',
      },
      re_engage: {
        label: 'Re-engagement',
        subject: 'Still useful to you?',
        body: '<p>Hi {{first_name}},</p><p>You have not opened the last few issues — want to stay on the list?</p><p>No action needed to stay subscribed; one click to stop.</p>{{signature}}',
      },
    },
  },
  transactional: {
    tabs: [
      { id: 'compose', label: 'Send', enabled: true },
      { id: 'sent', label: 'Log', enabled: true },
    ],
    templates: {
      receipt: {
        label: 'Receipt / confirmation',
        subject: 'Your {{product}} confirmation',
        body: '<p>Hi {{first_name}},</p><p>Confirming we received your request. Nothing else is needed from you.</p>{{signature}}',
      },
      notice: {
        label: 'Service notice',
        subject: '{{product}}: important update',
        body: '<p>Hi {{first_name}},</p><p>Quick service note about your account.</p>{{signature}}',
      },
    },
  },
  generic: {
    tabs: [
      { id: 'compose', label: 'Compose', enabled: true },
      { id: 'drafts', label: 'Drafts', enabled: true },
      { id: 'sent', label: 'Sent', enabled: true },
      { id: 'received', label: 'Received', enabled: true },
    ],
    templates: {
      blank: { label: 'Blank short note', subject: '', body: '<p>Hi {{first_name}},</p><p></p>{{signature}}' },
    },
  },
};

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// deep-merge: `over` wins; null/undefined in `over` never clobbers a value;
// arrays are replaced wholesale (not concatenated).
function deepMerge(base, over) {
  if (over === null || over === undefined) return base;
  if (Array.isArray(over)) return over.slice();
  if (typeof over !== 'object') return over;
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? Object.assign({}, base) : {};
  for (const k of Object.keys(over)) {
    const b = out[k];
    const o = over[k];
    if (o && typeof o === 'object' && !Array.isArray(o)) out[k] = deepMerge(b, o);
    else if (o !== null && o !== undefined) out[k] = o;
  }
  return out;
}

function effectiveConfig() {
  const file = readJsonFile(CONFIG_FILE) || {};
  const useCase = file.useCase || process.env.PAD_USE_CASE || DEFAULT_CONFIG.useCase;
  const preset = PRESETS[useCase] || PRESETS.generic;
  let merged = deepMerge(DEFAULT_CONFIG, preset);
  merged = deepMerge(merged, file);
  merged.useCase = useCase;
  if (!Array.isArray(merged.tabs)) merged.tabs = PRESETS.generic.tabs;
  if (!merged.templates || typeof merged.templates !== 'object') merged.templates = PRESETS.generic.templates;
  return merged;
}

const CFG = effectiveConfig();

// ---- leads engine (optional sibling service on an internal port) ----------
// The pads' Leads tab talks to it through this server, which injects the token,
// so the browser only ever needs the pad token. Disable with config.json:
//   "leads": { "enabled": false }
const CRM_HOST = process.env.CRM_HOST || '127.0.0.1';
const CRM_PORT = parseInt(process.env.CRM_PORT || String((CFG.leads && CFG.leads.port) || 3002), 10);
const LEADS_ENABLED = !(CFG.leads && CFG.leads.enabled === false);
const LIMITS = Object.assign({}, DEFAULT_CONFIG.limits, CFG.limits || {});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3001', 10);
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const PAD_TOKEN = process.env.PAD_TOKEN || '';
const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, 'data');
const MAX_BODY = parseInt(String(process.env.MAX_BODY_BYTES || LIMITS.maxBodyBytes), 10);
const API_LIMIT = parseInt(String(process.env.RATE_PER_MINUTE || LIMITS.ratePerMinute), 10);
const API_WINDOW_MS = 60 * 1000;

function envFlag(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

// Outreach link minting (send-time internalization) is OPT-IN. When disabled the
// send path never calls the mint/block logic at all — see maybeInternalize().
const OUTREACH_ENABLED = envFlag(process.env.OUTREACH_ENABLED, CFG.outreach.enabled);
const OUTREACH_CONF = {
  apiBase: process.env.OUTREACH_API_BASE || CFG.outreach.apiBase || 'http://127.0.0.1:3000/api/v1',
  token: process.env.OUTREACH_BEARER_TOKEN || '',
  storePath: process.env.OUTREACH_STORE_PATH || CFG.outreach.storePath || '',
  siteUrl: process.env.OUTREACH_SITE_URL || CFG.outreach.siteUrl || CFG.brand.siteUrl || '',
  allowedHosts: Array.isArray(CFG.outreach.allowedHosts) ? CFG.outreach.allowedHosts : [],
};

const outreach = require('./outreach-links.cjs');

if (!RESEND_API_KEY) console.warn('[WARN] RESEND_API_KEY not set — send/list endpoints will return 503 from Resend');
if (!PAD_TOKEN) console.warn('[WARN] PAD_TOKEN not set — /api/* (except /api/health, /api/webhook) will reject with 401');
if (OUTREACH_ENABLED && !OUTREACH_CONF.siteUrl) console.warn('[WARN] OUTREACH_ENABLED=1 but OUTREACH_SITE_URL is empty — set it or sends will be blocked');
if (!OUTREACH_ENABLED) console.log('[INFO] outreach mint/block disabled (OUTREACH_ENABLED is off) — sends go straight through');

fs.mkdirSync(DATA_DIR, { recursive: true });
const WEBHOOK_LOG = path.join(DATA_DIR, 'webhooks.jsonl');
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
const SENT_LOG = path.join(DATA_DIR, 'sent-drafts.jsonl');

// ---------------------------------------------------------------------------
// SQLite store (node:sqlite, no npm dependencies).
//
// Leads, outbound mail, replies, drafts and the audit trail live in one file:
// DATA_DIR/pad.db. The legacy JSON/JSONL files above are imported once on first
// boot (and renamed *.imported) when the store is available; if the runtime has
// no node:sqlite (Node < 22.5), every helper below falls back to those files so
// the kit still works.
// ---------------------------------------------------------------------------
const LEADS_CFG = (CFG.leads && typeof CFG.leads === 'object') ? CFG.leads : {};
const store = require('./db.cjs').open(DATA_DIR, {
  stages: LEADS_CFG.stages || CFG.stages,
  replyStage: LEADS_CFG.replyStage,
  wonStage: LEADS_CFG.wonStage,
  discoverFromInbox: LEADS_CFG.discoverFromInbox,
  ignoreSenders: LEADS_CFG.ignoreSenders,
});
// The rules table is the backbone: an event fired here (or by the leads engine)
// is drained on the next request and performs its next action.
const rules = store ? require('./hooks.cjs').buildRules(store) : null;

// ---------------------------------------------------------------------------
// Resend tracking + analytics providers
//
// Trackers: every delivery/engagement event Resend reports (webhook, or polled
// from the API) lands in tracker_events and the Dashboard charts it.
// Analytics: website-side metrics. GA4 and PostHog are fetched server-side when
// configured, and an MCP client can push points in through /api/analytics/ingest
// when it is not (see docs/TRACKERS.md).
// ---------------------------------------------------------------------------
const TRACKING_CFG = (CFG.tracking && typeof CFG.tracking === 'object') ? CFG.tracking : {};
const ANALYTICS_CFG = (CFG.analytics && typeof CFG.analytics === 'object') ? CFG.analytics : {};
const UA = 'pad-kit-tracking/1.0';
const DEFAULT_GA_METRICS = ['sessions', 'totalUsers', 'screenPageViews', 'conversions'];
const TRACKER_TYPES = ['sent', 'delivered', 'delivery_delayed', 'opened', 'clicked', 'bounced', 'complained', 'failed', 'scheduled', 'canceled'];

/** Minimal JSON over HTTP(S) with a timeout, so no provider can hang a request. */
function httpsJson(urlStr, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ error: 'bad url: ' + urlStr }); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request({
      method,
      host: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}, headers),
      timeout,
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: r.statusCode, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: `timeout after ${timeout}ms` }); });
    req.on('error', (e) => resolve({ error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Resend webhook event -> a tracker_events row. */
function trackFromWebhook(event) {
  if (!store || !event || typeof event.type !== 'string') return null;
  const type = event.type.startsWith('email.') ? event.type.slice('email.'.length) : null;
  if (!type || !TRACKER_TYPES.includes(type)) return null;
  const d = event.data || {};
  const to = Array.isArray(d.to) ? d.to[0] : d.to;
  const bounce = d.bounce && d.bounce.type ? String(d.bounce.type).toLowerCase() : null;
  return store.trackEvent({
    type,
    resend_id: d.email_id || d.id || null,
    occurred_at: d.created_at || event.created_at || new Date().toISOString(),
    url: (d.click && d.click.link) || null,
    user_agent: d.user_agent || null,
    ip: d.ip || null,
    bounce_type: bounce ? (bounce.startsWith('perm') ? 'hard' : 'soft') : null,
    subject: d.subject || null,
    to_addr: to || null,
    source: 'webhook',
    raw: event,
  });
}

/** Ask Resend for the current status of recent sends and record what we learn. */
function refreshTracking(limit = 100) {
  return new Promise((resolve) => {
    resendRequest('GET', `/emails?limit=${Math.min(Math.max(Number(limit) || 100, 1), 100)}`, null, (err, status, rbody) => {
      if (err) return resolve({ ok: false, error: err.message, stored: 0 });
      if (status !== 200) return resolve({ ok: false, error: `resend ${status}`, stored: 0 });
      const payload = safeJson(rbody) || {};
      const items = Array.isArray(payload.data) ? payload.data : [];
      let stored = 0;
      let skipped = 0;
      for (const item of items) {
        const type = String(item.last_event || '').toLowerCase();
        if (!type) { skipped += 1; continue; }
        const res = store.trackEvent({
          type,
          resend_id: item.id,
          occurred_at: item.created_at || new Date().toISOString(),
          subject: item.subject || null,
          to_addr: Array.isArray(item.to) ? item.to[0] : item.to,
          source: 'poll',
        });
        if (res && res.stored) stored += 1; else skipped += 1;
      }
      // Opens and clicks only ever arrive by webhook, so what the webhook is
      // subscribed to decides whether the dashboard can see them at all. Check
      // it while we are here and cache it, so the UI can warn instead of
      // showing a silent zero.
      resendRequest('GET', '/webhooks', null, (werr, wstatus, wbody) => {
        const REQUIRED = ['email.opened', 'email.clicked'];
        if (!werr && wstatus === 200) {
          const list = (safeJson(wbody) || {}).data || [];
          const active = list.filter((w) => w.status === 'enabled' || w.status === 'active');
          const events = [...new Set(active.flatMap((w) => w.events || []))];
          store.setMeta('tracking_webhook', {
            at: new Date().toISOString(),
            endpoints: active.map((w) => w.endpoint),
            events,
            missing: REQUIRED.filter((e) => !events.includes(e)),
          });
        } else if (werr) {
          console.warn('[TRACK] could not read the webhook subscriptions:', werr.message);
        }
        resolve({ ok: true, checked: items.length, stored, unchanged: skipped, at: new Date().toISOString() });
      });
    });
  });
}

// ---- Google Analytics 4 (Data API, service account) ----
let gaToken = { value: null, expires: 0 };
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function ga4AccessToken(cfg) {
  if (gaToken.value && Date.now() < gaToken.expires) return { token: gaToken.value };
  let creds = cfg.credentialsJson || null;
  if (!creds && cfg.credentialsFile) {
    try { creds = JSON.parse(fs.readFileSync(cfg.credentialsFile, 'utf8')); }
    catch (e) { return { error: `cannot read analytics.ga4.credentialsFile: ${e.message}` }; }
  }
  if (!creds || !creds.client_email || !creds.private_key) {
    return { error: 'no service account: set analytics.ga4.credentialsFile (or credentialsJson)' };
  }
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  let signature;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    signature = b64url(signer.sign(creds.private_key));
  } catch (e) { return { error: 'could not sign the JWT: ' + e.message }; }
  const r = await httpsJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${encodeURIComponent(`${header}.${claims}.${signature}`)}`,
  });
  if (r.error) return { error: r.error };
  if (!r.json || !r.json.access_token) return { error: (r.json && (r.json.error_description || r.json.error)) || 'token exchange failed' };
  gaToken = { value: r.json.access_token, expires: Date.now() + ((r.json.expires_in || 3600) - 60) * 1000 };
  return { token: gaToken.value };
}

async function analyticsGa4(days) {
  const cfg = ANALYTICS_CFG.ga4 || {};
  const out = { id: 'ga4', name: cfg.name || 'Google Analytics 4', via: 'Data API', configured: false, metrics: {}, totals: {}, source: null, days: [] };
  for (let i = days - 1; i >= 0; i -= 1) out.days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  if (cfg.enabled === false) { out.error = 'disabled in config.json'; return out; }
  const propertyId = cfg.propertyId || process.env.GA4_PROPERTY_ID || '';
  if (!propertyId) { out.error = 'set analytics.ga4.propertyId in config.json'; return out; }
  const tok = await ga4AccessToken(cfg);
  if (tok.error) { out.error = tok.error; return out; }
  const metrics = Array.isArray(cfg.metrics) && cfg.metrics.length ? cfg.metrics : DEFAULT_GA_METRICS;
  const r = await httpsJson(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok.token },
    body: {
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: metrics.map((m) => ({ name: m })),
      limit: days + 5,
    },
  });
  if (r.error) { out.error = r.error; return out; }
  if (r.json && r.json.error) { out.error = r.json.error.message || 'GA4 error'; return out; }
  const points = {};
  for (const m of metrics) points[m] = [];
  for (const row of (r.json && r.json.rows) || []) {
    const raw = (row.dimensionValues && row.dimensionValues[0] && row.dimensionValues[0].value) || '';
    const day = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
    (row.metricValues || []).forEach((mv, i) => {
      const name = metrics[i];
      if (points[name]) points[name].push({ day, value: Number(mv.value) || 0 });
    });
  }
  out.configured = true;
  out.metrics = points;
  out.totals = Object.fromEntries(Object.entries(points).map(([k, v]) => [k, v.reduce((n, pt) => n + pt.value, 0)]));
  out.source = 'api';
  out.property_id = String(propertyId);
  try { for (const [m, pts] of Object.entries(points)) store.putAnalyticsPoints('ga4', m, pts, 'api'); } catch (e) { /* cache is best effort */ }
  return out;
}

// ---- PostHog (insights API; MCP clients can push instead) ----
async function analyticsPosthog(days) {
  const cfg = ANALYTICS_CFG.posthog || {};
  const out = { id: 'posthog', name: cfg.name || 'PostHog', via: 'API', configured: false, metrics: {}, totals: {}, source: null, days: [] };
  for (let i = days - 1; i >= 0; i -= 1) out.days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  if (cfg.enabled === false) { out.error = 'disabled in config.json'; return out; }
  const host = (cfg.host || process.env.POSTHOG_HOST || '').replace(/\/$/, '');
  const projectId = cfg.projectId || process.env.POSTHOG_PROJECT_ID || '';
  const apiKey = cfg.apiKey || process.env.POSTHOG_API_KEY || '';
  if (!host || !projectId || !apiKey) {
    out.error = 'set analytics.posthog.host, .projectId and .apiKey in config.json (or push points via /api/analytics/ingest)';
  } else {
    const wanted = [
      { metric: 'pageviews', event: cfg.event || '$pageview', math: 'total' },
      { metric: 'users', event: cfg.event || '$pageview', math: 'dau' },
    ];
    const collected = {};
    const errors = [];
    for (const w of wanted) {
      const qs = `events=${encodeURIComponent(JSON.stringify([{ id: w.event, math: w.math }]))}&date_from=-${days}d&interval=day`;
      const r = await httpsJson(`${host}/api/projects/${encodeURIComponent(projectId)}/insights/trend/?${qs}`, {
        headers: { Authorization: 'Bearer ' + apiKey },
      });
      if (r.error) { errors.push(r.error); continue; }
      if (r.json && r.json.detail) { errors.push(String(r.json.detail)); continue; }
      const first = (r.json && Array.isArray(r.json.result) && r.json.result[0]) || null;
      if (!first || !Array.isArray(first.data)) { errors.push(`unexpected shape for ${w.metric}`); continue; }
      collected[w.metric] = (first.days || []).map((day, i) => ({ day: String(day).slice(0, 10), value: Number(first.data[i]) || 0 }));
    }
    if (Object.keys(collected).length) {
      out.configured = true;
      out.metrics = collected;
      out.totals = Object.fromEntries(Object.entries(collected).map(([k, v]) => [k, v.reduce((n, pt) => n + pt.value, 0)]));
      out.source = 'api';
      try { for (const [m, pts] of Object.entries(collected)) store.putAnalyticsPoints('posthog', m, pts, 'api'); } catch (e) { /* best effort */ }
    } else {
      out.error = errors[0] || 'no data returned';
    }
  }
  if (!out.configured) {
    const pushed = store.analyticsPoints('posthog', { days });
    if (Object.keys(pushed.metrics).length) {
      out.metrics = pushed.metrics;
      out.via = 'MCP push';
      out.source = 'ingest';
      out.updated_at = pushed.updated_at;
      out.totals = Object.fromEntries(Object.entries(pushed.metrics).map(([k, v]) => [k, v.reduce((n, pt) => n + (pt.value || 0), 0)]));
      out.note = (out.error ? out.error + ' - ' : '') + 'showing points pushed in over the MCP bridge';
    }
  }
  return out;
}
if (store) console.log(`[DB] sqlite store ready: ${store.file} (stages: ${store.stageOrder.join(', ')})`);
else console.warn('[DB] node:sqlite unavailable in this Node runtime - falling back to JSON/JSONL files');

// ---------------------------------------------------------------------------
// Draft store (review-before-send queue) — re-read on every request
// ---------------------------------------------------------------------------

function readDrafts() {
  if (store) { try { return store.listDrafts(); } catch (e) { console.warn('[DB] readDrafts:', e.message); } }
  try {
    const raw = fs.readFileSync(DRAFTS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeDrafts(arr) {
  if (store) { try { return store.replaceDrafts(arr); } catch (e) { console.warn('[DB] writeDrafts:', e.message); } }
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(arr, null, 2) + '\n');
}
// Every outbound send is recorded against its lead, with the body and the lead's
// stage snapshotted at send time, so history survives a stage change later.
function appendSentDraft(entry) {
  if (store) {
    try {
      store.recordSend({
        id: entry.id,
        resendId: entry.resend_id,
        to: entry.to,
        cc: entry.cc,
        from: entry.from,
        replyTo: entry.reply_to,
        inReplyTo: entry.in_reply_to,
        subject: entry.subject,
        text: entry.text,
        html: entry.html,
        templateId: entry.template_id,
        campaign: entry.campaign,
        status: entry.status || 'sent',
      });
      return Promise.resolve(true);
    } catch (e) { console.warn('[DB] recordSend:', e.message); }
  }
  return new Promise((resolve) => {
    fs.appendFile(SENT_LOG, JSON.stringify(entry) + '\n', (err) => resolve(!err));
  });
}

const rateBuckets = new Map(); // ip -> { count, resetAt }

function rateCheck(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + API_WINDOW_MS };
    rateBuckets.set(ip, b);
  }
  b.count += 1;
  return b.count <= API_LIMIT;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  console.log(`  -> ${status} ${String(res.reqPath || '?')}`);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function forbidden(res, msg) {
  sendJson(res, 403, { error: msg });
}

// ---------------------------------------------------------------------------
// The safe, front-end-visible subset of the config (never contains secrets)
// ---------------------------------------------------------------------------

// Thin passthrough to the leads engine: same method/body, engine credential
// added server-side, response streamed back unchanged.
function proxyCrm(req, res, targetPath) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const up = http.request({
      host: CRM_HOST,
      port: CRM_PORT,
      path: targetPath,
      method: req.method,
      headers: { 'X-CRM-Token': PAD_TOKEN, 'Content-Type': 'application/json' },
    }, (r) => {
      res.writeHead(r.statusCode || 502, {
        'Content-Type': r.headers['content-type'] || 'application/json',
        'Cache-Control': 'no-store',
      });
      r.pipe(res);
    });
    up.on('error', () => sendJson(res, 502, { error: 'Leads engine unavailable — is it running? (leads/boot.sh)' }));
    if (chunks.length) up.write(Buffer.concat(chunks));
    up.end();
  });
}

function safeConfig() {
  const c = effectiveConfig();
  const lim = Object.assign({}, DEFAULT_CONFIG.limits, c.limits || {});
  return {
    useCase: c.useCase,
    brand: c.brand,
    from: c.from || '',
    replyTo: c.replyTo || '',
    signature: c.signature || { html: '', text: '' },
    labels: Object.assign({}, DEFAULT_CONFIG.labels, c.labels || {}),
    tabs: (Array.isArray(c.tabs) ? c.tabs : []).filter((t) => t && t.id && t.enabled !== false),
    // lets the client hide the Leads tab when no engine is wired up
    leads: { enabled: LEADS_ENABLED, port: CRM_PORT },
    tracking: {
      openTracking: !!TRACKING_CFG.openTracking,
      clickTracking: !!TRACKING_CFG.clickTracking,
      trackingSubdomain: TRACKING_CFG.trackingSubdomain || '',
      webhookConfigured: !!WEBHOOK_SECRET,
    },
    analyticsProviders: [
      { id: 'ga4', name: (ANALYTICS_CFG.ga4 && ANALYTICS_CFG.ga4.name) || 'Google Analytics 4', configured: !!((ANALYTICS_CFG.ga4 && ANALYTICS_CFG.ga4.propertyId)) },
      { id: 'posthog', name: (ANALYTICS_CFG.posthog && ANALYTICS_CFG.posthog.name) || 'PostHog', configured: !!((ANALYTICS_CFG.posthog && ANALYTICS_CFG.posthog.host && ANALYTICS_CFG.posthog.apiKey)) },
    ],
    redraftReasons: LEADS_CFG.redraftReasons || ['Too long', 'Too salesy', 'Wrong angle', 'Wrong offer', 'Tone off', 'Missing detail', 'Not personalised'],
    templates: c.templates || {},
    tracking: Object.assign({}, DEFAULT_CONFIG.tracking, c.tracking || {}),
    limits: {
      ratePerMinute: lim.ratePerMinute,
      maxBodyBytes: lim.maxBodyBytes,
      maxRecipients: lim.maxRecipients,
      maxAttachmentBytes: lim.maxAttachmentBytes,
      maxAttachmentMB: Math.floor(lim.maxAttachmentBytes / (1024 * 1024)),
    },
    outreach: {
      enabled: OUTREACH_ENABLED,
      // only the public site origin is exposed — never the API base or token
      siteUrl: OUTREACH_ENABLED ? (OUTREACH_CONF.siteUrl || '') : '',
    },
  };
}

// ---------------------------------------------------------------------------
// Send-time link handling
// ---------------------------------------------------------------------------

// Applied always (pure, no network, no config): bare URLs in the HTML body
// become clickable anchors. text/plain keeps bare URLs, which is correct.
function finalizeHtml(html) {
  try { return outreach.linkifyHtml(html); } catch { return html; }
}

// Returns { text, html, minted }. When outreach is DISABLED this does no
// mint/block work at all and can never fail the send.
function maybeInternalize(rawText, rawHtml, leadId) {
  const text = rawText || '';
  const html = rawHtml || '';
  if (!OUTREACH_ENABLED) {
    return Promise.resolve({ text, html: finalizeHtml(html), minted: [] });
  }
  return outreach.internalize(text, html, leadId, OUTREACH_CONF).then((out) => ({
    text: out.text,
    html: finalizeHtml(out.html),
    minted: out.minted || [],
  }));
}

// ---------------------------------------------------------------------------
// Resend outbound relay (server-side key)
// ---------------------------------------------------------------------------

function resendRequest(method, apiPath, body, cb) {
  const options = {
    hostname: 'api.resend.com',
    path: apiPath,
    method,
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` },
    timeout: 30000,
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(body);
  }
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(); });
    res.on('end', () => cb(null, res.statusCode, data));
  });
  req.on('timeout', () => req.destroy(new Error('Resend API timeout')));
  req.on('error', (e) => cb(e));
  if (body) req.write(body);
  req.end();
}

// ---------------------------------------------------------------------------
// Svix webhook signature verification (Resend webhooks)
// ---------------------------------------------------------------------------

function verifyWebhook(rawBody, headers) {
  if (!WEBHOOK_SECRET) {
    return { ok: false, reason: 'RESEND_WEBHOOK_SECRET not configured' };
  }
  const id = headers['svix-id'] || headers['Svix-Id'];
  const ts = headers['svix-timestamp'] || headers['Svix-Timestamp'];
  const sigHeader = headers['svix-signature'] || headers['Svix-Signature'];
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing svix headers' };

  const now = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (!tsNum || Math.abs(now - tsNum) > 300) return { ok: false, reason: 'timestamp outside tolerance' };

  const secret = WEBHOOK_SECRET.startsWith('whsec_') ? WEBHOOK_SECRET.slice(6) : WEBHOOK_SECRET;
  let secretBytes;
  try { secretBytes = Buffer.from(secret, 'base64'); } catch { return { ok: false, reason: 'bad secret' }; }

  const signedContent = `${id}.${ts}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  const provided = sigHeader.split(' ').map((part) => {
    const i = part.indexOf(',');
    return i >= 0 ? part.slice(i + 1) : part;
  }).filter(Boolean);

  const ok = provided.some((sig) => {
    if (!sig || sig.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

function appendWebhookLog(entry) {
  const line = JSON.stringify(entry);
  return new Promise((resolve) => {
    fs.appendFile(WEBHOOK_LOG, line + '\n', (err) => resolve(!err));
  });
}

function readBody(req, res, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      sendJson(res, 413, { error: 'Payload too large' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8'), size));
  req.on('error', () => { /* client aborted */ });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const ip = req.socket.remoteAddress || 'unknown';
  res.reqPath = `${req.method} ${url}`;
  console.log(`[${new Date().toISOString()}] ${res.reqPath} (${ip})`);

  // Security headers for everything
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'");

  if (url.startsWith('/api/')) {
    // Defensive: an unexpected throw must never take the process down.
    try {
      return handleApi(req, res, url, ip);
    } catch (e) {
      console.error('[ERROR] unhandled in handleApi:', e && e.stack ? e.stack : e);
      try { return sendJson(res, 500, { error: 'Internal server error' }); } catch { /* headers sent */ }
      return undefined;
    }
  }

  // ---- Static files (single-file front end + optional local assets) ----
  let filePath = url.split('?')[0] === '/' ? '/index.html' : url.split('?')[0];
  filePath = path.join(BASE_DIR, filePath);
  const realPath = path.resolve(filePath);
  const baseDir = path.resolve(BASE_DIR);
  if (!realPath.startsWith(baseDir)) {
    console.log('[SECURITY] Directory traversal blocked:', url);
    return forbidden(res, 'Forbidden');
  }
  fs.readFile(realPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    let ct = 'text/plain';
    if (realPath.endsWith('.html')) ct = 'text/html';
    else if (realPath.endsWith('.css')) ct = 'text/css';
    else if (realPath.endsWith('.js') || realPath.endsWith('.cjs')) ct = 'application/javascript';
    else if (realPath.endsWith('.json')) ct = 'application/json';
    else if (realPath.endsWith('.svg')) ct = 'image/svg+xml';
    else if (realPath.endsWith('.png')) ct = 'image/png';
    else if (realPath.endsWith('.ico')) ct = 'image/x-icon';
    else if (realPath.endsWith('.webmanifest')) ct = 'application/manifest+json';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

function handleApi(req, res, url, ip) {
  const p = url.split('?')[0]; // path without query string
  if (!rateCheck(ip)) return sendJson(res, 429, { error: 'Rate limit exceeded — slow down' });

  // Health (no auth — used by the watchdog / systemd health checks)
  if (req.method === 'GET' && p === '/api/health') {
    return sendJson(res, 200, { ok: true, uptime: process.uptime(), useCase: CFG.useCase });
  }

  // Webhook receiver — auth via Svix signature, NOT PAD_TOKEN
  if (req.method === 'POST' && p === '/api/webhook') {
    return readBody(req, res, (rawBody) => {
      const v = verifyWebhook(rawBody, req.headers);
      if (!v.ok) {
        console.warn('[WEBHOOK] Rejected:', v.reason);
        return sendJson(res, 400, { error: `Invalid webhook: ${v.reason}` });
      }
      let event;
      try { event = JSON.parse(rawBody); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      if (store) {
        try {
          const d = event.data || {};
          if (d.email_id) store.updateEmailStatus(d.email_id, String(event.type || '').split('.').pop());
          store.event('system', d.email_id || d.id || null, 'webhook', { type: event.type || 'unknown' });
          const tracked = trackFromWebhook(event);
          if (tracked && tracked.stored) console.log(`[TRACK] ${event.type} for ${d.email_id || '?'}`);
        } catch (e) { console.warn('[DB] webhook:', e.message); }
      }
      appendWebhookLog({ received_at: new Date().toISOString(), event }).then((written) => {
        console.log(`[WEBHOOK] ${event.type || 'unknown'} archived (${written ? 'OK' : 'WRITE FAILED'})`);
        if (!written) return sendJson(res, 500, { error: 'archive write failed' });
        return sendJson(res, 200, { ok: true, type: event.type || 'unknown' });
      });
    });
  }

  // Everything else requires PAD_TOKEN
  const auth = req.headers['x-pad-token'];
  if (!PAD_TOKEN || auth !== PAD_TOKEN) {
    const mask = (s) => s ? s.slice(0, 4) + '…' + s.slice(-4) : '(none)';
    console.log(`[AUTH-FAIL] ${req.method} ${url} got=${mask(auth)} expected=${mask(PAD_TOKEN)}`);
    return sendJson(res, 401, { error: 'Unauthorized — missing or invalid token' });
  }

  // Leads tab: /api/crm/* -> leads engine, already authorised by the pad token
  // we just verified. The browser never sees or sends a second credential.
  if (p === '/api/crm' || p.startsWith('/api/crm/')) {
    if (!LEADS_ENABLED) return sendJson(res, 404, { error: 'Leads tab disabled in config.json' });
    return proxyCrm(req, res, '/api' + p.slice('/api/crm'.length));
  }

  // Drain the event queue: whatever fired it (a send, a reply, a redraft, the
  // leads engine), the rule for that event runs here before the response.
  if (store && rules) {
    try {
      const drained = store.processEvents(rules);
      if (drained.processed) console.log(`[EVENTS] drained ${drained.processed}, actions: ${JSON.stringify(drained.actions)}`);
    } catch (e) { console.warn('[EVENTS] drain failed:', e.message); }
  }

  // ---- Front-end config (branding, labels, tabs, templates, use case) ----
  if (req.method === 'GET' && p === '/api/config') {
    return sendJson(res, 200, safeConfig());
  }

  if (req.method === 'POST' && p === '/api/send') {
    return readBody(req, res, (body) => {
      let data;
      try { data = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      if (!data.from) return sendJson(res, 400, { error: 'from is required' });
      const leadId = 'manual-' + (String((Array.isArray(data.to) ? data.to[0] : data.to) || 'unknown').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unknown');
      const doSend = () => resendRequest('POST', '/emails', JSON.stringify(data), (err, status, rbody) => {
        if (err) return sendJson(res, 502, { error: 'Failed to contact Resend', details: err.message });
        if (status === 200 || status === 201) {
          const accepted = safeJson(rbody) || {};
          console.log('[SEND] Email accepted, id:', String(rbody).slice(0, 200));
          if (store) {
            try {
              store.recordSend({
                id: accepted.id || undefined,
                resendId: accepted.id,
                from: data.from,
                to: data.to,
                cc: data.cc,
                replyTo: data.reply_to,
                inReplyTo: data.headers && data.headers['In-Reply-To'],
                subject: data.subject,
                text: data.text,
                html: data.html,
                status: 'sent',
              });
            } catch (e) { console.warn('[DB] recordSend (manual):', e.message); }
          }
        }
        sendJson(res, status, safeJson(rbody));
      });
      const rawText = data.text || '';
      const rawHtml = data.html || '';
      if (!rawText.trim() && !rawHtml.trim()) return doSend();
      maybeInternalize(rawText, rawHtml, leadId).then((out) => {
        data.text = out.text;
        data.html = out.html;
        if (out.minted.length) console.log(`[SEND] Internalized ${out.minted.length} link(s) for ${leadId} at send time`);
        doSend();
      }).catch((e) => {
        console.log(`[SEND] BLOCKED ${leadId}: ${e.message}`);
        sendJson(res, 400, { error: `Not sent: ${e.message}` });
      });
      return undefined;
    });
  }

  if (req.method === 'GET' && p === '/api/domains') {
    return resendRequest('GET', '/domains', null, (err, status, rbody) => {
      if (err) return sendJson(res, 502, { error: 'Failed to contact Resend', details: err.message });
      sendJson(res, status, safeJson(rbody));
    });
  }

  if (req.method === 'GET' && p.startsWith('/api/email/')) {
    const id = p.slice('/api/email/'.length);
    return resendRequest('GET', `/emails/${encodeURIComponent(id)}`, null, (err, status, rbody) => {
      if (err) return sendJson(res, 502, { error: 'Failed to contact Resend', details: err.message });
      sendJson(res, status, safeJson(rbody));
    });
  }

  if (req.method === 'GET' && p.startsWith('/api/sent')) {
    const page = new URL(url, 'http://x').searchParams.get('page') || '1';
    return resendRequest('GET', `/emails?page=${encodeURIComponent(page)}`, null, (err, status, rbody) => {
      if (err) return sendJson(res, 502, { error: 'Failed to contact Resend', details: err.message });
      sendJson(res, status, safeJson(rbody));
    });
  }

  // Received emails (Resend receiving API)
  if (req.method === 'GET' && p === '/api/received') {
    const q = new URL(url, 'http://x');
    const limit = q.searchParams.get('limit') || '50';
    const after = q.searchParams.get('after') || '';
    const before = q.searchParams.get('before') || '';
    let rp = `/emails/receiving?limit=${encodeURIComponent(limit)}`;
    if (after) rp += `&after=${encodeURIComponent(after)}`;
    if (before) rp += `&before=${encodeURIComponent(before)}`;
    return resendRequest('GET', rp, null, (err, status, rbody) => {
      if (err) return sendJson(res, 502, { error: 'Failed to contact Resend', details: err.message });
      const payload = safeJson(rbody);
      if (store && payload && Array.isArray(payload.data)) {
        // Persist what we just fetched (permanent record + lead linkage) and
        // hide anything the user deleted with the ✕ in the UI.
        const hidden = new Set(store.deletedReplyIds());
        for (const msg of payload.data) {
          try { store.saveReply(msg); } catch (e) { console.warn('[DB] saveReply:', e.message); }
        }
        payload.data = payload.data.filter((msg) => !hidden.has(String(msg.id)));
      }
      sendJson(res, status, payload);
    });
  }

  if (req.method === 'GET' && p.startsWith('/api/received/')) {
    const id = p.slice('/api/received/'.length);
    return resendRequest('GET', `/emails/receiving/${encodeURIComponent(id)}`, null, (err, status, rbody) => {
      if (err) return sendJson(res, 502, { error: 'Failed to contact Resend', details: err.message });
      sendJson(res, status, safeJson(rbody));
    });
  }

  // Webhook archive (read back, most recent first)
  if (req.method === 'GET' && p === '/api/archive') {
    const limit = parseInt(new URL(url, 'http://x').searchParams.get('limit') || '50', 10);
    return fs.readFile(WEBHOOK_LOG, 'utf8', (err, content) => {
      if (err) return sendJson(res, 200, { data: [] });
      const lines = content.split('\n').filter(Boolean).slice(-limit).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean).reverse();
      return sendJson(res, 200, { data: lines });
    });
  }

  // ---- Replies, leads and the audit trail (SQLite only) ----
  // Every handler below is wrapped: a throw inside a readBody callback would
  // otherwise become an unhandled rejection and take the pad down with it.
  const storeFail = (e) => {
    console.warn('[DB] request failed:', e.message);
    return sendJson(res, 500, { error: 'store error', details: e.message });
  };
  const withStore = (fn) => {
    try { return fn(); } catch (e) { return storeFail(e); }
  };

  // The ✕ in the UI calls DELETE /api/replies/:id: the message is soft-deleted,
  // stays in the database for history, and is filtered out of /api/received.
  if (store && p === '/api/replies' && req.method === 'GET') {
    return withStore(() => {
      const q = new URL(url, 'http://x');
      sendJson(res, 200, {
        data: store.listReplies({
          leadId: q.searchParams.get('lead') || undefined,
          includeDeleted: q.searchParams.get('include_deleted') === '1',
          limit: parseInt(q.searchParams.get('limit') || '200', 10),
        }),
      });
    });
  }

  if (store && req.method === 'DELETE' && p.startsWith('/api/replies/')) {
    return withStore(() => {
      const id = decodeURIComponent(p.slice('/api/replies/'.length));
      const ok = store.deleteReply(id);
      sendJson(res, ok ? 200 : 404, ok ? { ok: true, id } : { error: 'Reply not found', id });
    });
  }

  if (store && req.method === 'GET' && p.startsWith('/api/replies/')) {
    return withStore(() => {
      const id = decodeURIComponent(p.slice('/api/replies/'.length));
      const row = store.get('SELECT * FROM replies WHERE id = ?', id);
      if (!row) return sendJson(res, 404, { error: 'Reply not found', id });
      return sendJson(res, 200, row);
    });
  }

  if (store && p === '/api/leads' && req.method === 'GET') {
    return withStore(() => {
      const q = new URL(url, 'http://x');
      const converted = q.searchParams.get('converted');
      sendJson(res, 200, {
        data: store.listLeads({
          stage: q.searchParams.get('stage') || undefined,
          converted: converted === null ? undefined : converted === '1' || converted === 'true',
          limit: parseInt(q.searchParams.get('limit') || '500', 10),
        }),
      });
    });
  }

  if (store && p === '/api/leads' && req.method === 'POST') {
    return readBody(req, res, (body) => withStore(() => {
      let data; try { data = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const id = store.upsertLead(data);
      if (!id) return sendJson(res, 400, { error: 'an email address is required' });
      const rest = JSON.parse(JSON.stringify(data));
      delete rest.stage;
      if (Object.keys(rest).length) store.updateLead(id, rest);
      if (data.stage) store.setStage(id, String(data.stage), { by: 'user', note: data.note || null });
      return sendJson(res, 200, store.leadDetail(id));
    }));
  }

  if (store && p.startsWith('/api/leads/') && (req.method === 'GET' || req.method === 'PATCH' || req.method === 'POST')) {
    const id = decodeURIComponent(p.slice('/api/leads/'.length));
    if (req.method === 'GET') {
      return withStore(() => {
        const detail = store.leadDetail(id);
        return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'Lead not found', id });
      });
    }
    return readBody(req, res, (body) => withStore(() => {
      let data; try { data = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      if (!store.get('SELECT id FROM leads WHERE id = ?', id)) return sendJson(res, 404, { error: 'Lead not found', id });
      const stage = data.stage;
      const rest = JSON.parse(JSON.stringify(data));
      delete rest.stage;
      delete rest.note;
      if (Object.keys(rest).length) store.updateLead(id, rest);
      if (stage) store.setStage(id, String(stage), { by: 'user', note: data.note || null });
      return sendJson(res, 200, { lead: store.get('SELECT * FROM leads WHERE id = ?', id), detail: store.leadDetail(id) });
    }));
  }

  if (store && p === '/api/stats' && req.method === 'GET') {
    return withStore(() => sendJson(res, 200, store.stats()));
  }

  if (store && p === '/api/emails' && req.method === 'GET') {
    return withStore(() => {
      const q = new URL(url, 'http://x');
      sendJson(res, 200, {
        data: store.listEmails({
          leadId: q.searchParams.get('lead') || undefined,
          limit: parseInt(q.searchParams.get('limit') || '200', 10),
        }),
      });
    });
  }

  // ---- Redraft: send a draft back with a reason, and learn from it ----
  // The note is stored against the draft and the lead, the draft leaves the
  // queue (status 'redraft'), and the event below feeds the rules table.
  if (store && req.method === 'POST' && p.startsWith('/api/drafts/') && p.endsWith('/redraft')) {
    const draftId = decodeURIComponent(p.slice('/api/drafts/'.length, -'/redraft'.length));
    return readBody(req, res, (body) => withStore(() => {
      let data; try { data = JSON.parse(body || '{}'); } catch { data = {}; }
      if (!store.getDraft(draftId)) return sendJson(res, 404, { error: 'Draft not found', id: draftId });
      const out = store.redraft(draftId, { reason: data.reason, note: data.note });
      if (rules) store.processEvents(rules);
      return sendJson(res, 200, Object.assign(out, { guidance: store.redraftGuidance() }));
    }));
  }

  // What keeps getting sent back, for whoever writes the next draft.
  if (store && req.method === 'GET' && p === '/api/redraft-guidance') {
    return withStore(() => sendJson(res, 200, store.redraftGuidance()));
  }

  // The backbone, visible: recent events plus anything still queued.
  if (store && req.method === 'GET' && p === '/api/events') {
    return withStore(() => {
      const q = new URL(url, 'http://x');
      sendJson(res, 200, {
        data: store.recentEvents({
          limit: parseInt(q.searchParams.get('limit') || '100', 10),
          leadId: q.searchParams.get('lead') || undefined,
        }),
        pending: store.pendingEvents(),
      });
    });
  }

  if (store && req.method === 'POST' && p === '/api/events/drain') {
    return withStore(() => sendJson(res, 200, rules ? store.processEvents(rules) : { processed: 0, actions: [] }));
  }

  // ---- Trackers: Resend delivery + engagement ----
  if (store && p === '/api/trackers/summary' && req.method === 'GET') {
    return withStore(() => {
      const days = Math.max(1, Math.min(parseInt(new URL(url, 'http://x').searchParams.get('days') || '30', 10) || 30, 365));
      sendJson(res, 200, Object.assign(store.trackerSummary({ days }), {
        tracking: {
          openTracking: !!TRACKING_CFG.openTracking,
          clickTracking: !!TRACKING_CFG.clickTracking,
          trackingSubdomain: TRACKING_CFG.trackingSubdomain || '',
          webhook_configured: !!WEBHOOK_SECRET,
          webhook_url: (TRACKING_CFG.publicBaseUrl || '') + '/api/webhook',
          webhook_checked_at: (store.getMeta('tracking_webhook', {}) || {}).at || null,
          webhook_events: (store.getMeta('tracking_webhook', {}) || {}).events || [],
          webhook_missing: (store.getMeta('tracking_webhook', {}) || {}).missing || [],
        },
      }));
    });
  }

  if (store && p === '/api/trackers/events' && req.method === 'GET') {
    return withStore(() => {
      const q = new URL(url, 'http://x');
      sendJson(res, 200, {
        data: store.trackerEvents({
          limit: parseInt(q.searchParams.get('limit') || '100', 10),
          type: q.searchParams.get('type') || undefined,
          resendId: q.searchParams.get('resend_id') || undefined,
        }),
      });
    });
  }

  if (store && p.startsWith('/api/trackers/email/') && req.method === 'GET') {
    return withStore(() => {
      const id = decodeURIComponent(p.slice('/api/trackers/email/'.length));
      sendJson(res, 200, store.trackerTimeline(id));
    });
  }

  // Pull the current status of recent sends from Resend and record what changed.
  if (store && p === '/api/trackers/refresh' && req.method === 'POST') {
    return readBody(req, res, (body) => withStore(() => {
      let limit = 100;
      try { limit = JSON.parse(body || '{}').limit || 100; } catch (e) { /* default */ }
      refreshTracking(limit).then((out) => {
        out.summary = store.trackerSummary({ days: 30 });
        sendJson(res, out.ok ? 200 : 502, out);
      });
      return undefined;
    }));
  }

  // ---- Analytics providers (GA4, PostHog) ----
  if (p === '/api/analytics/summary' && req.method === 'GET') {
    const days = Math.max(1, Math.min(parseInt(new URL(url, 'http://x').searchParams.get('days') || '30', 10) || 30, 365));
    return Promise.all([analyticsGa4(days), analyticsPosthog(days)]).then(([ga4, posthog]) => {
      const pushed = store ? store.analyticsIngested({ days }) : { metrics: {}, providers: [] };
      sendJson(res, 200, {
        days,
        providers: [ga4, posthog, {
          id: 'mcp',
          name: 'Pushed over MCP',
          via: 'MCP bridge',
          configured: Object.keys(pushed.metrics).length > 0,
          metrics: pushed.metrics,
          updated_at: pushed.updated_at || null,
          source: 'ingest',
          providers_pushed: pushed.providers,
          note: 'POST /api/analytics/ingest with the pad token: { provider, metric, points: [{ day, value }] }',
        }],
      });
    }).catch((e) => sendJson(res, 500, { error: String(e && e.message) }));
  }

  // MCP bridge: an external client (mcporter, a script) pushes metrics in.
  if (p === '/api/analytics/ingest' && req.method === 'POST') {
    return readBody(req, res, (body) => withStore(() => {
      let data;
      try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const provider = String(data.provider || '').trim();
      const metric = String(data.metric || '').trim();
      const points = Array.isArray(data.points) ? data.points : (data.value !== undefined && data.day ? [{ day: data.day, value: data.value }] : []);
      if (!provider || !metric || !points.length) {
        return sendJson(res, 400, { error: 'provider, metric and points[] are required' });
      }
      const n = store.putAnalyticsPoints(provider, metric, points, data.source || 'ingest');
      return sendJson(res, 200, { ok: true, provider, metric, points: n });
    }));
  }

  // ---- Draft queue (review-before-send) ----
  if (req.method === 'GET' && p === '/api/drafts') {
    return sendJson(res, 200, { data: readDrafts() });
  }

  // GET /api/drafts/:id — single draft or a JSON 404 (NEVER a crash)
  if (req.method === 'GET' && p.startsWith('/api/drafts/')) {
    const id = decodeURIComponent(p.slice('/api/drafts/'.length));
    const found = readDrafts().find((d) => String(d.id) === id);
    if (!found) return sendJson(res, 404, { error: 'Draft not found', id });
    return sendJson(res, 200, found);
  }

  if ((req.method === 'PUT' || req.method === 'POST') && p.startsWith('/api/drafts/')) {
    const rawId = p.slice('/api/drafts/'.length);
    const isSendRoute = rawId.endsWith('/send');
    if (isSendRoute) {
      const draftId = decodeURIComponent(rawId.slice(0, -'/send'.length));
      return readBody(req, res, (body) => {
        let data;
        try { data = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
        const drafts = readDrafts();
        const idx = drafts.findIndex((d) => String(d.id) === draftId);
        if (idx < 0) return sendJson(res, 404, { error: 'Draft not found', id: draftId });
        // Merge any client edits over the stored draft
        const draft = Object.assign({}, drafts[idx], data || {});
        const payload = {
          from: draft.from || data.from,
          to: String(draft.to || '').split(',').map((s) => s.trim()).filter(Boolean),
          cc: String(draft.cc || '').split(',').map((s) => s.trim()).filter(Boolean),
          subject: draft.subject || '',
          html: draft.html || '',
          text: draft.text || '',
        };
        if (!payload.cc.length) delete payload.cc;
        // reply_to: client sends an array already; stored drafts keep a string
        if (Array.isArray(draft.reply_to)) payload.reply_to = draft.reply_to;
        else if (typeof draft.reply_to === 'string' && draft.reply_to.trim()) payload.reply_to = [draft.reply_to.trim()];
        if (draft.attachments && Array.isArray(draft.attachments)) payload.attachments = draft.attachments;
        if (draft.headers) payload.headers = draft.headers;
        if (!payload.from || payload.to.length === 0 || !payload.subject) {
          return sendJson(res, 400, { error: 'Draft is incomplete (from/to/subject required)' });
        }
        const doSendDraft = () => resendRequest('POST', '/emails', JSON.stringify(payload), (err, status, rbody) => {
          if (err) return sendJson(res, 502, { error: 'Failed to contact Resend', details: err.message });
          if (status === 200 || status === 201) {
            const sent = {
              id: draftId,
              company: draft.company || '',
              from: payload.from,
              to: draft.to,
              cc: draft.cc || '',
              reply_to: draft.reply_to || '',
              in_reply_to: draft.in_reply_to || '',
              subject: draft.subject,
              text: payload.text,
              html: payload.html,
              sent_at: new Date().toISOString(),
              resend_id: safeJson(rbody).id,
            };
            if (store) { try { store.markDraftSent(draftId, { bodyText: payload.text, bodyHtml: payload.html }); } catch (e) { console.warn('[DB] markDraftSent:', e.message); } }
            appendSentDraft(sent);
            // Re-read before write: the queue is externally mutable.
            const fresh = readDrafts();
            const j = fresh.findIndex((d) => String(d.id) === draftId);
            if (j >= 0) { fresh.splice(j, 1); writeDrafts(fresh); }
            console.log(`[DRAFT] Sent + removed: ${draftId} (${draft.company || draft.to})`);
          }
          sendJson(res, status, safeJson(rbody));
        });
        const rawText = payload.text || '';
        const rawHtml = payload.html || '';
        if (!rawText.trim() && !rawHtml.trim()) return doSendDraft();
        // OPTIONAL send-time internalization: re-mint dead tokens and (if the
        // policy host is configured) block off-site links. No-op when disabled.
        maybeInternalize(rawText, rawHtml, draftId).then((out) => {
          payload.text = out.text;
          payload.html = out.html;
          if (out.minted.length) {
            console.log(`[DRAFT] Internalized ${out.minted.length} link(s) for ${draftId} at send time`);
            const fresh = readDrafts();
            const j = fresh.findIndex((d) => String(d.id) === draftId);
            if (j >= 0) {
              fresh[j] = Object.assign({}, fresh[j], { text: out.text, html: out.html, updated_at: new Date().toISOString() });
              writeDrafts(fresh);
            }
          }
          doSendDraft();
        }).catch((e) => {
          console.log(`[DRAFT] BLOCKED ${draftId}: ${e.message}`);
          sendJson(res, 400, { error: `Not sent: ${e.message}` });
        });
        return undefined;
      });
    }
    // PUT /api/drafts/:id — save edits to an existing draft
    if (req.method === 'PUT') {
      const id = decodeURIComponent(rawId);
      return readBody(req, res, (body) => {
        let data;
        try { data = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
        const drafts = readDrafts();
        const idx = drafts.findIndex((d) => String(d.id) === id);
        if (idx < 0) return sendJson(res, 404, { error: 'Draft not found', id });
        drafts[idx] = Object.assign({}, drafts[idx], data, { updated_at: new Date().toISOString() });
        writeDrafts(drafts);
        return sendJson(res, 200, { ok: true, id });
      });
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (req.method === 'DELETE' && p.startsWith('/api/drafts/')) {
    const id = decodeURIComponent(p.slice('/api/drafts/'.length));
    const drafts = readDrafts();
    const idx = drafts.findIndex((d) => String(d.id) === id);
    if (idx < 0) return sendJson(res, 404, { error: 'Draft not found', id });
    drafts.splice(idx, 1);
    writeDrafts(drafts);
    console.log(`[DRAFT] Discarded: ${id}`);
    return sendJson(res, 200, { ok: true, id });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function safeJson(raw) {
  try { return JSON.parse(raw); } catch { return { raw }; }
}

server.listen(PORT, () => {
  const brand = (CFG.brand && CFG.brand.productName) || 'Email Pad';
  console.log(`✓ ${brand} running on http://127.0.0.1:${PORT} (useCase=${CFG.useCase}, outreach=${OUTREACH_ENABLED ? 'on' : 'off'})`);
  console.log('  POST /api/send | GET /api/config | GET /api/domains | GET /api/sent | GET /api/received | POST /api/webhook | GET /api/archive | GET/PUT/DELETE /api/drafts | POST /api/drafts/:id/send | POST /api/drafts/:id/redraft | GET/DELETE /api/replies | GET/POST/PATCH /api/leads | GET /api/trackers/summary|events|refresh | GET /api/analytics/summary | POST /api/analytics/ingest | GET /api/emails | GET /api/stats');
});
