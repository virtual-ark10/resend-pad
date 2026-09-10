#!/usr/bin/env node
/**
 * Leads engine — a small, plain lead manager that backs the pad's "Leads" tab.
 * Zero dependencies (node:http only), single JSON store, token auth.
 *
 * Designed to be lifted into other projects: brand, stages and follow-up cadence
 * come from config (./config.json or env), nothing here is specific to one
 * business. See LEADPAD.md for the reuse recipe.
 *
 * Design rule: simple and complete. Leads + their stage + their email history.
 * Email itself is NOT reimplemented — it is proxied to the pad (127.0.0.1:3001)
 * so there is one sending path (with its internal-link gate) and one inbox.
 *
 * Routes (all need X-CRM-Token except /api/health):
 *   GET    /api/health
 *   GET    /api/meta                 brand + stages + colors + counts
 *   GET    /api/leads                leads with derived last-touch / due
 *   GET    /api/leads/:id            one lead + activity timeline
 *   PATCH  /api/leads/:id            update stage / contact / notes / next_action
 *   POST   /api/leads/:id/note       append a note
 *   POST   /api/leads                create a lead
 *   POST   /api/sync                 log pad sent+inbox mail against leads
 *   GET    /api/email/inbox|sent|drafts    -> pad
 *   POST   /api/email/send                 -> pad, then log + advance the lead
 *   POST   /api/email/drafts/:id/send      -> pad, then log + advance the lead
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE = path.join(DATA_DIR, 'crm.json');
const PAD = process.env.PAD_URL || 'http://127.0.0.1:3001';
const PAD_TOKEN = process.env.PAD_TOKEN || '';
const TOKEN = process.env.CRM_TOKEN || PAD_TOKEN;
const SERVICE = process.env.SERVICE_NAME || 'leads';
const BODY_CAP = 2 * 1024 * 1024;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// ---------------------------------------------------------------- config
// Everything project-shaped lives here and can be overridden without touching
// code: ./config.json (or LEADPAD_CONFIG=/path/to/config.json) and/or env vars.
function readConfig() {
  const p = process.env.LEADPAD_CONFIG || path.join(__dirname, 'config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}
function readJsonEnv(name) {
  try { return process.env[name] ? JSON.parse(process.env[name]) : null; } catch (e) { return null; }
}
const CFG = readConfig();

// Pipeline stages in order. Colour is the whole point of the UI: one glance
// tells you where a lead stands. `terminal: true` stages end the progression.
const DEFAULT_STAGES = [
  { key: 'leads',       label: 'Leads',       color: '#64748b', note: 'contact yet to be emailed' },
  { key: 'first_email', label: 'First Email', color: '#2563eb', note: 'first email sent' },
  { key: 'follow_up_1', label: 'Follow-up 1', color: '#0d9488' },
  { key: 'follow_up_2', label: 'Follow-up 2', color: '#4f46e5' },
  { key: 'follow_up_3', label: 'Follow-up 3', color: '#7c3aed' },
  { key: 'follow_up_4', label: 'Follow-up 4', color: '#d97706' },
  { key: 'replied',     label: 'Replied',     color: '#db2777', terminal: true },
  { key: 'won',         label: 'Won',         color: '#16a34a', terminal: true },
  { key: 'no',          label: 'No',          color: '#dc2626', terminal: true },
];
const STAGES = readJsonEnv('LEAD_STAGES') || CFG.stages || DEFAULT_STAGES;
const STAGE_KEYS = STAGES.map((s) => s.key);
// Advancing = the next non-terminal stage in order; the last one stays put, and
// the first stage (pre-contact) jumps to the first post-contact stage.
const PROGRESS = STAGES.filter((s) => !s.terminal && s.key !== STAGES[0].key);
const NEXT_STAGE = {};
PROGRESS.forEach((s, i) => { NEXT_STAGE[s.key] = (PROGRESS[i + 1] || s).key; });
NEXT_STAGE[STAGES[0].key] = (PROGRESS[0] || STAGES[0]).key;
// Touch cadence in days between sends (0 = no further follow-up scheduled).
const DUE_DAYS = Object.assign(
  { first_email: 3, follow_up_1: 4, follow_up_2: 7, follow_up_3: 0 },
  CFG.dueDays || readJsonEnv('LEAD_DUE_DAYS') || {},
);
// Brand label: env first, then the pad's own config.json (pads are config-driven),
// then the engine's config.json. Keeps one place to re-brand a whole deployment.
function brandFromPadConfig() {
  const p = process.env.PAD_CONFIG || path.join(__dirname, '..', 'config.json');
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (c.brand && c.brand.name) || c.brand_name || '';
  } catch (e) { return ''; }
}
const BRAND = process.env.BRAND_NAME || CFG.brand || brandFromPadConfig();


// ---------------------------------------------------------------- store
function emptyStore() { return { leads: [], activity: [], sync: {} }; }
function readStore() {
  try { return Object.assign(emptyStore(), JSON.parse(fs.readFileSync(STORE, 'utf8'))); }
  catch (e) { return emptyStore(); }
}
function writeStore(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, STORE);
}
function logActivity(s, ev) {
  s.activity.push(Object.assign({ ts: new Date().toISOString() }, ev));
  if (s.activity.length > 5000) s.activity = s.activity.slice(-4000);
}
const nowISO = () => new Date().toISOString();
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

// address matching: a lead owns every contact email we know for that company
function leadAddresses(lead) {
  const out = new Set();
  [lead.contact_email, ...(lead.extra_emails || [])].forEach((e) => {
    if (e) out.add(String(e).toLowerCase());
  });
  return out;
}
function findLeadByAddress(s, addr) {
  const a = String(addr || '').toLowerCase();
  if (!a) return null;
  return s.leads.find((l) => leadAddresses(l).has(a)) || null;
}

// ---------------------------------------------------------------- derived
function decorate(lead, s) {
  const acts = s.activity.filter((a) => a.lead_id === lead.id);
  const out = acts.filter((a) => a.kind === 'email_out');
  const inb = acts.filter((a) => a.kind === 'email_in');
  const clicks = acts.filter((a) => a.kind === 'click');
  const last = acts.length ? acts[acts.length - 1].ts : null;
  const lastOut = out.length ? out[out.length - 1].ts : null;
  const wait = DUE_DAYS[lead.stage];
  const due = (lead.stage !== 'leads' && wait && lastOut)
    ? new Date(new Date(lastOut).getTime() + wait * 86400000).toISOString() : null;
  return Object.assign({}, lead, {
    emails_sent: out.length,
    emails_received: inb.length,
    clicks: clicks.length,
    last_activity: last,
    last_email_out: lastOut,
    next_due: due,
    overdue: Boolean(due && new Date(due) < new Date()),
    days_since_out: lastOut ? daysBetween(lastOut, nowISO()) : null,
  });
}

// ---------------------------------------------------------------- helpers
function send(res, code, obj, type) {
  const body = type ? obj : JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > BODY_CAP) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}
async function padFetch(method, url, body) {
  const opts = { method, headers: { 'X-Pad-Token': PAD_TOKEN } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(PAD + url, opts);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return { status: r.status, json };
}
const kebab = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Display name derived from an address local part (diana.hasbun -> Diana Hasbun).
// Derived, never invented: only used when the source data has no name.
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  if (!local || /^(info|hello|contact|team|sales|admin|support|hi)$/i.test(local)) return '';
  return local.split(/[._-]+/).filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

async function syncEmail(s) {
  const result = { logged: 0, matched: 0, unmatched: 0, checked: { sent: 0, inbox: 0 } };
  const seen = new Set(s.activity.filter((a) => a.msg_id).map((a) => a.msg_id));
  for (const side of [['sent', '/api/sent'], ['inbox', '/api/received']]) {
    const [label, url] = side;
    let j;
    try { j = (await padFetch('GET', url + '?limit=100')).json; } catch (e) { continue; }
    const list = j.data || j.emails || j.items || (Array.isArray(j) ? j : []);
    result.checked[label] = list.length;
    for (const m of list) {
      const id = m.id || m.message_id || m.messageId;
      if (!id || seen.has(id)) continue;
      const addr = label === 'sent' ? (m.to || m.recipient || '') : (m.from || m.sender || '');
      const lead = findLeadByAddress(s, (String(addr).match(EMAIL_RE) || [])[0] || addr);
      if (!lead) { result.unmatched++; continue; }
      logActivity(s, {
        lead_id: lead.id, kind: label === 'sent' ? 'email_out' : 'email_in', msg_id: id,
        subject: m.subject || '', detail: label === 'sent' ? 'sent via pad' : 'received', source: 'sync',
      });
      seen.add(id); result.logged++; result.matched++;
      if (label === 'sent' && lead.stage === 'leads') {
        // a real outbound we had not recorded: the lead is past 'Leads'
        logActivity(s, { lead_id: lead.id, kind: 'stage', from: 'leads', to: 'first_email', detail: 'outbound mail found during sync', source: 'sync' });
        lead.stage = 'first_email';
      }
      if (label === 'inbox' && !['won', 'no', 'replied'].includes(lead.stage)) {
        logActivity(s, { lead_id: lead.id, kind: 'stage', from: lead.stage, to: 'replied', detail: 'reply detected during sync', source: 'sync' });
        lead.stage = 'replied';
      }
    }
  }
  // Note drafts waiting in the pad so a lead's stage and its mail agree.
  try {
    const dr = await padFetch('GET', '/api/drafts');
    const drafts = dr.json.data || dr.json.drafts || (Array.isArray(dr.json) ? dr.json : []);
    for (const d of drafts) {
      const lead = s.leads.find((l) => l.id === d.id);
      if (!lead) continue;
      const already = s.activity.some((a) => a.lead_id === lead.id && a.kind === 'note' && /draft ready in the pad/i.test(a.detail || ''));
      if (already) continue;
      logActivity(s, { lead_id: lead.id, kind: 'note', detail: 'draft ready in the pad (not sent): ' + (d.subject || ''), source: 'sync' });
      result.drafts = (result.drafts || 0) + 1;
    }
  } catch (e) { /* pad drafts unavailable — not fatal */ }

  // Self-heal: any lead we have outbound mail for but that still sits in
  // 'Leads' is really past first contact (covers imports and pre-CRM sends).
  for (const lead of s.leads) {
    if (lead.stage !== 'leads') continue;
    if (!s.activity.some((a) => a.lead_id === lead.id && a.kind === 'email_out')) continue;
    logActivity(s, { lead_id: lead.id, kind: 'stage', from: 'leads', to: 'first_email', detail: 'outbound mail on record', source: 'sync' });
    lead.stage = 'first_email';
    lead.updated_at = nowISO();
    result.healed = (result.healed || 0) + 1;
  }
  s.sync.email = nowISO();
  writeStore(s);
  return result;
}

