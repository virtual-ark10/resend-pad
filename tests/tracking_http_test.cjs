#!/usr/bin/env node
/**
 * The ported tracking surface, over real HTTP (tests/tracking_http_test.cjs).
 *
 * Boots the pad on a spare port against a THROWAWAY store, then drives it the way
 * Resend does — a signed webhook — and reads the dashboard endpoint back.
 *
 * It pins the thing that matters most: an OPEN must not touch the delivery status.
 * Before this port, an open was routed to the delivery-status path, so 'delivered'
 * became 'opened', the funnel collapsed, and a bounced mail could look opened.
 *
 * Run: node tests/tracking_http_test.cjs        (offline; no Resend calls)
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log('  PASS  ' + name); }
  catch (err) { failed += 1; failures.push(name + ' :: ' + (err && err.message)); console.log('  FAIL  ' + name + '\n          ' + (err && err.message)); }
}

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'probe-pad-token';
const SECRET = 'whsec_' + Buffer.from('probe-webhook-signing-secret-value').toString('base64');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-http-test-'));
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  useCase: 'outbound',
  brand: { name: 'Probe Labs', siteUrl: 'https://probe.example' },
  from: 'Probe Labs <hello@probe.example>',
  firstTab: 'tracking',
  tabs: [
    { id: 'leads', label: 'Leads', enabled: true },
    { id: 'compose', label: 'Compose', enabled: true },
    { id: 'tracking', label: 'Tracking', enabled: true },
    { id: 'analytics', label: 'Analytics', enabled: true },
  ],
  tracking: { openTracking: true, clickTracking: true, trackingSubdomain: 'analytics.probe.example' },
  leads: { enabled: false },
}));

function sign(body) {
  const id = 'msg_' + crypto.randomBytes(8).toString('hex');
  const ts = String(Math.floor(Date.now() / 1000));
  const secret = Buffer.from(SECRET.slice(6), 'base64');
  const sig = crypto.createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}`, 'content-type': 'application/json' };
}

async function get(p, headers) {
  const res = await fetch(BASE + p, { headers: headers || {} });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* html */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function webhook(type, data, envelopeAt) {
  const body = JSON.stringify({ type, created_at: envelopeAt || new Date().toISOString(), data });
  const res = await fetch(BASE + '/api/webhook', { method: 'POST', headers: sign(body), body });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.cjs')], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DATA_DIR: dir, CONFIG_FILE: path.join(dir, 'config.json'),
    PAD_TOKEN: TOKEN, RESEND_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: '',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d.toString(); });
child.stderr.on('data', (d) => { serverLog += d.toString(); });

function done(code) {
  try { child.kill('SIGTERM'); } catch (e) { /* gone */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* leave it */ }
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('\nfailures:'); for (const f of failures) console.log('  - ' + f); }
  if (code) console.log('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-25).join('\n'));
  process.exit(code);
}

