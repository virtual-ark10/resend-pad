// SQLite store for the pad — leads, outbound email, replies, drafts, timeline.
//
// Zero npm dependencies: uses node's built-in `node:sqlite` (Node >= 22.5).
// If that module is missing, `open()` returns null and the caller keeps using
// the original JSON/JSONL files, so the kit still runs on older Node.
//
// Everything the pad knows lives in one file: data/pad.db (WAL mode).
// Legacy files (drafts.json, sent-drafts.jsonl, webhooks.jsonl) are imported
// once on first open and then renamed to *.imported so nothing is lost and
// nothing is written twice.
//
// Brand-agnostic on purpose: no domains, no names, no campaign specifics.

const fs = require('fs');
const path = require('path');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { DatabaseSync = null; }

const SCHEMA_VERSION = 3;

const SCHEMA = `
-- ---------------------------------------------------------------- leads
CREATE TABLE IF NOT EXISTS leads (
  id                TEXT PRIMARY KEY,          -- slug of the primary email
  company           TEXT,
  domain            TEXT,
  contact_name      TEXT,
  email             TEXT,                      -- primary address
  emails            TEXT,                      -- JSON array: every address seen
  phone             TEXT,
  website           TEXT,
  niche             TEXT,                      -- trade / vertical
  city              TEXT,
  region            TEXT,
  country           TEXT,
  source            TEXT,                      -- outreach | inbound-form | import | manual
  stage             TEXT NOT NULL DEFAULT 'new',
  stage_changed_at  TEXT,
  priority          INTEGER NOT NULL DEFAULT 3,-- 1 high .. 5 low
  score             INTEGER,                   -- ranking/quality score when known
  owner             TEXT,
  tags              TEXT,                      -- JSON array
  notes             TEXT,
  meta              TEXT,                      -- JSON object: anything that does not deserve a column yet
  converted         INTEGER NOT NULL DEFAULT 0,
  converted_at      TEXT,
  value_cents       INTEGER,                   -- deal value when won
  currency          TEXT,
  unsubscribed      INTEGER NOT NULL DEFAULT 0,
  bounced           INTEGER NOT NULL DEFAULT 0,
  first_contact_at  TEXT,
  last_contact_at   TEXT,
  next_follow_up_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  archived_at       TEXT,
  deleted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_stage    ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_email    ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_convert  ON leads(converted);
CREATE INDEX IF NOT EXISTS idx_leads_followup ON leads(next_follow_up_at);

-- ------------------------------------------------- every stage transition
CREATE TABLE IF NOT EXISTS lead_stage_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage   TEXT,
  to_stage     TEXT NOT NULL,
  changed_at   TEXT NOT NULL,
  changed_by   TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_stage_events_lead ON lead_stage_events(lead_id, changed_at);

-- ------------------------------------------------- outbound + inbound mail
CREATE TABLE IF NOT EXISTS emails (
  id              TEXT PRIMARY KEY,            -- draft id or generated uuid
  lead_id         TEXT REFERENCES leads(id) ON DELETE SET NULL,
  direction       TEXT NOT NULL,               -- 'out' | 'in'
  stage_at_send   TEXT,                        -- lead stage snapshotted when sent
  thread_id       TEXT,                        -- root message id of the conversation
  parent_email_id TEXT,                        -- the mail this one answers
  in_reply_to     TEXT,                        -- Message-ID header
  from_addr       TEXT,
  to_addr         TEXT,                        -- comma separated as sent
  cc_addr         TEXT,
  bcc_addr        TEXT,
  reply_to        TEXT,
  subject         TEXT,
  body_text       TEXT,
  body_html       TEXT,
  template_id     TEXT,
  campaign        TEXT,
  resend_id       TEXT,                        -- Resend's email id
  status          TEXT,                        -- queued|sent|delivered|bounced|complained|failed
  status_at       TEXT,
  error           TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_resend ON emails(resend_id) WHERE resend_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emails_lead    ON emails(lead_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_emails_sent    ON emails(sent_at);

-- ------------------------------------------------------------- replies (in)
CREATE TABLE IF NOT EXISTS replies (
  id            TEXT PRIMARY KEY,              -- Resend receiving id
  lead_id       TEXT REFERENCES leads(id) ON DELETE SET NULL,
  email_id      TEXT REFERENCES emails(id) ON DELETE SET NULL,
  from_addr     TEXT,
  from_name     TEXT,
  to_addr       TEXT,
  subject       TEXT,
  body_text     TEXT,
  body_html     TEXT,
  message_id    TEXT,
  in_reply_to   TEXT,
  received_at   TEXT,
  created_at    TEXT NOT NULL,
  classification TEXT,                         -- interested|not_interested|ooo|bounce|unsubscribe|unknown
  sentiment     TEXT,
  is_read       INTEGER NOT NULL DEFAULT 0,
  starred       INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,                          -- the ✕ in the UI
  raw           TEXT                           -- JSON payload, kept verbatim
);
CREATE INDEX IF NOT EXISTS idx_replies_lead ON replies(lead_id, received_at);
CREATE INDEX IF NOT EXISTS idx_replies_recv ON replies(received_at);

-- ------------------------------------------------------------- draft queue
CREATE TABLE IF NOT EXISTS drafts (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT REFERENCES leads(id) ON DELETE SET NULL,
  company      TEXT,
  from_addr    TEXT,
  to_addr      TEXT,
  cc_addr      TEXT,
  subject      TEXT,
  reply_to     TEXT,
  in_reply_to  TEXT,
  body_text    TEXT,
  body_html    TEXT,
  attachments  TEXT,                           -- JSON array
  headers      TEXT,                           -- JSON object
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | sent | discarded
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status, created_at);

-- ------------------------------------------------------ generic audit trail
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,                    -- lead | email | reply | draft | system
  entity_id  TEXT,
  type       TEXT NOT NULL,                    -- lead.created | email.sent | reply.received | ...
  payload    TEXT,                             -- JSON
  at         TEXT NOT NULL,
  actor      TEXT,
  processed_at TEXT                            -- NULL until the rules engine ran it
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity, entity_id, at);
CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(processed_at, id);

-- --------------------------------------------- why a draft was sent back
CREATE TABLE IF NOT EXISTS redraft_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id   TEXT,
  lead_id    TEXT REFERENCES leads(id) ON DELETE SET NULL,
  reason     TEXT,                             -- short chip label
  note       TEXT,                             -- the user's own words
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redraft_lead ON redraft_notes(lead_id, created_at);

CREATE VIEW IF NOT EXISTS v_redraft_reasons AS
SELECT COALESCE(NULLIF(reason, ''), 'unspecified') AS reason,
       COUNT(*) AS n,
       MAX(created_at) AS last_at
FROM redraft_notes GROUP BY 1 ORDER BY n DESC;


-- ------------------------------------------- Resend tracking (the Trackers tab)
-- One row per delivery/engagement event, from the Resend webhook or from
-- polling the API. The dedupe column keeps a replayed webhook from double
-- counting.
CREATE TABLE IF NOT EXISTS tracker_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  resend_id   TEXT,                             -- Resend's email id
  email_id    TEXT,                             -- our emails.id (draft id) when known
  lead_id     TEXT,
  type        TEXT NOT NULL,                    -- sent|delivered|delivery_delayed|opened|clicked|bounced|complained|failed|scheduled|canceled
  occurred_at TEXT NOT NULL,
  url         TEXT,                             -- clicked link
  user_agent  TEXT,
  ip          TEXT,
  bounce_type TEXT,                             -- hard | soft | undetermined
  subject     TEXT,
  to_addr     TEXT,
  source      TEXT NOT NULL DEFAULT 'webhook',  -- webhook | poll | manual
  raw         TEXT,
  dedupe      TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_tracker_resend ON tracker_events(resend_id);
CREATE INDEX IF NOT EXISTS idx_tracker_type   ON tracker_events(type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_tracker_at     ON tracker_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_tracker_lead   ON tracker_events(lead_id);

CREATE VIEW IF NOT EXISTS v_tracker_daily AS
SELECT substr(occurred_at, 1, 10) AS day, type, COUNT(*) AS n
FROM tracker_events GROUP BY day, type;

-- Points pushed in by an external tool (an MCP client, a script) when the
-- provider's own API is not reachable from here. Keyed so a re-push updates.
CREATE TABLE IF NOT EXISTS analytics_points (
  provider   TEXT NOT NULL,                     -- ga4 | posthog | mcp
  metric     TEXT NOT NULL,                     -- sessions | pageviews | users | conversions | events
  day        TEXT NOT NULL,
  value      REAL NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'ingest',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, metric, day)
);

-- ------------------------------------------------------------ bookkeeping
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- Views the app and any SQL client can use directly.
CREATE VIEW IF NOT EXISTS v_lead_pipeline AS
SELECT l.id, l.company, l.email, l.stage, l.converted, l.priority,
       l.first_contact_at, l.last_contact_at, l.next_follow_up_at,
       (SELECT COUNT(*) FROM emails  e WHERE e.lead_id = l.id AND e.direction = 'out') AS emails_sent,
       (SELECT COUNT(*) FROM replies r WHERE r.lead_id = l.id AND r.deleted_at IS NULL)  AS replies,
       (SELECT MAX(r.received_at) FROM replies r WHERE r.lead_id = l.id AND r.deleted_at IS NULL) AS last_reply_at
FROM leads l WHERE l.deleted_at IS NULL;

CREATE VIEW IF NOT EXISTS v_lead_timeline AS
SELECT lead_id, at, kind, detail FROM (
  SELECT lead_id, sent_at AS at, 'email_sent' AS kind, subject AS detail FROM emails WHERE sent_at IS NOT NULL
  UNION ALL
  SELECT lead_id, received_at, 'reply_received', subject FROM replies WHERE deleted_at IS NULL
  UNION ALL
  SELECT lead_id, changed_at, 'stage_change', from_stage || ' -> ' || to_stage FROM lead_stage_events
) ORDER BY at DESC;
`;

