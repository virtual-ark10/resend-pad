#!/usr/bin/env node
/**
 * The engagement + failure layer, tested against the REAL store (tests/engagement_store_test.cjs).
 *
 * What this pins down — the two things that must never drift:
 *   1. engagement RECORDS. An open/click never moves a stage and never writes
 *      emails.status, because a second writer of either collapses the funnel
 *      (an open must not overwrite 'delivered'; a bounce must not look opened).
 *   2. the QUEUE MOVES. A rule that keeps throwing records attempts + last_error
 *      and is dead-lettered after maxAttempts, so one bad rule cannot stall
 *      every event behind it.
 *
 * Run: node tests/engagement_store_test.cjs        (offline; temp store, no network)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const db = require('../db.cjs');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    failures.push(name + ' :: ' + (err && err.message));
    console.log('  FAIL  ' + name + '\n          ' + (err && err.message));
  }
}

if (!db.available) {
  console.error('node:sqlite is not available in this node build — cannot run the store tests');
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-eng-test-'));
const store = db.open(dir, { stages: db.DEFAULT_STAGES });

console.log('store: ' + path.join(dir, 'pad.db'));
assert.ok(store, 'store failed to open');
check('SCHEMA_VERSION is 3 (queue columns + engagement are this build)', () => {
  assert.strictEqual(db.SCHEMA_VERSION, 3);
});

// ------------------------------------------------------------------ fixture
const leadId = store.upsertLead({ email: 'probe@example.com', company: 'Probe Co' });
store.setStage(leadId, 'first_email', { by: 'test', note: 'sending now' });
store.recordSend({
  id: 'mail-1', resendId: 'rs-1', leadId, to: 'probe@example.com',
  from: 'sender@example.com', subject: 'hi', text: 'text body', html: '<p>text body</p>',
  status: 'delivered',
});

const stageBefore = store.get('SELECT stage FROM leads WHERE id = ?', leadId).stage;
const statusBefore = store.get('SELECT status FROM emails WHERE resend_id = ?', 'rs-1').status;

// --------------------------------------------------------------- engagement
check('an open is recorded once, matched to the mail and the lead', () => {
  const r = store.recordEngagement({ resend_id: 'rs-1', kind: 'open', at: '2026-09-11T10:00:00.000Z' });
  assert.strictEqual(r.inserted, 1, 'expected one row');
  assert.strictEqual(r.matched, true, 'expected the mail to be matched by resend_id');
  assert.strictEqual(r.lead_id, leadId, 'expected the lead to be attached');
});

check('a click is recorded with its host and url', () => {
  const r = store.recordEngagement({
    resend_id: 'rs-1', kind: 'click', url: 'https://example.com/pricing?utm=x',
    user_agent: 'probe/1.0', ip: '203.0.113.9', at: '2026-09-11T10:05:00.000Z',
  });
  assert.strictEqual(r.inserted, 1);
  const row = store.get("SELECT * FROM email_engagements WHERE kind = 'click'");
  assert.strictEqual(row.link_host, 'example.com', 'hostname should be derived');
  assert.strictEqual(row.lead_id, leadId);
});

check('a webhook retry is a no-op (dedupe key), not a second row', () => {
  const again = store.recordEngagement({
    resend_id: 'rs-1', kind: 'open', at: '2026-09-11T10:00:00.000Z',
    dedupe: ['open', 'rs-1', '', '2026-09-11T10:00:00.000Z'].join('|'),
  });
  assert.strictEqual(again.inserted, 0, 'the retry must not insert');
  assert.strictEqual(again.duplicate, true);
  const n = store.get("SELECT COUNT(*) AS n FROM email_engagements WHERE kind = 'open'").n;
  assert.strictEqual(Number(n), 1, 'exactly one open row survives a retry');
});

check('THE INVARIANT: engagement never moves a stage and never writes emails.status', () => {
  const stageAfter = store.get('SELECT stage FROM leads WHERE id = ?', leadId).stage;
  const statusAfter = store.get('SELECT status FROM emails WHERE resend_id = ?', 'rs-1').status;
  assert.strictEqual(stageAfter, stageBefore, 'an open must not advance the pipeline');
  assert.strictEqual(statusAfter, statusBefore, "an open must not overwrite 'delivered'");
  assert.strictEqual(statusAfter, 'delivered');
});

check('the counters are derived from the rows', () => {
  const t = store.engagementTotals('2026-01-01T00:00:00.000Z');
  assert.strictEqual(Number(t.opens), 1);
  assert.strictEqual(Number(t.email_clicks), 1);
  assert.strictEqual(Number(t.opened_messages), 1);
  assert.strictEqual(Number(t.clicked_leads), 1);
  const series = store.engagementSeries('2026-01-01T00:00:00.000Z');
  assert.strictEqual(series.length, 1, 'one day bucket');
  assert.strictEqual(Number(series[0].opens), 1);
  const links = store.topLinks('2026-01-01T00:00:00.000Z', 5);
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0].host, 'example.com');
  const perLead = store.engagementForLead(leadId);
  assert.strictEqual(Number(perLead.opens), 1);
  assert.strictEqual(Number(perLead.email_clicks), 1);
});

check('an unmatched resend_id is still stored (a click can arrive before the mail row)', () => {
  const r = store.recordEngagement({ resend_id: 'rs-unknown', kind: 'open', at: '2026-09-11T11:00:00.000Z' });
  assert.strictEqual(r.inserted, 1);
  assert.strictEqual(r.matched, false);
  assert.strictEqual(r.lead_id, null);
});

// ------------------------------------------------------------------ failures
check('a failure is a first-class event, grouped by op', () => {
  store.logFailure({ entity: 'webhook', op: 'probe_op', error: new Error('boom'), status: 500, actor: 'test' });
  const row = store.get("SELECT * FROM events WHERE type = 'error' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'expected an error event');
  const payload = JSON.parse(row.payload);
  assert.strictEqual(payload.op, 'probe_op');
  assert.strictEqual(payload.message, 'boom');
  assert.strictEqual(payload.status, 500);
});

check('logFailure never throws, even with nothing useful to record', () => {
  const r1 = store.logFailure({ op: 'no_error_object' });
  const r2 = store.logFailure({});
  assert.ok(r1 !== undefined || r2 !== undefined);
  const n = store.get("SELECT COUNT(*) AS n FROM events WHERE type = 'error'").n;
  assert.ok(Number(n) >= 3, 'both failures recorded');
});

// --------------------------------------------------------------------- queue
check('a failing rule records attempts and keeps the message', () => {
  const rules = { 'probe.bad': () => { throw new Error('rule exploded'); } };
  store.event('system', 'probe-1', 'probe.bad', { n: 1 });
  const first = store.processEvents(rules, { maxAttempts: 2 });
  assert.ok(first.actions.some((a) => a.retry === 1), 'first failure is a retry');
  const row = store.get("SELECT attempts, last_error, processed_at FROM events WHERE entity_id = 'probe-1'");
  assert.strictEqual(Number(row.attempts), 1);
  assert.match(String(row.last_error), /rule exploded/);
  assert.strictEqual(row.processed_at, null, 'still queued for another attempt');
});

check('after maxAttempts the row is dead-lettered, not stuck', () => {
  const rules = { 'probe.bad': () => { throw new Error('rule exploded'); } };
  const second = store.processEvents(rules, { maxAttempts: 2 });
  assert.ok(second.actions.some((a) => a.dead_lettered), 'expected a dead-letter');
  const row = store.get("SELECT attempts, last_error, processed_at FROM events WHERE entity_id = 'probe-1'");
  assert.strictEqual(Number(row.attempts), 2);
  assert.ok(row.processed_at, 'dead-lettered rows are marked processed so the queue moves');
  const err = store.get("SELECT payload FROM events WHERE type = 'error' AND json_extract(payload, '$.op') = 'rule_probe.bad'");
  assert.ok(err, 'the dead-letter wrote an error event');
  assert.strictEqual(JSON.parse(err.payload).op, 'rule_probe.bad');
});

check('events behind a dead-lettered one still get processed', () => {
  // A good rule registered for a good event, queued BEFORE the second failing drain.
  const good = { 'probe.good': () => ({ note: 'done' }) };
  store.event('system', 'probe-2', 'probe.good', { n: 1 });
  const done = store.processEvents(good, { maxAttempts: 2 });
  assert.ok(done.processed >= 1, 'the queue kept moving');
  const row = store.get("SELECT processed_at FROM events WHERE entity_id = 'probe-2'");
  assert.ok(row.processed_at, 'the good event was processed');
});

check('the pending view is empty once everything is claimed or dead-lettered', () => {
  const pending = store.pendingEvents(50);
  assert.deepStrictEqual(pending.map((r) => r.entity_id), []);
});

check('a rule that succeeds reports its outcome and marks the event', () => {
  store.event('system', 'probe-3', 'probe.ok', { n: 1 });
  const rules = { 'probe.ok': () => ({ note: 'acted' }) };
  const r = store.processEvents(rules, { maxAttempts: 2 });
  assert.strictEqual(r.processed, 1);
  assert.strictEqual(r.actions[0].note, 'acted');
});

// ------------------------------------------------------------------- report
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* leave it */ }
process.exit(failed ? 1 : 0);
