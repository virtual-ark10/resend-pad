#!/usr/bin/env node
/**
 * Boot race on a shared store (tests/migration_race_test.cjs).
 *
 * The pad and its leads engine open the SAME SQLite file, and both run the same
 * migration. If they start together on a store that is missing a column, both see
 * it missing and both add it — the loser used to get "duplicate column name" and
 * die on boot, which on a production box looks like a service that restarts itself
 * for no reason. The same applies to the four engagement views, which were created
 * without IF NOT EXISTS.
 *
 * Workers spin to a shared wall-clock instant so the race is real rather than
 * probabilistic; with the guards in place, none of them may die.
 *
 * Run: node tests/migration_race_test.cjs        (offline, throwaway stores)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const WORKERS = 4;
const ROUNDS = 4;
let passed = 0;
let failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; console.log('  PASS  ' + name); }
  catch (err) { failed += 1; failures.push(name + ' :: ' + (err && err.message)); console.log('  FAIL  ' + name + '\n          ' + (err && err.message)); }
}

/** A store from before this build: an events table with no attempts/last_error. */
function fixture(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(dir, 'pad.db'));
  d.exec(`CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT, entity_id TEXT, type TEXT,
      payload TEXT, at TEXT, actor TEXT, processed_at TEXT);`);
  d.close();
}

const workerSrc = `
const { workerData, parentPort } = require('worker_threads');
while (Date.now() < workerData.start) { /* spin: start together */ }
let err = null;
try { require(workerData.dbc).open(workerData.dir, {}); } catch (e) { err = e.message; }
parentPort.postMessage(err);
`;

function round(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `migrace${n}-`));
  fixture(dir);
  const start = Date.now() + 300;
  const kids = Array.from({ length: WORKERS }, () => new Worker(workerSrc, {
    eval: true,
    workerData: { dbc: path.join(__dirname, '..', 'db.cjs'), dir, start },
  }));
  return Promise.all(kids.map((w) => new Promise((res) => {
    w.on('message', (m) => res(m));
    w.on('error', (e) => res('worker error: ' + e.message));
  }))).then((errs) => {
    fs.rmSync(dir, { recursive: true, force: true });
    return errs.filter(Boolean);
  });
}

(async () => {
  const deaths = [];
  for (let i = 1; i <= ROUNDS; i += 1) deaths.push(...(await round(i)));

  check(`${WORKERS} processes x ${ROUNDS} rounds open one store without dying`, () => {
    if (deaths.length) throw new Error(`${deaths.length} of ${WORKERS * ROUNDS} died: ${deaths[0]}`);
  });

  // And the migration still does its job when only one process is running.
  const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'migrace-solo-'));
  fixture(solo);
  require('../db.cjs').open(solo, {});
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(solo, 'pad.db'), { readOnly: true });
  const cols = d.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  const views = d.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all().map((r) => r.name);
  check('a single process still migrates the old store', () => {
    for (const c of ['processed_at', 'attempts', 'last_error']) {
      if (!cols.includes(c)) throw new Error(`events.${c} missing`);
    }
    for (const v of ['v_events_pending', 'v_engagement_daily', 'v_engagement_by_lead', 'v_email_engagement', 'v_top_links']) {
      if (!views.includes(v)) throw new Error(`view ${v} missing`);
    }
  });
  d.close();
  fs.rmSync(solo, { recursive: true, force: true });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('\nfailures:'); for (const f of failures) console.log('  - ' + f); }
  process.exit(failed ? 1 : 0);
})();
