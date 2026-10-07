#!/usr/bin/env node
/**
 * Inbound reply bodies that arrive as metadata only (tests/reply_body_hydration_test.cjs).
 *
 * What this pins down:
 *   1. Resend's `email.received` webhook carries NO body, so the reply row is born
 *      with a subject and empty text/html. hydrateReplyBody() is the only thing that
 *      fills it, and the API's acknowledgement waits for that fetch.
 *   2. Only an EMPTY column is written. A re-delivered webhook, or a second hydrate
 *      with different content, must never overwrite a body already on the row —
 *      otherwise a retry can blank the message an agent is midway through reading.
 *   3. saveReply() on the duplicate path is COALESCEd for the same reason: the
 *      upsert used to write the absent body straight through, so the second
 *      delivery of one message erased the body the first delivery's hydrate had
 *      stored.
 *
 * Run: node tests/reply_body_hydration_test.cjs        (offline; temp store, no network)
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-reply-body-'));
const store = db.open(dir, { stages: db.DEFAULT_STAGES });
assert.ok(store, 'store failed to open');

const RID = 're_hydrate_1';
const META = {
  id: RID,
  from: 'prospect@example.com',
  to: ['owner@example.com'],
  subject: 'Re: spotted you in the newsletter',
  message_id: '<abc@example.com>',
  created_at: '2026-10-07T07:02:16.871Z',
};

check('a webhook-shaped reply is stored with no body (metadata only)', () => {
  const saved = store.saveReply(META);
  assert.strictEqual(saved.id, RID);
  const row = store.get('SELECT body_text, body_html FROM replies WHERE id = ?', RID);
  assert.strictEqual(row.body_text, null, 'the webhook carries no text');
  assert.strictEqual(row.body_html, null, 'the webhook carries no html');
});

check('hydrateReplyBody fills an empty body from the receiving endpoint', () => {
  const r = store.hydrateReplyBody(RID, { text: 'Hi, is this data available via API?', html: '<p>Hi</p>' });
  assert.strictEqual(r.updated, 1, 'expected one row updated');
  const row = store.get('SELECT body_text, body_html FROM replies WHERE id = ?', RID);
  assert.strictEqual(row.body_text, 'Hi, is this data available via API?');
  assert.strictEqual(row.body_html, '<p>Hi</p>');
});

check('a second hydrate never overwrites a body already stored', () => {
  const r = store.hydrateReplyBody(RID, { text: 'OVERWRITTEN', html: '<p>OVERWRITTEN</p>' });
  assert.strictEqual(r.updated, 0, 'an existing body must not be rewritten');
  const row = store.get('SELECT body_text FROM replies WHERE id = ?', RID);
  assert.strictEqual(row.body_text, 'Hi, is this data available via API?');
});

check('re-delivering the same webhook does not blank the stored body', () => {
  // This is the regression that matters: saveReply's duplicate branch used to write
  // the payload's absent text/html straight through.
  store.saveReply(Object.assign({}, META, { message_id: '<abc@example.com>' }));
  const row = store.get('SELECT body_text, body_html FROM replies WHERE id = ?', RID);
  assert.strictEqual(row.body_text, 'Hi, is this data available via API?', 'the body survived the retry');
  assert.strictEqual(row.body_html, '<p>Hi</p>', 'the html survived the retry');
});

check('a later delivery that DOES carry a body still refreshes it', () => {
  store.saveReply(Object.assign({}, META, { text: 'full body from a richer payload', html: '<p>full</p>' }));
  const row = store.get('SELECT body_text FROM replies WHERE id = ?', RID);
  assert.strictEqual(row.body_text, 'full body from a richer payload');
});

check('html-only hydration leaves text alone', () => {
  const rid = 're_hydrate_2';
  store.saveReply(Object.assign({}, META, { id: rid, message_id: '<def@example.com>' }));
  const r = store.hydrateReplyBody(rid, { text: null, html: '<p>only html</p>' });
  assert.strictEqual(r.updated, 1);
  const row = store.get('SELECT body_text, body_html FROM replies WHERE id = ?', rid);
  assert.strictEqual(row.body_text, null, 'text stays empty — nothing to write');
  assert.strictEqual(row.body_html, '<p>only html</p>');
});

check('a hydrate with nothing to write, or an unknown id, is a no-op', () => {
  assert.strictEqual(store.hydrateReplyBody(RID, {}).updated, 0);
  assert.strictEqual(store.hydrateReplyBody('re_does_not_exist', { text: 'x' }).updated, 0);
  assert.strictEqual(store.hydrateReplyBody('', { text: 'x' }).updated, 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
try { store.close(); } catch (e) { /* nothing to close */ }
fs.rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('reply body hydration: OK');
