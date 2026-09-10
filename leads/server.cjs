/**
 * Leads engine — the CRM behind the pad's Leads tab.
 *
 * Two services, ONE store: this engine reads and writes the same SQLite database
 * the pad uses (../db.cjs -> DATA_DIR/pad.db), so there is no second copy of a
 * lead to keep in step. Stages, cadence and branding are config-driven; the
 * stage vocabulary is shared with the pad through the same config block.
 *
 *   GET    /api/health                   liveness + lead count
 *   GET    /api/meta                     brand + stages + counts + last sync
 *   GET    /api/leads[?stage=]           pipeline rows
 *   POST   /api/leads                    create a lead
 *   GET    /api/leads/:id                lead + activity
 *   PATCH  /api/leads/:id                stage / contact / next action
 *   POST   /api/leads/:id/note           append a note
 *   POST   /api/sync                     pull the pad's inbox, drain the event queue
 *   GET    /api/events                   recent events (the backbone, visible)
 *   POST   /api/events/drain             run the queue now
 *   GET    /api/redraft-guidance         what keeps getting sent back
 *   GET    /api/email/inbox|sent|drafts  passthrough to the pad
 *   POST   /api/email/send               passthrough to the pad
 *   POST   /api/email/drafts/:id/send    passthrough to the pad
 *
 * Auth: X-CRM-Token must equal CRM_TOKEN (defaults to the pad's PAD_TOKEN).
 * The pad injects it server-side, so the browser only ever holds the pad token.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const store_ = require('../db.cjs');
const { buildRules } = require('../hooks.cjs');

const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PAD = process.env.PAD_URL || 'http://127.0.0.1:3001';
const PAD_TOKEN = process.env.PAD_TOKEN || '';
const TOKEN = process.env.CRM_TOKEN || PAD_TOKEN;
const SERVICE = process.env.SERVICE_NAME || 'leads';
const BODY_CAP = 2 * 1024 * 1024;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// ---------------------------------------------------------------- config
// Everything project-shaped lives in config.json (or LEADPAD_CONFIG) and/or env
// vars: stages, cadence, reply/won stage names, redraft reasons, branding.
function readConfig() {
  const p = process.env.LEADPAD_CONFIG || path.join(__dirname, '..', 'config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}

function readJsonEnv(name) {
  try { return process.env[name] ? JSON.parse(process.env[name]) : null; } catch (e) { return null; }
}

const CFG = readConfig();
const LEADS_CFG = CFG.leads && typeof CFG.leads === 'object' ? CFG.leads : {};

// Pipeline stages, in order. `terminal: true` ends the progression (the pad's
// rules engine stops advancing at a terminal stage).
const STAGES = readJsonEnv('LEAD_STAGES') || LEADS_CFG.stages || CFG.stages || store_.DEFAULT_STAGES;
const STAGE_KEYS = STAGES.map((s) => s.key);
// Touch cadence in days between sends (0 = no further follow-up scheduled).
const DUE_DAYS = Object.assign({}, LEADS_CFG.dueDays || CFG.dueDays || readJsonEnv('LEAD_DUE_DAYS') || {});
const REDRAFT_REASONS = LEADS_CFG.redraftReasons || CFG.redraftReasons || [
  'Too long', 'Too salesy', 'Wrong angle', 'Wrong offer', 'Tone off', 'Missing detail', 'Not personalised',
];

function brandFromPadConfig() {
  const p = process.env.PAD_CONFIG || path.join(__dirname, '..', 'config.json');
  try {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (c.brand && c.brand.name) || c.brand_name || '';
  } catch (e) { return ''; }
}

const BRAND = process.env.BRAND_NAME || LEADS_CFG.brand || CFG.brand || brandFromPadConfig();

// ---------------------------------------------------------------- store
const store = store_.open(DATA_DIR, {
  stages: STAGES,
  replyStage: LEADS_CFG.replyStage,
  wonStage: LEADS_CFG.wonStage,
});
if (!store) {
  console.error('[leads] node:sqlite is unavailable in this runtime (Node >= 22.5 needed)');
  process.exit(1);
}
const rules = buildRules(store);
const SYNC = { last: null, pulled: 0, moves: [] };

function nowISO() { return new Date().toISOString(); }

/** Row -> the shape the CRM UI expects, with cadence information. */
function decorate(lead) {
  const wait = DUE_DAYS[lead.stage];
  const lastOut = lead.last_out_at || lead.last_contact_at;
  const due = (wait && lastOut) ? new Date(new Date(lastOut).getTime() + wait * 86400000).toISOString() : null;
  const overdue = !!(due && new Date(due) < new Date() && !store.isTerminal(lead.stage));
  let notes = [];
  try { notes = JSON.parse(lead.tags || '[]').filter((x) => typeof x === 'string' && x.includes(':')); } catch (e) { notes = []; }
  return {
    id: lead.id,
    company: lead.company || lead.domain || lead.email || lead.id,
    domain: lead.domain || '',
    contact_name: lead.contact_name || '',
    contact_email: lead.email || '',
    contact_title: '',
    contact_role: lead.source || 'other',
    stage: lead.stage,
    source: lead.source || '',
    priority: lead.priority,
    converted: !!lead.converted,
    converted_at: lead.converted_at,
    value_cents: lead.value_cents,
    city: lead.city || '',
    niche: lead.niche || '',
    next_action_at: lead.next_follow_up_at || null,
    notes,
    emails_sent: lead.emails_sent || 0,
    replies: lead.replies || 0,
    last_out_at: lastOut || null,
    last_reply_at: lead.last_reply_at || null,
    due_at: due,
    overdue,
    created_at: lead.created_at,
    updated_at: lead.updated_at,
  };
}