const nowIso = () => new Date().toISOString();

function slug(input) {
  return String(input || 'unknown').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function firstAddress(value) {
  if (Array.isArray(value)) value = value[0] || '';
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean)[0] || '';
}

function addressList(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function leadIdFor(email) {
  return 'lead-' + slug(firstAddress(email));
}

/**
 * Open (creating if needed) the SQLite store.
 * @returns {null|object} null when node:sqlite is unavailable.
 */
function open(dataDir, opts = {}) {
  if (!DatabaseSync) return null;
  const file = path.join(dataDir, opts.file || 'pad.db');
  const db = new DatabaseSync(file);

  // The pad and the leads engine share this one file, so every startup step
  // below can collide with the other process mid-write: retry while the error
  // says locked/busy instead of dying on boot.
  const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* older node */ } };
  const withRetry = (label, fn, attempts = 60) => {
    for (let i = 1; ; i += 1) {
      try { return fn(); } catch (err) {
        if (!/locked|busy/i.test(String(err && err.message)) || i >= attempts) throw err;
        if (i === 1) console.warn(`[DB] ${label}: waiting for the other process to release the write lock`);
        sleep(250);
      }
    }
  };

  db.exec('PRAGMA busy_timeout = 15000');
  withRetry('journal_mode', () => db.exec('PRAGMA journal_mode = WAL'));
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Migrate BEFORE the schema: an existing database already has an events table
  // without processed_at, and SCHEMA creates an index on that column, so the
  // index would fail with "no such column" on any database created earlier.
  withRetry('migrate', () => {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
    if (!exists) return;
    const cols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    if (!cols.includes('processed_at')) db.exec('ALTER TABLE events ADD COLUMN processed_at TEXT');
  });
  withRetry('schema', () => db.exec(SCHEMA));
  // Upsert: an existing store reports the version this build actually creates,
  // instead of the first value ever written.
  withRetry('schema_version', () => db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run('schema_version', String(SCHEMA_VERSION)));

  const store = new Store(db, dataDir, file, opts);
  store.importLegacy();
  return store;
}

// Stage vocabulary. The pad and the leads engine share ONE store, so they must
// agree on stage keys: pass the configured list in (config.json -> leads.stages)
// or take the kit default. stages[0] is where a new lead lands; the reply/won
// stages are looked up by key so the rules engine never hard-codes a name.
const DEFAULT_STAGES = [
  { key: 'leads', label: 'Leads', color: '#64748b' },
  { key: 'first_email', label: 'First email', color: '#2563eb' },
  { key: 'follow_up_1', label: 'Follow-up 1', color: '#0d9488' },
  { key: 'follow_up_2', label: 'Follow-up 2', color: '#4f46e5' },
  { key: 'follow_up_3', label: 'Follow-up 3', color: '#7c3aed' },
  { key: 'follow_up_4', label: 'Follow-up 4', color: '#d97706' },
  { key: 'replied', label: 'Replied', color: '#db2777', terminal: true },
  { key: 'won', label: 'Won', color: '#16a34a', terminal: true },
  { key: 'no', label: 'No', color: '#dc2626', terminal: true },
];