(async () => {
  // wait for boot
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try { const r = await get('/api/health'); up = r.status === 200; } catch (e) { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) { console.error('server did not come up'); done(2); return; }

  // seed the store the same way a real send does: a lead and an accepted mail
  const db = require('../db.cjs');
  const store = db.open(dir, {});
  const leadId = store.upsertLead({ email: 'buyer@probe.example', company: 'Buyer Co' });
  store.setStage(leadId, 'first_email', { by: 'test' });
  store.recordSend({ id: 'mail-http-1', resendId: 'rs-http-1', leadId, to: 'buyer@probe.example',
    from: 'hello@probe.example', subject: 'probe', text: 'body', html: '<p>body</p>', status: 'delivered' });

  const cfg = await get('/api/config', { 'X-Pad-Token': TOKEN });
  check('/api/config exposes the tracking tab from config.json', () => {
    assert.strictEqual(cfg.status, 200);
    const ids = (cfg.json.tabs || []).map((t) => t.id);
    assert.ok(ids.includes('tracking'), 'tracking tab missing from /api/config: ' + ids);
    assert.ok(/Probe Labs/.test(JSON.stringify(cfg.json)), 'brand name missing from /api/config');
  });

  const bad = await fetch(BASE + '/api/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('an unsigned webhook is rejected and recorded as a failure', async () => { /* below */ });
  assert.strictEqual(bad.status, 400);
  const errs = store.all("SELECT payload FROM events WHERE type = 'error'");
  assert.ok(errs.some((e) => JSON.parse(e.payload).op === 'webhook_signature'), 'signature failure not recorded');

  const del = await webhook('email.delivered', { email_id: 'rs-http-1', to: ['buyer@probe.example'] });
  check('a delivery webhook sets the mail status', () => {
    assert.strictEqual(del.status, 200);
    assert.strictEqual(store.get('SELECT status FROM emails WHERE resend_id = ?', 'rs-http-1').status, 'delivered');
  });

  // The send queued an email.sent event, and in THIS engine the rules table is the
  // stage writer, so it advances on the next drain. Settle that first: the stage is
  // then whatever an OPEN must leave alone.
  await get('/api/config', { 'X-Pad-Token': TOKEN });
  const stageBefore = store.get('SELECT stage FROM leads WHERE id = ?', leadId).stage;

  const OPEN_ENVELOPE = '2026-09-11T10:00:00.000Z';
  const open1 = await webhook('email.opened', { email_id: 'rs-http-1', to: ['buyer@probe.example'], created_at: OPEN_ENVELOPE }, OPEN_ENVELOPE);
  check('an open is recorded as engagement, matched to the mail and lead', () => {
    assert.strictEqual(open1.status, 200);
    assert.strictEqual(open1.json.stored.inserted, 1);
    assert.strictEqual(open1.json.stored.lead_id, leadId);
  });

  check('THE INVARIANT over HTTP: the open did NOT overwrite the delivery status', () => {
    const row = store.get('SELECT status FROM emails WHERE resend_id = ?', 'rs-http-1');
    assert.strictEqual(row.status, 'delivered', "an open must never write emails.status (was 'opened')");
    assert.strictEqual(store.get('SELECT stage FROM leads WHERE id = ?', leadId).stage, stageBefore, 'an open must not move a stage');
  });

  // A RETRY re-delivers the SAME body (Svix replays the payload), which is what
  // must collapse to one row — a redelivery with a NEW envelope time is a new
  // event, not a retry, and is allowed to be a second open.
  const open2 = await webhook('email.opened', { email_id: 'rs-http-1', to: ['buyer@probe.example'], created_at: OPEN_ENVELOPE }, OPEN_ENVELOPE);
  check('a redelivered webhook is a no-op, not a second open', () => {
    assert.strictEqual(open2.json.stored.inserted, 0);
    assert.strictEqual(open2.json.stored.duplicate, true);
    const n = store.get("SELECT COUNT(*) AS n FROM email_engagements WHERE kind = 'open'").n;
    assert.strictEqual(Number(n), 1);
  });

  const click = await webhook('email.clicked', {
    email_id: 'rs-http-1', to: ['buyer@probe.example'],
    created_at: '2026-09-11T10:04:00.000Z',
    click: { link: 'https://probe.example/pricing', timestamp: '2026-09-11T10:04:00.000Z', ipAddress: '203.0.113.5', userAgent: 'probe/1.0' },
  });
  check('a click carries its link, host and user agent', () => {
    assert.strictEqual(click.json.stored.inserted, 1);
    const row = store.get("SELECT * FROM email_engagements WHERE kind = 'click'");
    assert.strictEqual(row.link_host, 'probe.example');
    assert.strictEqual(row.user_agent, 'probe/1.0');
  });

  const trk = await get('/api/tracking?days=30', { 'X-Pad-Token': TOKEN });
  check('/api/tracking returns the dashboard payload in one round trip', () => {
    assert.strictEqual(trk.status, 200);
    const d = trk.json;
    assert.strictEqual(Number(d.totals.opens), 1);
    assert.strictEqual(Number(d.totals.email_clicks), 1);
    assert.strictEqual(Number(d.totals.delivered), 1);
    assert.ok(Array.isArray(d.by_day) && d.by_day.length, 'by_day series missing');
    assert.ok(d.engagement && d.engagement.open_rate !== undefined, 'engagement block missing');
    assert.ok(d.sources, 'sources block missing');
    assert.strictEqual(d.sources.clicks_tracked, false, 'site clicks must report as NOT tracked when the optional layer is off');
    assert.strictEqual(d.sources.attribution_mirror, 'not configured');
    assert.strictEqual(d.sources.tracking_domain, 'analytics.probe.example');
  });

  check('/api/tracking reports the recorded failure by operation', () => {
    const ops = (trk.json.error_ops || []).map((r) => r.op);
    assert.ok(ops.includes('webhook_signature'), 'failure ops: ' + JSON.stringify(ops));
  });

  check('the dashboard needs the pad token', async () => { /* below */ });
  const noTok = await get('/api/tracking');
  assert.strictEqual(noTok.status, 401);

  const page = await get('/');
  check('the client is served with the tracking panel and NO external asset', () => {
    assert.strictEqual(page.status, 200);
    assert.ok(/panel-tracking/.test(page.text), 'tracking panel missing from the served HTML');
    assert.ok(/panel-analytics/.test(page.text), 'analytics panel missing');
    const external = page.text.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) || [];
    assert.deepStrictEqual(external, [], 'external assets must never be referenced: ' + external.join(', '));
  });

  check('the client degrades instead of breaking when Chart.js is absent', () => {
    assert.ok(/Charts unavailable/.test(page.text), 'no graceful-degradation note');
    assert.ok(/vendor\/chart\.umd\.min\.js/.test(page.text), 'the chart asset must be referenced RELATIVELY');
  });

  done(failed ? 1 : 0);
})().catch((err) => { console.error(err); done(3); });