// ---------------------------------------------------------------- rate limit
// Small in-memory limiter: the service is publicly reachable at /crm/, and the
// token is the only real gate. 120 requests/minute per IP is far above normal
// use and cheap to enforce.
const HITS = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const e = HITS.get(ip) || { n: 0, t: now };
  if (now - e.t > 60000) { e.n = 0; e.t = now; }
  e.n++;
  HITS.set(ip, e);
  if (HITS.size > 500) HITS.clear();
  return e.n > 120;
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const p = url.split('?')[0];                       // match on the path only
  const q = new URL(url, 'http://x').searchParams;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();

  if (rateLimited(ip)) return send(res, 429, { error: 'too many requests' });

  if (p === '/api/health') return send(res, 200, { ok: true, service: 'nf-crm', leads: readStore().leads.length });
  // The shell (index.html) is served WITHOUT auth so the page can render its
  // token prompt; every data route below still requires the token.
  if ((p === '/' || p === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
  }
  if (!TOKEN) return send(res, 500, { error: 'server missing CRM_TOKEN/PAD_TOKEN' });
  if (req.headers['x-crm-token'] !== TOKEN) return send(res, 401, { error: 'unauthorized' });

  try {
    // ---- meta
    if (p === '/api/meta' && req.method === 'GET') {
      const s = readStore();
      const counts = {};
      STAGE_KEYS.forEach((k) => { counts[k] = s.leads.filter((l) => l.stage === k).length; });
      return send(res, 200, { brand: BRAND, stages: STAGES, counts, total: s.leads.length, sync: s.sync });
    }
    // ---- leads
    if (p === '/api/leads' && req.method === 'GET') {
      const s = readStore();
      let leads = s.leads.map((l) => decorate(l, s));
      const stage = q.get('stage');
      if (stage) leads = leads.filter((l) => l.stage === stage);
      return send(res, 200, { leads });
    }
    if (p === '/api/leads' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.company) return send(res, 400, { error: 'company is required' });
      const s = readStore();
      const id = b.id || kebab(b.company);
      if (s.leads.some((l) => l.id === id)) return send(res, 409, { error: 'lead already exists', id });
      const lead = Object.assign({
        id, company: b.company, domain: b.domain || '', contact_name: '', contact_title: '',
        contact_email: '', contact_role: 'other', stage: 'leads', source: 'manual',
        notes: [], created_at: nowISO(), updated_at: nowISO(),
      }, b, { id });
      if (!STAGE_KEYS.includes(lead.stage)) lead.stage = 'leads';
      s.leads.push(lead); logActivity(s, { lead_id: id, kind: 'created', detail: 'lead added to CRM' });
      writeStore(s);
      return send(res, 201, { ok: true, lead });
    }
    if (p.startsWith('/api/leads/')) {
      const rest = p.slice('/api/leads/'.length).split('/');
      const id = decodeURIComponent(rest[0]);
      const s = readStore();
      const lead = s.leads.find((l) => l.id === id);
      if (!lead) return send(res, 404, { error: 'unknown lead' });
      if (rest[1] === 'note' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.body) return send(res, 400, { error: 'body is required' });
        logActivity(s, { lead_id: id, kind: 'note', detail: String(b.body).slice(0, 2000) });
        writeStore(s);
        return send(res, 201, { ok: true });
      }
      if (req.method === 'GET') {
        return send(res, 200, {
          lead: decorate(lead, s),
          activity: s.activity.filter((a) => a.lead_id === id).slice().reverse(),
        });
      }
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const b = await readBody(req);
        if (b.stage && !STAGE_KEYS.includes(b.stage)) return send(res, 400, { error: 'bad stage', allowed: STAGE_KEYS });
        const before = lead.stage;
        ['stage', 'contact_name', 'contact_title', 'contact_email', 'contact_role', 'next_action_at', 'domain'].forEach((k) => {
          if (b[k] !== undefined) lead[k] = b[k];
        });
        if (b.stage && b.stage !== before) {
          logActivity(s, { lead_id: id, kind: 'stage', from: before, to: b.stage, detail: b.note || 'stage changed in CRM' });
        }
        lead.updated_at = nowISO();
        writeStore(s);
        return send(res, 200, { ok: true, lead: decorate(lead, s) });
      }
    }
    // ---- sync
    if (p === '/api/sync' && req.method === 'POST') {
      return send(res, 200, await syncEmail(readStore()));
    }
    // ---- email passthrough (single sending path: the pad)
    if (p === '/api/email/inbox' && req.method === 'GET') {
      const r = await padFetch('GET', '/api/received?limit=' + (q.get('limit') || 50));
      return send(res, r.status, r.json);
    }
    if (p === '/api/email/sent' && req.method === 'GET') {
      const r = await padFetch('GET', '/api/sent?limit=' + (q.get('limit') || 50));
      return send(res, r.status, r.json);
    }
    if (p === '/api/email/drafts' && req.method === 'GET') {
      const r = await padFetch('GET', '/api/drafts');
      return send(res, r.status, r.json);
    }
    if (p === '/api/email/send' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await padFetch('POST', '/api/send', b);
      if (r.status >= 200 && r.status < 300) {
        const s = readStore();
        const to = (String(b.to || '').match(EMAIL_RE) || [])[0];
        const lead = findLeadByAddress(s, to);
        if (lead) {
          const from = lead.stage;
          logActivity(s, { lead_id: lead.id, kind: 'email_out', subject: b.subject || '', detail: 'sent from the CRM', source: 'crm_send' });
          if (lead.stage !== 'replied' && lead.stage !== 'won' && lead.stage !== 'no') {
            lead.stage = NEXT_STAGE[lead.stage] || lead.stage;
            logActivity(s, { lead_id: lead.id, kind: 'stage', from, to: lead.stage, detail: 'auto-advanced by send', source: 'crm_send' });
          }
          lead.updated_at = nowISO();
          writeStore(s);
        }
      }
      return send(res, r.status, r.json);
    }
    if (p.startsWith('/api/email/drafts/') && p.endsWith('/send') && req.method === 'POST') {
      const draftId = decodeURIComponent(p.slice('/api/email/drafts/'.length, -'/send'.length));
      const b = await readBody(req);
      const r = await padFetch('POST', '/api/drafts/' + encodeURIComponent(draftId) + '/send', b);
      if (r.status >= 200 && r.status < 300) {
        const s = readStore();
        const lead = s.leads.find((l) => l.id === draftId) || findLeadByAddress(s, (String(b.to || '').match(EMAIL_RE) || [])[0]);
        if (lead) {
          const from = lead.stage;
          logActivity(s, { lead_id: lead.id, kind: 'email_out', subject: b.subject || '', detail: 'draft sent from the CRM', source: 'crm_send' });
          if (!['replied', 'won', 'no'].includes(lead.stage)) {
            lead.stage = NEXT_STAGE[lead.stage] || lead.stage;
            logActivity(s, { lead_id: lead.id, kind: 'stage', from, to: lead.stage, detail: 'auto-advanced by draft send', source: 'crm_send' });
          }
          lead.updated_at = nowISO();
          writeStore(s);
        }
      }
      return send(res, r.status, r.json);
    }

    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      return send(res, 200, html, 'text/html; charset=utf-8');
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[${SERVICE}] listening on http://${HOST}:${PORT}  store=${STORE}  pad=${PAD}`);
});