class Store {
  constructor(db, dataDir, file, opts = {}) {
    this.db = db;
    this.dataDir = dataDir;
    this.file = file;
    const stages = Array.isArray(opts.stages) && opts.stages.length ? opts.stages : DEFAULT_STAGES;
    this.stages = stages;
    this.stageOrder = stages.map((s) => s.key);
    this.firstStage = this.stageOrder[0];
    this.terminalStages = stages.filter((s) => s.terminal).map((s) => s.key);
    this.replyStageKey = opts.replyStage || this.stageOrder.find((k) => /repl/i.test(k)) || this.firstStage;
    this.wonStageKey = opts.wonStage || this.stageOrder.find((k) => /won|win|closed/i.test(k)) || null;
    // Inbound mail can create leads (a real reply is a warm lead), but tools and
    // your own addresses must not land in the pipeline: configurable either way.
    this.discoverFromInbox = opts.discoverFromInbox !== false;
    this.ignoreSenders = (Array.isArray(opts.ignoreSenders) ? opts.ignoreSenders : [])
      .map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  }

  /** Should an inbound sender land in the pipeline? */
  shouldTrackInbound(email) {
    if (!this.discoverFromInbox) return false;
    const addr = firstAddress(email).toLowerCase();
    if (!addr || !addr.includes('@')) return false;
    const domain = addr.split('@')[1] || '';
    return !this.ignoreSenders.some((rule) => rule === addr
      || (rule.includes('.') && (domain === rule || domain.endsWith('.' + rule))));
  }

  isTerminal(stage) { return this.terminalStages.includes(stage); }

  /** Next stage after a send: the pre-contact stage steps into the sequence. */
  advanceStage(current) {
    if (!current || this.isTerminal(current)) return current;
    const seq = this.stageOrder.filter((k) => !this.terminalStages.includes(k));
    const i = seq.indexOf(current);
    if (i < 0) return seq[0] || current;
    return seq[i + 1] || current;
  }

  // ------------------------------------------------------------- internals
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  get(sql, ...params) { return this.db.prepare(sql).get(...params); }

  all(sql, ...params) { return this.db.prepare(sql).all(...params); }

  event(entity, entityId, type, payload) {
    try {
      this.run('INSERT INTO events(entity, entity_id, type, payload, at) VALUES (?,?,?,?,?)',
        entity, entityId == null ? null : String(entityId), type, payload ? JSON.stringify(payload) : null, nowIso());
    } catch (err) { console.warn('[DB] event log failed:', err.message); }
  }