// ---------------------------------------------------------------- http helpers
function send(res, code, obj, type) {
  const body = type === 'text/html; charset=utf-8' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_CAP) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function padFetch(method, url, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      method,
      host: PAD.replace(/^https?:\/\//, '').split(':')[0],
      port: Number(PAD.split(':').pop()) || 3001,
      path: url,
      headers: Object.assign({ 'X-Pad-Token': PAD_TOKEN, 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
        resolve({ status: r.statusCode || 502, json });
      });
    });
    req.on('error', (e) => resolve({ status: 502, json: { error: 'pad unreachable: ' + e.message } }));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Reconcile: ask the pad for its inbox (which persists new replies into the
 * shared store), then drain the event queue so every fired event performs its
 * next action. This is the loop: discovery -> CRM -> draft -> send -> reply.
 */
async function sync() {
  const pulled = await padFetch('GET', '/api/received?limit=50');
  const drained = store.processEvents(rules);
  SYNC.last = nowISO();
  SYNC.pulled = (pulled.json && Array.isArray(pulled.json.data)) ? pulled.json.data.length : 0;
  SYNC.moves = drained.actions || [];
  return { ok: true, at: SYNC.last, pulled: SYNC.pulled, processed: drained.processed, moves: SYNC.moves };
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const p = url.split('?')[0];
  const q = new URL(url, 'http://x').searchParams;

  try {
    if (p === '/api/health') {
      return send(res, 200, { ok: true, service: SERVICE, leads: store.crmLeads().length, store: store.file });
    }
    if ((p === '/' || p === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      const shell = path.join(__dirname, 'index.html');
      if (fs.existsSync(shell)) return send(res, 200, fs.readFileSync(shell), 'text/html; charset=utf-8');
      return send(res, 200, { service: SERVICE, note: 'headless: the pad is the UI', endpoints: ['/api/health', '/api/meta'] });
    }
    if (!TOKEN) return send(res, 500, { error: 'server missing CRM_TOKEN/PAD_TOKEN' });
    if (req.headers['x-crm-token'] !== TOKEN) return send(res, 401, { error: 'unauthorized' });

    // ---- meta: also drains the queue, so opening the tab reconciles everything.
    if (p === '/api/meta' && req.method === 'GET') {
      store.processEvents(rules);
      return send(res, 200, {
        brand: BRAND,
        stages: STAGES,
        counts: store.crmCounts(),
        total: store.crmLeads().length,
        pending_events: store.pendingEvents().length,
        redraft_reasons: REDRAFT_REASONS,
        sync: SYNC,
      });
    }

    // ---- leads
    if (p === '/api/leads' && req.method === 'GET') {
      const rows = store.crmLeads({ stage: q.get('stage') || undefined });
      return send(res, 200, { leads: rows.map(decorate) });
    }

    if (p === '/api/leads' && req.method === 'POST') {
      const b = await readBody(req);
      const email = b.contact_email || b.email || '';
      const company = b.company || b.domain || email;
      if (!company) return send(res, 400, { error: 'company is required' });
      const id = store.upsertLead({
        email, company, website: b.domain, niche: b.niche, city: b.city,
        source: b.source || 'manual', name: b.contact_name,
      });
      if (!id) return send(res, 400, { error: 'an email address is required' });
      const patch = {};
      ['contact_name', 'next_follow_up_at', 'priority', 'notes', 'meta'].forEach((k) => {
        if (b[k] !== undefined) patch[k === 'contact_name' ? 'contact_name' : k] = b[k];
      });
      if (b.next_action_at && patch.next_follow_up_at === undefined) patch.next_follow_up_at = b.next_action_at;
      if (Object.keys(patch).length) store.updateLead(id, patch);
      if (b.stage && STAGE_KEYS.includes(b.stage)) store.setStage(id, b.stage, { by: 'user', note: 'set on create' });
      const row = store.crmLeads().find((l) => l.id === id);
      return send(res, 201, { ok: true, lead: row ? decorate(row) : null });
    }

    if (p.startsWith('/api/leads/')) {
      const rest = p.slice('/api/leads/'.length).split('/');
      const id = decodeURIComponent(rest[0]);
      const lead = store.get('SELECT * FROM leads WHERE id = ?', id);
      if (!lead) return send(res, 404, { error: 'unknown lead' });

      if (rest[1] === 'note' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.body) return send(res, 400, { error: 'body is required' });
        store.note(id, b.body, { source: 'user', kind: b.kind || 'note' });
        return send(res, 201, { ok: true });
      }

      if (req.method === 'GET') {
        const row = store.crmLeads().find((l) => l.id === id);
        return send(res, 200, { lead: row ? decorate(row) : null, activity: store.activity(id) });
      }

      if (req.method === 'PATCH' || req.method === 'PUT') {
        const b = await readBody(req);
        if (b.stage && !STAGE_KEYS.includes(b.stage)) return send(res, 400, { error: 'bad stage', allowed: STAGE_KEYS });
        const patch = {};
        if (b.contact_name !== undefined) patch.contact_name = b.contact_name;
        if (b.contact_email !== undefined) patch.email = b.contact_email;
        if (b.domain !== undefined) patch.domain = b.domain;
        if (b.contact_title !== undefined) patch.contact_title = b.contact_title;
        if (b.notes !== undefined) patch.notes = b.notes;
        if (b.next_action_at !== undefined) patch.next_follow_up_at = b.next_action_at;
        if (b.priority !== undefined) patch.priority = b.priority;
        if (b.converted !== undefined) patch.converted = b.converted;
        if (b.value_cents !== undefined) patch.value_cents = b.value_cents;
        if (Object.keys(patch).length) store.updateLead(id, patch);
        if (b.stage && b.stage !== lead.stage) store.setStage(id, b.stage, { by: 'user', note: b.note || 'stage changed in CRM' });
        else if (b.note) store.note(id, b.note, { source: 'user' });
        const row = store.crmLeads().find((l) => l.id === id);
        return send(res, 200, { ok: true, lead: row ? decorate(row) : null });
      }
      return send(res, 405, { error: 'method not allowed' });
    }

    // ---- the event backbone, visible
    if (p === '/api/events' && req.method === 'GET') {
      return send(res, 200, {
        data: store.recentEvents({ limit: Number(q.get('limit') || 100), leadId: q.get('lead') || undefined }),
        pending: store.pendingEvents(),
      });
    }
    if (p === '/api/events/drain' && req.method === 'POST') {
      return send(res, 200, store.processEvents(rules));
    }
    if (p === '/api/redraft-guidance' && req.method === 'GET') {
      return send(res, 200, store.redraftGuidance());
    }

    // ---- sync
    if (p === '/api/sync' && req.method === 'POST') {
      return send(res, 200, await sync());
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
      return send(res, 200, await padFetch('POST', '/api/send', b));
    }
    if (p.startsWith('/api/email/drafts/') && p.endsWith('/send') && req.method === 'POST') {
      const draftId = decodeURIComponent(p.slice('/api/email/drafts/'.length, -'/send'.length));
      const b = await readBody(req);
      const r = await padFetch('POST', '/api/drafts/' + encodeURIComponent(draftId) + '/send', b);
      return send(res, r.status, r.json);
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.warn('[leads] error:', e && e.message);
    return send(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[${SERVICE}] listening on http://${HOST}:${PORT}  store=${store.file}  pad=${PAD}  stages=${STAGE_KEYS.join(',')}`);
});