  /** Create the lead if it is new, otherwise fill in blanks and touch it. */
  upsertLead({ email, company, website, niche, city, region, country, source, name, tags, meta }) {
    const addr = firstAddress(email);
    if (!addr) return null;
    const id = leadIdFor(addr);
    const ts = nowIso();
    const existing = this.get('SELECT * FROM leads WHERE id = ?', id);
    if (!existing) {
      const stage = this.firstStage;
      this.run(`INSERT INTO leads (id, company, domain, contact_name, email, emails, website, niche, city,
                 region, country, source, stage, stage_changed_at, tags, meta, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, company || null, website ? slug(String(website).replace(/^https?:\/\//, '').split('/')[0]) : null,
        name || null, addr, JSON.stringify([addr]), website || null, niche || null, city || null,
        region || null, country || null, source || 'unknown', stage, ts,
        tags ? JSON.stringify(tags) : null, meta ? JSON.stringify(meta) : null, ts, ts);
      this.run('INSERT INTO lead_stage_events(lead_id, from_stage, to_stage, changed_at, changed_by, note) VALUES (?,?,?,?,?,?)',
        id, null, stage, ts, 'system', 'lead created');
      this.event('lead', id, 'lead.created', { leadId: id, email: addr, company: company || null });
      return id;
    }
    const seen = new Set(JSON.parse(existing.emails || '[]'));
    seen.add(addr);
    this.run(`UPDATE leads SET company = COALESCE(NULLIF(?, ''), company),
                 website = COALESCE(NULLIF(?, ''), website),
                 niche = COALESCE(NULLIF(?, ''), niche),
                 city = COALESCE(NULLIF(?, ''), city),
                 emails = ?, updated_at = ? WHERE id = ?`,
      company || '', website || '', niche || '', city || '', JSON.stringify([...seen]), ts, id);
    return id;
  }

  setStage(leadId, stage, { by = 'user', note = null } = {}) {
    if (!leadId || !stage) return;
    const lead = this.get('SELECT stage FROM leads WHERE id = ?', leadId);
    if (!lead || lead.stage === stage) return;
    const ts = nowIso();
    this.run('UPDATE leads SET stage = ?, stage_changed_at = ?, updated_at = ? WHERE id = ?', stage, ts, ts, leadId);
    this.run('INSERT INTO lead_stage_events(lead_id, from_stage, to_stage, changed_at, changed_by, note) VALUES (?,?,?,?,?,?)',
      leadId, lead.stage, stage, ts, by, note);
    this.event('lead', leadId, 'lead.stage_change', { leadId, from_stage: lead.stage, to_stage: stage, by });
  }

  updateLead(id, fields) {
    const allowed = ['company', 'contact_name', 'email', 'phone', 'website', 'niche', 'city', 'region',
      'country', 'source', 'stage', 'priority', 'score', 'owner', 'tags', 'notes', 'meta', 'converted',
      'converted_at', 'value_cents', 'currency', 'unsubscribed', 'bounced', 'next_follow_up_at', 'archived_at'];
    const sets = [];
    const vals = [];
    for (const [k, vRaw] of Object.entries(fields || {})) {
      if (!allowed.includes(k)) continue;
      // node:sqlite binds strings/numbers/null only: coerce the rest here so a
      // JSON body with true/false or a nested object cannot throw a TypeError.
      let v = vRaw;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      else if (v === undefined) v = null;
      else if (typeof v === 'object' && v !== null) v = JSON.stringify(v);
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (!sets.length) return this.get('SELECT * FROM leads WHERE id = ?', id);
    const wasConverted = this.get('SELECT converted, converted_at FROM leads WHERE id = ?', id);
    sets.push('updated_at = ?'); vals.push(nowIso());
    if (Object.prototype.hasOwnProperty.call(fields, 'converted')) {
      const conv = fields.converted ? 1 : 0;
      sets.push('converted_at = ?');
      vals.push(conv ? (wasConverted && wasConverted.converted_at) || nowIso() : null);
    }
    this.run(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    this.event('lead', id, 'lead.updated', { leadId: id, fields });
    return this.get('SELECT * FROM leads WHERE id = ?', id);
  }

  listLeads({ stage, converted, limit = 500 } = {}) {
    // v_lead_pipeline already excludes soft-deleted leads.
    const where = [];
    const vals = [];
    if (stage) { where.push('stage = ?'); vals.push(stage); }
    if (converted !== undefined && converted !== null) { where.push('converted = ?'); vals.push(converted ? 1 : 0); }
    const sql = `SELECT * FROM v_lead_pipeline ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY COALESCE(last_reply_at, last_contact_at, first_contact_at) DESC LIMIT ?`;
    return this.all(sql, ...vals, limit);
  }

  leadDetail(id) {
    const lead = this.get('SELECT * FROM leads WHERE id = ?', id);
    if (!lead) return null;
    return {
      lead,
      stage_events: this.all('SELECT * FROM lead_stage_events WHERE lead_id = ? ORDER BY changed_at', id),
      emails: this.all('SELECT id, direction, subject, status, sent_at, stage_at_send, resend_id FROM emails WHERE lead_id = ? ORDER BY COALESCE(sent_at, created_at)', id),
      replies: this.all('SELECT id, subject, from_addr, received_at, classification, deleted_at FROM replies WHERE lead_id = ? ORDER BY received_at', id),
      timeline: this.all('SELECT * FROM v_lead_timeline WHERE lead_id = ? LIMIT 200', id),
    };
  }

  stageCounts() {
    return this.all('SELECT stage, COUNT(*) AS n, SUM(converted) AS converted FROM leads WHERE deleted_at IS NULL GROUP BY stage ORDER BY n DESC');
  }

  // ------------------------------------------------------------ draft queue
  listDrafts() {
    return this.all(`SELECT id, company, from_addr AS "from", to_addr AS "to", cc_addr AS cc, subject,
                            reply_to, in_reply_to, body_text AS text, body_html AS html, attachments,
                            headers, created_at, updated_at, status, lead_id
                     FROM drafts WHERE status = 'draft' ORDER BY created_at`);
  }

  getDraft(id) {
    return this.get(`SELECT id, company, from_addr AS "from", to_addr AS "to", cc_addr AS cc, subject,
                            reply_to, in_reply_to, body_text AS text, body_html AS html, attachments,
                            headers, created_at, updated_at, status, lead_id
                     FROM drafts WHERE id = ?`, id) || null;
  }

  replaceDrafts(list) {
    // The pad rewrites the whole queue; keep rows the caller still has and mark
    // anything else as discarded rather than deleting history.
    const keep = new Set();
    for (const d of Array.isArray(list) ? list : []) {
      const id = String(d.id || '').trim();
      if (!id) continue;
      keep.add(id);
      const leadId = this.upsertLead({ email: d.to || d.to_addr, company: d.company, source: 'outreach' });
      const ts = nowIso();
      const exists = this.get('SELECT id, status FROM drafts WHERE id = ?', id);
      const vals = [leadId, d.company || null, d.from || d.from_addr || null, d.to || d.to_addr || null,
        d.cc || d.cc_addr || null, d.subject || null, d.reply_to || null, d.in_reply_to || null,
        d.text || d.body_text || null, d.html || d.body_html || null,
        d.attachments ? JSON.stringify(d.attachments) : null,
        d.headers ? JSON.stringify(d.headers) : null, ts];
      if (exists) {
        this.run(`UPDATE drafts SET lead_id=?, company=?, from_addr=?, to_addr=?, cc_addr=?, subject=?,
                  reply_to=?, in_reply_to=?, body_text=?, body_html=?, attachments=?, headers=?, updated_at=?,
                  status='draft' WHERE id=?`, ...vals, id);
      } else {
        this.run(`INSERT INTO drafts (lead_id, company, from_addr, to_addr, cc_addr, subject, reply_to,
                  in_reply_to, body_text, body_html, attachments, headers, updated_at, id, created_at, status)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`, ...vals, id, d.created_at || ts);
        this.event('draft', id, 'draft.created', { leadId, draftId: id, to: d.to || d.to_addr, subject: d.subject || '' });
      }
    }
    const open = this.all("SELECT id FROM drafts WHERE status = 'draft'");
    for (const row of open) {
      if (!keep.has(row.id)) this.run("UPDATE drafts SET status='discarded', updated_at=? WHERE id=?", nowIso(), row.id);
    }
  }

  deleteDraft(id) {
    const d = this.getDraft(id);
    if (!d) return false;
    this.run("UPDATE drafts SET status='discarded', updated_at=? WHERE id=?", nowIso(), id);
    this.event('draft', id, 'draft.discarded', { leadId: d.lead_id, draftId: id, to: d.to });
    return true;
  }

  markDraftSent(id, { bodyText, bodyHtml } = {}) {
    this.run("UPDATE drafts SET status='sent', sent_at=?, updated_at=? WHERE id=?", nowIso(), nowIso(), id);
    if (bodyText || bodyHtml) {
      this.run('UPDATE drafts SET body_text = COALESCE(?, body_text), body_html = COALESCE(?, body_html) WHERE id = ?',
        bodyText || null, bodyHtml || null, id);
    }
  }

  // ------------------------------------------------------- outbound emails
  /** Record one outbound send, linked to its lead and the stage at send time. */
  recordSend({ id, resendId, leadId, from, to, cc, replyTo, inReplyTo, subject, text, html, templateId, campaign, status, threadId, parentEmailId }) {
    const toList = addressList(to);
    const lead = leadId || this.upsertLead({ email: toList[0], source: 'outreach' });
    const stage = lead ? (this.get('SELECT stage FROM leads WHERE id = ?', lead) || {}).stage : null;
    const ts = nowIso();
    const emailId = String(id || resendId || ('mail-' + Date.now()));
    this.run(`INSERT INTO emails (id, lead_id, direction, stage_at_send, thread_id, parent_email_id, in_reply_to,
                from_addr, to_addr, cc_addr, reply_to, subject, body_text, body_html, template_id, campaign,
                resend_id, status, status_at, sent_at, created_at, updated_at)
              VALUES (?,?, 'out', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET resend_id=excluded.resend_id, status=excluded.status,
                status_at=excluded.status_at, sent_at=excluded.sent_at, updated_at=excluded.updated_at`,
      emailId, lead, stage, threadId || emailId, parentEmailId || null, inReplyTo || null,
      from || null, toList.join(', '), addressList(cc).join(', ') || null, firstAddress(replyTo) || null,
      subject || null, text || null, html || null, templateId || null, campaign || null,
      resendId || null, status || 'sent', ts, ts, ts, ts);
    if (lead) {
      this.run(`UPDATE leads SET last_contact_at = ?, first_contact_at = COALESCE(first_contact_at, ?),
                updated_at = ? WHERE id = ?`, ts, ts, ts, lead);
    }
    // The stage move is deliberately NOT applied here: this event goes through the
    // rules table (hooks.cjs), so the pad, the CRM engine and anything else that
    // reads the queue advances a lead by the same rule instead of each writing
    // its own. store.processEvents() runs the queue.
    this.event('email', emailId, 'email.sent', {
      leadId: lead, emailId, to: toList, subject, resendId: resendId || null,
      first: lead ? (this.get('SELECT COUNT(*) AS n FROM emails WHERE lead_id = ? AND direction = \'out\'', lead).n || 0) <= 1 : false,
    });
    return { emailId, leadId: lead };
  }

  updateEmailStatus(resendId, status) {
    if (!resendId) return;
    this.run('UPDATE emails SET status = ?, status_at = ?, updated_at = ? WHERE resend_id = ?',
      status, nowIso(), nowIso(), resendId);
  }

  listEmails({ leadId, limit = 200 } = {}) {
    const where = ["direction = 'out'"];
    const vals = [];
    if (leadId) { where.push('lead_id = ?'); vals.push(leadId); }
    return this.all(`SELECT id, lead_id, subject, to_addr AS "to", from_addr AS "from", status, sent_at,
                            stage_at_send, resend_id, body_text AS text, body_html AS html
                     FROM emails WHERE ${where.join(' AND ')} ORDER BY sent_at DESC LIMIT ?`, ...vals, limit);
  }

  // ---------------------------------------------------------------- replies
  /** Upsert one inbound message; never overwrites a soft delete with a new one. */
  saveReply(msg) {
    const id = String(msg.id || '').trim();
    if (!id) return null;
    const fromAddr = firstAddress(msg.from || (msg.headers && msg.headers.from));
    const lead = this.shouldTrackInbound(fromAddr)
      ? this.upsertLead({ email: fromAddr, company: msg.company, source: 'inbound' })
      : null;
    const existing = this.get('SELECT id, deleted_at FROM replies WHERE id = ?', id);
    const vals = [lead, fromAddr || null, msg.from_name || null,
      addressList(msg.received_for || msg.to).join(', ') || null, msg.subject || null,
      msg.text || null, msg.html || null, msg.message_id || null, msg.in_reply_to || null,
      msg.created_at || nowIso(), JSON.stringify(msg)];
    if (!existing) {
      this.run(`INSERT INTO replies (lead_id, from_addr, from_name, to_addr, subject, body_text, body_html,
                  message_id, in_reply_to, received_at, raw, id, created_at, is_read)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`, ...vals, id, nowIso());
      this.event('reply', id, 'reply.received', { leadId: lead, replyId: id, from: fromAddr, subject: msg.subject });
      if (lead) {
        // Stage move happens in the rules engine, driven by this event.
        this.run('UPDATE leads SET updated_at = ? WHERE id = ?', nowIso(), lead);
      }
    } else {
      // keep classification/stage/deleted state, refresh the body only
      this.run(`UPDATE replies SET lead_id=COALESCE(?, lead_id), from_addr=?, from_name=?, to_addr=?, subject=?,
                body_text=?, body_html=?, message_id=?, in_reply_to=?, received_at=?, raw=? WHERE id=?`,
        ...vals.slice(0, 11), id);
    }
    return { id, leadId: lead, deleted: !!(existing && existing.deleted_at) };
  }

  /** Ids deleted through the UI, so a live Resend listing can hide them. */
  deletedReplyIds() {
    return this.all('SELECT id FROM replies WHERE deleted_at IS NOT NULL').map((r) => r.id);
  }

  deleteReply(id) {
    const row = this.get('SELECT id, lead_id FROM replies WHERE id = ?', id);
    if (!row) return false;
    this.run('UPDATE replies SET deleted_at = ?, is_read = 1 WHERE id = ?', nowIso(), id);
    this.event('reply', id, 'reply.deleted', { leadId: row.lead_id });
    return true;
  }

  listReplies({ leadId, includeDeleted = false, limit = 200 } = {}) {
    const where = [];
    const vals = [];
    if (!includeDeleted) where.push('deleted_at IS NULL');
    if (leadId) { where.push('lead_id = ?'); vals.push(leadId); }
    return this.all(`SELECT id, lead_id, from_addr, subject, received_at, classification, sentiment,
                            is_read, deleted_at FROM replies
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                     ORDER BY received_at DESC LIMIT ?`, ...vals, limit);
  }

  stats() {
    const one = (sql) => this.get(sql) || {};
    return {
      backend: 'sqlite',
      file: this.file,
      schema_version: Number((this.get("SELECT value FROM meta WHERE key = 'schema_version'") || {}).value || 0),
      leads: one('SELECT COUNT(*) AS n FROM leads WHERE deleted_at IS NULL').n || 0,
      converted: one('SELECT COUNT(*) AS n FROM leads WHERE converted = 1 AND deleted_at IS NULL').n || 0,
      stages: this.stageCounts(),
      emails_sent: one("SELECT COUNT(*) AS n FROM emails WHERE direction = 'out'").n || 0,
      replies: one('SELECT COUNT(*) AS n FROM replies WHERE deleted_at IS NULL').n || 0,
      drafts: one("SELECT COUNT(*) AS n FROM drafts WHERE status = 'draft'").n || 0,
    };
  }

  // ------------------------------------------------- notes and the timeline
  /** Append a note to a lead's timeline (shown in the CRM's activity list). */
  note(leadId, text, { source = 'user', kind = 'note' } = {}) {
    if (!leadId || !text) return null;
    const ts = nowIso();
    this.run('INSERT INTO events(entity, entity_id, type, payload, at, actor) VALUES (?,?,?,?,?,?)',
      'lead', String(leadId), 'lead.note',
      JSON.stringify({ text: String(text).slice(0, 4000), kind, source }), ts, source);
    this.run('UPDATE leads SET updated_at = ? WHERE id = ?', ts, String(leadId));
    return ts;
  }

  /** A lead's activity, newest first, in the shape the CRM renders. */
  activity(leadId, limit = 200) {
    const kindOf = {
      'lead.created': 'created', 'lead.stage_change': 'stage', 'lead.note': 'note',
      'email.sent': 'email_out', 'reply.received': 'email_in',
      'draft.redraft_requested': 'redraft', 'draft.discarded': 'discarded',
    };
    return this.all(`SELECT id, type, payload, at AS created_at, actor AS source FROM events
                     WHERE entity = 'lead' AND entity_id = ? ORDER BY id DESC LIMIT ?`,
      String(leadId), limit).map((row) => {
      let pl = {};
      try { pl = JSON.parse(row.payload || '{}'); } catch { /* ignore */ }
      return {
        id: row.id,
        kind: kindOf[row.type] || row.type,
        type: row.type,
        detail: pl.text || pl.note || pl.subject || pl.reason || '',
        from: pl.from_stage !== undefined ? pl.from_stage : (pl.from || null),
        to: pl.to_stage !== undefined ? pl.to_stage : (pl.to || null),
        subject: pl.subject || '',
        at: row.created_at,
        source: row.source || pl.source || 'system',
      };
    });
  }

  // ------------------------------------------------- redraft feedback (learns)
  /** Send a draft back with a reason. Kept forever; feeds redraftGuidance(). */
  redraft(draftId, { reason = '', note: text = '' } = {}) {
    const id = String(draftId);
    const draft = this.getDraft(id);
    const leadId = (draft && draft.lead_id) || null;
    const ts = nowIso();
    this.run('INSERT INTO redraft_notes(draft_id, lead_id, reason, note, created_at) VALUES (?,?,?,?,?)',
      id, leadId, String(reason || '').slice(0, 120), String(text || '').slice(0, 2000), ts);
    if (draft) this.run("UPDATE drafts SET status = 'redraft', updated_at = ? WHERE id = ?", ts, id);
    this.event('draft', id, 'draft.redraft_requested', { leadId, draftId: id, reason, note: text });
    if (leadId) {
      this.note(leadId, `redraft requested${reason ? ' \u2014 ' + reason : ''}${text ? ': ' + text : ''}`,
        { source: 'user', kind: 'redraft' });
    }
    return { ok: true, draft_id: id, lead_id: leadId, at: ts };
  }

  /**
   * What keeps getting sent back, newest first. This is the learn-from-notes
   * surface: a draft generator (any language) reads it before writing, so the
   * same complaint does not come back twice.
   */
  redraftGuidance({ limit = 25 } = {}) {
    const reasons = this.all('SELECT * FROM v_redraft_reasons LIMIT 20');
    const recent = this.all(`SELECT draft_id, lead_id, reason, note, created_at FROM redraft_notes
                             WHERE TRIM(COALESCE(note, \'\')) != \'\' ORDER BY id DESC LIMIT ?`, limit);
    const total = reasons.reduce((n, r) => n + (r.n || 0), 0);
    const top = reasons.slice(0, 3).map((r) => `${r.reason} (${r.n}x)`).join(', ');
    return {
      total,
      reasons,
      recent,
      summary: top ? `Redraft reasons so far: ${top}.` : 'No redraft feedback yet.',
    };
  }

  // ------------------------------------------------------- the events backbone
  /**
   * Drain the unprocessed queue through the rule table. Called after writes and
   * on every /api/meta + /api/sync, so an event fired by one process triggers
   * its next action in the other without a message bus.
   */
  processEvents(rules, { limit = 500 } = {}) {
    if (!rules) return { processed: 0, actions: [] };
    const rows = this.all(`SELECT id, entity, entity_id, type, payload, at FROM events
                           WHERE processed_at IS NULL ORDER BY id LIMIT ?`, limit);
    const actions = [];
    // One short write transaction: the other process (pad/engine) may be writing
    // the same file, and a partially applied batch would be worse than a retry.
    let inTx = false;
    try { this.run('BEGIN IMMEDIATE'); inTx = true; } catch (e) { /* someone else is writing; drain next time */ }
    if (!inTx) return { processed: 0, actions: [], deferred: true };
    for (const row of rows) {
      let payload = {};
      try { payload = JSON.parse(row.payload || '{}'); } catch { /* ignore */ }
      const rule = rules[row.type];
      try {
        const out = rule ? rule({ event: row, payload, store: this }) : null;
        if (out) actions.push(Object.assign({ event: row.type }, out));
      } catch (err) {
        console.warn(`[EVENTS] rule for ${row.type} failed:`, err.message);
      }
      this.run('UPDATE events SET processed_at = ? WHERE id = ?', nowIso(), row.id);
    }
    this.run('COMMIT');
    return { processed: rows.length, actions };
  }

  pendingEvents(limit = 200) {
    return this.all(`SELECT id, entity, entity_id, type, payload, at FROM events
                     WHERE processed_at IS NULL ORDER BY id LIMIT ?`, limit);
  }

  recentEvents({ limit = 100, leadId } = {}) {
    const where = [];
    const vals = [];
    if (leadId) { where.push('entity_id = ?'); vals.push(String(leadId)); }
    return this.all(`SELECT id, entity, entity_id, type, payload, at, processed_at FROM events
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...vals, limit);
  }

  // ----------------------------------------------------------- CRM read model
  /** Leads with the counters the CRM shows, newest activity first. */
  crmLeads({ stage } = {}) {
    const where = ['l.deleted_at IS NULL'];
    const vals = [];
    if (stage) { where.push('l.stage = ?'); vals.push(stage); }
    return this.all(`SELECT l.*,
        (SELECT COUNT(*) FROM emails e WHERE e.lead_id = l.id AND e.direction = 'out') AS emails_sent,
        (SELECT COUNT(*) FROM replies r WHERE r.lead_id = l.id AND r.deleted_at IS NULL) AS replies,
        (SELECT MAX(e.sent_at) FROM emails e WHERE e.lead_id = l.id AND e.direction = 'out') AS last_out_at,
        (SELECT MAX(r.received_at) FROM replies r WHERE r.lead_id = l.id AND r.deleted_at IS NULL) AS last_reply_at
      FROM leads l WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(l.next_follow_up_at, l.last_contact_at, l.created_at) DESC LIMIT 1000`, ...vals);
  }

  crmCounts() {
    const counts = {};
    for (const key of this.stageOrder) counts[key] = 0;
    for (const row of this.all('SELECT stage, COUNT(*) AS n FROM leads WHERE deleted_at IS NULL GROUP BY stage')) {
      counts[row.stage] = row.n;
    }
    return counts;
  }

  /** A lead with its activity, in the CRM's detail shape. */
  crmLead(id) {
    const lead = this.get('SELECT * FROM leads WHERE id = ?', String(id));
    if (!lead) return null;
    return { lead, activity: this.activity(id) };
  }

  // ------------------------------------------------------------ meta store
  getMeta(key, fallback = null) {
    const row = this.get('SELECT value FROM meta WHERE key = ?', String(key));
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch (e) { return row.value; }
  }

  setMeta(key, value) {
    this.run(`INSERT INTO meta(key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(key), typeof value === 'string' ? value : JSON.stringify(value));
    return value;
  }

  // ---------------------------------------------------- Resend tracking
  /**
   * Record one tracking event. Idempotent on (resend_id, type, occurred_at, url),
   * so a webhook replay or a repeated poll cannot inflate the dashboard.
   */
  trackEvent(ev = {}) {
    const type = String(ev.type || '').trim().toLowerCase();
    if (!type) return { stored: false, reason: 'no type' };
    const resendId = ev.resend_id || ev.resendId || null;
    const occurredAt = ev.occurred_at || ev.occurredAt || nowIso();
    const url = ev.url || null;
    const dedupe = [resendId || '-', type, occurredAt, url || '-'].join('|');
    const exists = this.get('SELECT 1 AS x FROM tracker_events WHERE dedupe = ?', dedupe);
    if (exists) return { stored: false, reason: 'duplicate', dedupe };

    // Link back to our own records when we can: the send row by Resend id, and
    // the lead either from that send or from the recipient address.
    const mail = resendId ? this.get('SELECT id, lead_id, subject, to_addr FROM emails WHERE resend_id = ?', resendId) : null;
    const leadId = ev.lead_id || (mail && mail.lead_id) || null;
    this.run(`INSERT INTO tracker_events (resend_id, email_id, lead_id, type, occurred_at, url, user_agent,
                ip, bounce_type, subject, to_addr, source, raw, dedupe)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      resendId, ev.email_id || (mail && mail.id) || null, leadId, type, occurredAt, url,
      ev.user_agent || null, ev.ip || null, ev.bounce_type || null,
      ev.subject || (mail && mail.subject) || null, ev.to_addr || (mail && mail.to_addr) || null,
      ev.source || 'webhook', ev.raw ? JSON.stringify(ev.raw) : null, dedupe);

    // Keep the send row's status current: it is what the Sent list and the lead
    // cards read, so the dashboard and the rest of the pad cannot disagree.
    if (resendId && ['delivered', 'bounced', 'complained', 'delivery_delayed', 'failed', 'sent', 'opened', 'clicked', 'scheduled', 'canceled'].includes(type)) {
      const rank = { sent: 1, scheduled: 1, delivered: 2, opened: 3, clicked: 4, bounced: 5, complained: 5, delivery_delayed: 2, failed: 5, canceled: 0 };
      const row = this.get('SELECT status FROM emails WHERE resend_id = ?', resendId);
      const current = (row && row.status) || '';
      if (!current || (rank[type] || 0) >= (rank[current] || 0)) {
        this.run('UPDATE emails SET status = ?, status_at = ?, updated_at = ? WHERE resend_id = ?',
          type, occurredAt, nowIso(), resendId);
      }
    }
    this.event('email', resendId || 'tracker', 'tracker.' + type, { leadId, type, url, resendId });
    return { stored: true, type, leadId };
  }

  /** Everything the Trackers dashboard needs, in one round trip. */
  trackerSummary({ days = 30 } = {}) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = this.all(`SELECT substr(occurred_at, 1, 10) AS day, type, COUNT(*) AS n
                           FROM tracker_events WHERE occurred_at >= ? GROUP BY day, type ORDER BY day`, since);
    const types = ['sent', 'delivered', 'delivery_delayed', 'opened', 'clicked', 'bounced', 'complained', 'failed', 'scheduled', 'canceled'];
    const series = [];
    const byDay = new Map();
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const row = { day };
      for (const ty of types) row[ty] = 0;
      byDay.set(day, row);
      series.push(row);
    }
    for (const r of rows) {
      const row = byDay.get(r.day);
      if (row) row[r.type] = (row[r.type] || 0) + r.n;
    }
    const totals = {};
    for (const ty of types) totals[ty] = 0;
    for (const r of this.all(`SELECT type, COUNT(*) AS n FROM tracker_events WHERE occurred_at >= ? GROUP BY type`, since)) {
      totals[r.type] = r.n;
    }
    // Unique-by-send counts, which is what the rates should use.
    const uniq = this.get(`SELECT COUNT(DISTINCT resend_id) AS n FROM tracker_events WHERE type = 'delivered' AND occurred_at >= ?`, since) || {};
    const sends = this.get(`SELECT COUNT(DISTINCT resend_id) AS n FROM tracker_events WHERE occurred_at >= ?`, since) || {};
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const base = uniq.n || sends.n || 0;
    const rates = {
      delivery: pct(totals.delivered, sends.n || totals.sent || base),
      open: pct(totals.opened, base),
      click: pct(totals.clicked, base),
      click_to_open: pct(totals.clicked, totals.opened),
      bounce: pct(totals.bounced, sends.n || base),
      complaint: pct(totals.complained, base),
    };
    return {
      days,
      since,
      types,
      totals,
      unique_delivered: uniq.n || 0,
      sends_tracked: sends.n || 0,
      rates,
      series,
      funnel: [
        { step: 'tracked sends', n: sends.n || 0 },
        { step: 'delivered', n: uniq.n || 0 },
        { step: 'opened', n: this.get(`SELECT COUNT(DISTINCT resend_id) AS n FROM tracker_events WHERE type = 'opened' AND occurred_at >= ?`, since).n || 0 },
        { step: 'clicked', n: this.get(`SELECT COUNT(DISTINCT resend_id) AS n FROM tracker_events WHERE type = 'clicked' AND occurred_at >= ?`, since).n || 0 },
        { step: 'replied', n: this.get('SELECT COUNT(DISTINCT resend_id) AS n FROM tracker_events WHERE type = \'replied\' AND occurred_at >= ?', since).n || 0 },
      ],
      top_links: this.all(`SELECT url, COUNT(*) AS clicks, COUNT(DISTINCT resend_id) AS senders
                           FROM tracker_events WHERE type = 'clicked' AND url IS NOT NULL AND occurred_at >= ?
                           GROUP BY url ORDER BY clicks DESC LIMIT 10`, since),
      top_leads: this.all(`SELECT t.lead_id AS lead_id, COALESCE(l.company, l.email, t.to_addr) AS who,
                                  COUNT(*) AS events,
                                  SUM(CASE WHEN t.type = 'opened' THEN 1 ELSE 0 END) AS opens,
                                  SUM(CASE WHEN t.type = 'clicked' THEN 1 ELSE 0 END) AS clicks
                           FROM tracker_events t LEFT JOIN leads l ON l.id = t.lead_id
                           WHERE t.lead_id IS NOT NULL AND t.occurred_at >= ?
                           GROUP BY t.lead_id ORDER BY (opens + clicks) DESC, events DESC LIMIT 10`, since),
      by_source: this.all(`SELECT source, COUNT(*) AS n FROM tracker_events WHERE occurred_at >= ? GROUP BY source ORDER BY n DESC`, since),
      recent: this.all(`SELECT resend_id, type, occurred_at, url, subject, to_addr, bounce_type, source, lead_id
                        FROM tracker_events ORDER BY occurred_at DESC LIMIT 40`),
      last_event_at: (this.get('SELECT MAX(occurred_at) AS at FROM tracker_events') || {}).at || null,
    };
  }

  trackerEvents({ limit = 100, type, resendId } = {}) {
    const where = [];
    const vals = [];
    if (type) { where.push('type = ?'); vals.push(type); }
    if (resendId) { where.push('resend_id = ?'); vals.push(resendId); }
    return this.all(`SELECT * FROM tracker_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                     ORDER BY occurred_at DESC LIMIT ?`, ...vals, limit);
  }

  trackerTimeline(resendId) {
    const send = this.get('SELECT id, lead_id, subject, to_addr, status, sent_at, resend_id FROM emails WHERE resend_id = ?', resendId)
      || this.get('SELECT id, lead_id, subject, to_addr, status, sent_at, resend_id FROM emails WHERE id = ?', resendId);
    return {
      send: send || null,
      events: this.all('SELECT type, occurred_at, url, bounce_type, source FROM tracker_events WHERE resend_id = ? ORDER BY occurred_at', resendId),
    };
  }

  // --------------------------------------------- analytics points (GA4/PostHog)
  /** Upsert one metric series pushed in by an API fetch or an MCP client. */
  putAnalyticsPoints(provider, metric, points = [], source = 'api') {
    const ts = nowIso();
    let n = 0;
    for (const point of points) {
      if (!point || !point.day) continue;
      this.run(`INSERT INTO analytics_points (provider, metric, day, value, source, updated_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(provider, metric, day) DO UPDATE SET value = excluded.value,
                  source = excluded.source, updated_at = excluded.updated_at`,
        provider, metric, String(point.day).slice(0, 10), Number(point.value) || 0, source, ts);
      n += 1;
    }
    return n;
  }

  /** Stored points for a provider, grouped by metric, newest day last. */
  analyticsPoints(provider, { days = 30, metrics = ['sessions', 'pageviews', 'users', 'conversions', 'events'] } = {}) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const out = { provider, metrics: {}, days: [], updated_at: null };
    for (let i = days - 1; i >= 0; i -= 1) out.days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    for (const metric of metrics) {
      const rows = this.all('SELECT day, value FROM analytics_points WHERE provider = ? AND metric = ? AND day >= ? ORDER BY day',
        provider, metric, since);
      if (rows.length) out.metrics[metric] = rows;
    }
    const last = this.get('SELECT MAX(updated_at) AS at FROM analytics_points WHERE provider = ?', provider);
    out.updated_at = (last && last.at) || null;
    return out;
  }

  /** Every point pushed in from outside (source != 'api'), grouped per provider. */
  analyticsIngested({ days = 30 } = {}) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows = this.all(`SELECT provider, metric, day, value, source FROM analytics_points
                           WHERE source != 'api' AND day >= ? ORDER BY provider, metric, day`, since);
    const metrics = {};
    const providers = new Set();
    for (const r of rows) {
      providers.add(r.provider);
      const key = `${r.provider}.${r.metric}`;
      (metrics[key] = metrics[key] || []).push({ day: r.day, value: r.value });
    }
    const last = this.get("SELECT MAX(updated_at) AS at FROM analytics_points WHERE source != 'api'");
    return { providers: [...providers], metrics, updated_at: (last && last.at) || null, points: rows.length };
  }

  // ----------------------------------------------- one-time legacy import
  importLegacy() {
    const done = this.get("SELECT value FROM meta WHERE key = 'legacy_imported'");
    if (done) return;
    const stamp = nowIso();
    let imported = { drafts: 0, sent: 0, webhooks: 0 };

    const draftsFile = path.join(this.dataDir, 'drafts.json');
    if (fs.existsSync(draftsFile)) {
      try {
        const arr = JSON.parse(fs.readFileSync(draftsFile, 'utf8'));
        if (Array.isArray(arr)) { this.replaceDrafts(arr); imported.drafts = arr.length; }
        fs.renameSync(draftsFile, draftsFile + '.imported');
      } catch (err) { console.warn('[DB] drafts import skipped:', err.message); }
    }

    const sentFile = path.join(this.dataDir, 'sent-drafts.jsonl');
    if (fs.existsSync(sentFile)) {
      try {
        const lines = fs.readFileSync(sentFile, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          let e; try { e = JSON.parse(line); } catch { continue; }
          this.recordSend({
            id: e.id || e.resend_id, resendId: e.resend_id, to: e.to, subject: e.subject,
            status: 'sent', company: e.company,
          });
          if (e.sent_at) {
            this.run('UPDATE emails SET sent_at = ?, created_at = ?, status_at = ? WHERE id = ?',
              e.sent_at, e.sent_at, e.sent_at, String(e.id || e.resend_id));
          }
        }
        imported.sent = lines.length;
        fs.renameSync(sentFile, sentFile + '.imported');
      } catch (err) { console.warn('[DB] sent import skipped:', err.message); }
    }

    const hookFile = path.join(this.dataDir, 'webhooks.jsonl');
    if (fs.existsSync(hookFile)) {
      try {
        const lines = fs.readFileSync(hookFile, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          const d = (ev.event && (ev.event.data || ev.event)) || {};
          const type = (ev.event && ev.event.type) || 'webhook';
          const emailId = d.email_id || d.id || null;
          if (emailId) this.updateEmailStatus(emailId, String(type).split('.').pop());
          this.event('system', emailId, 'webhook', { type, received_at: ev.received_at });
        }
        imported.webhooks = lines.length;
        fs.renameSync(hookFile, hookFile + '.imported');
      } catch (err) { console.warn('[DB] webhook import skipped:', err.message); }
    }

    this.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      'legacy_imported', stamp);
    console.log(`[DB] imported legacy files: ${imported.drafts} drafts, ${imported.sent} sent, ${imported.webhooks} webhook events`);
  }
}

module.exports = {
  open, Store, leadIdFor, firstAddress, addressList, slug,
  SCHEMA_VERSION, DEFAULT_STAGES, available: !!DatabaseSync,
};
