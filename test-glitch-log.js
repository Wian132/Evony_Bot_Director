'use strict';
// The glitch log (glitch-log.js): a record of what every town held either side of
// each maintenance, the relog that makes those figures honest, and the runs of that
// day. Offline — a throwaway database, no network, no game, no console.
//
// What it is guarding, in order:
//   * the before/after records go in under their own kind and never mix with the
//     hourly or the 08:30 record;
//   * `due()` asks for each step at its own moment and only once;
//   * a relog is NEVER asked for on a window nobody announced, and never inside the
//     stand-down (EVONY-RULES §2: a login there holds the account back ~30 minutes);
//   * an "after" waits for the consoles' own fresh snapshots, but is still filed if
//     they never come;
//   * a town's figures are only called "live" when that account really was relogged
//     before the record was taken;
//   * a finished run survives the next Start (the settings keep only the current one).
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-glitchlog-'));
process.env.EVONY_DB = path.join(TMP, 't.db');

const D = require('./db');
const AUTH = require('./auth');
const GL = require('./glitch-log');
const MAINT = require('./maint');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log('  ok    ' + n); pass++; }
  catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; } };

const op = AUTH.register({ email: 'glitch@example.com', password: 'correct horse battery', orgName: 'Glitch Org' });
const ORG = D.org(op.org.id);
const ORGID = op.org.id;
const BANK = ORG.accounts.upsert({ label: 'Lord03', server: 'ss71', pos: 1 });
const OURS = ORG.accounts.upsert({ label: 'Lord04', server: 'ss71', pos: 2 });

const MIN = 60000;
// the day under test: a maintenance at 09:00 local, back at 09:32
const DAY = GL.dayKey(Date.now());
const START = GL.atOn(DAY, 9, 0);
const PAUSE = START - 5 * MIN;
const RESUME = START + 15 * MIN;
const END = START + 32 * MIN;

// What a console publishes: the Director files it under account_latest, which is
// where city-resources reads the per-city figures from.
function publish(accountId, at, cities) {
  ORG.snapshots.add(accountId, {
    at, ok: true, cities: cities.length, totals: {}, cityList: cities,
  });
}
const town = (id, name, food, wood, stone, iron, gold) => ({ id, name, x: 100 + id, y: 200, food, wood, stone, iron, gold });

console.log('\nthe record itself\n');

// going in: the bank has been sold dry, our account is full of what it bought
publish(BANK.id, PAUSE - MIN, [town(1, 'Lord03 One', 10e9, 1e9, 2e9, 1e9, 5e9), town(2, 'Lord03 Two', 20e9, 800e9, 1e9, 1e9, 4e9)]);
publish(OURS.id, PAUSE - MIN, [town(1, 'Lord04 One', 50e9, 700e9, 10e9, 10e9, 100e9)]);

t('a "before" record files every town under its own kind', () => {
  GL.saveEvent(ORGID, DAY, { server: 'ss71', startAt: START, pauseAt: PAUSE, resumeAt: RESUME, source: 'announced' });
  const r = GL.take({ orgId: ORGID, day: DAY, side: 'before', now: PAUSE,
    accounts: [{ id: BANK.id, label: 'Lord03', lord: 'Lord03', holiday: true, side: 'bank' },
      { id: OURS.id, label: 'Lord04', lord: 'Lord04', holiday: false, side: 'buy' }] });
  assert.equal(r.taken, true);
  assert.equal(r.rows, 3, 'three towns');
  assert.equal(r.kind, `maint:${DAY}:before`);
  const hourly = D.one("SELECT count(*) c FROM city_resources WHERE orgId = ? AND kind IS NULL", ORGID);
  assert.equal(hourly.c, 0, 'the hourly record is untouched');
});

t('the window and who each account was are kept with it', () => {
  const row = GL.eventRow(ORGID, DAY);
  assert.equal(row.startAt, START);
  assert.equal(row.beforeAt, PAUSE);
  assert.equal(row.accounts[BANK.id].holiday, true);
  assert.equal(row.accounts[BANK.id].side, 'bank');
  assert.equal(row.accounts[OURS.id].holiday, false);
});

t('taking the same side twice replaces it rather than doubling the towns', () => {
  GL.take({ orgId: ORGID, day: DAY, side: 'before', now: PAUSE });
  const n = D.one('SELECT count(*) c FROM city_resources WHERE orgId = ? AND kind = ?', ORGID, GL.kindOf(DAY, 'before'));
  assert.equal(n.c, 3);
});

console.log('\nwhat is due, and when\n');

const store = (rows = {}) => ({ rows, get(k, d = null) { return k in this.rows ? this.rows[k] : d; }, set(k, v) { this.rows[k] = v; } });
// an org handle shaped like the real one, with its own settings
const orgLike = (settings) => ({ orgId: ORGID, settings });

t('nothing is due before the lead time', () => {
  GL.saveEvent(ORGID, DAY, { beforeAt: 0, relogAt: 0, afterAt: 0 });
  const org = orgLike(store());
  assert.equal(GL.due(org, START - 40 * MIN), null);
});

t('a relog is due inside the lead, once the window is announced', () => {
  const org = orgLike(store());
  const step = GL.due(org, START - 10 * MIN);
  assert.ok(step, 'a step');
  assert.equal(step.action, 'relog');
  assert.equal(step.day, DAY);
});

t('a relog is NEVER due on a window nobody announced', () => {
  GL.saveEvent(ORGID, DAY, { source: 'assumed' });
  const org = orgLike(store());
  assert.equal(GL.due(org, START - 10 * MIN), null, 'a guessed time is not worth a login');
  GL.saveEvent(ORGID, DAY, { source: 'announced' });
});

t('a relog is not due once the fleet has stood down', () => {
  const org = orgLike(store());
  const step = GL.due(org, PAUSE + MIN);
  assert.equal(step.action, 'before', 'the stand-down has started: record, do not log in');
});

t('a relog is asked for only once', () => {
  GL.markRelog(ORGID, DAY, { [BANK.id]: { ok: true, at: START - 9 * MIN, label: 'Lord03' } }, START - 9 * MIN);
  const org = orgLike(store());
  assert.equal(GL.due(org, START - 8 * MIN), null);
  const row = GL.eventRow(ORGID, DAY);
  assert.ok(row.relogAt, 'the relog is written down');
});

t('the "before" record is due at the stand-down and only once', () => {
  GL.saveEvent(ORGID, DAY, { beforeAt: 0 });
  const org = orgLike(store());
  assert.equal(GL.due(org, PAUSE + 30000).action, 'before');
  GL.saveEvent(ORGID, DAY, { beforeAt: PAUSE });
  const after = GL.due(org, PAUSE + 30000);
  assert.ok(!after || after.action !== 'before');
});

console.log('\ncoming out the other side\n');

t('the "after" waits while the consoles still hold their old figures', () => {
  GL.saveEvent(ORGID, DAY, { beforeAt: PAUSE, afterAt: 0, endAt: END });
  const org = orgLike(store());
  assert.equal(GL.due(org, END + 2 * MIN), null, 'nothing has reported since the server came back');
});

t('it is due as soon as every console has reported since the server came back', () => {
  publish(BANK.id, END + 3 * MIN, [town(1, 'Lord03 One', 10e9, 700e9, 2e9, 1e9, 5e9), town(2, 'Lord03 Two', 20e9, 800e9, 1e9, 1e9, 4e9)]);
  publish(OURS.id, END + 3 * MIN, [town(1, 'Lord04 One', 50e9, 700e9, 10e9, 10e9, 100e9)]);
  const org = orgLike(store());
  const step = GL.due(org, END + 4 * MIN);
  assert.ok(step, 'a step');
  assert.equal(step.action, 'after');
});

t('a console that never comes back does not hold the record up for ever', () => {
  GL.saveEvent(ORGID, DAY, { afterAt: 0 });
  D.run('DELETE FROM account_latest WHERE accountId = ?', OURS.id);
  publish(BANK.id, END + 3 * MIN, [town(1, 'Lord03 One', 10e9, 700e9, 2e9, 1e9, 5e9)]);
  const org = orgLike(store());
  assert.equal(GL.due(org, END + 5 * MIN), null, 'inside the wait it still waits');
  const late = GL.due(org, END + GL.AFTER_WAIT_MS + MIN);
  assert.equal(late.action, 'after');
  assert.equal(late.waited, true, 'and it says it gave up waiting');
});

t('the "after" record goes in and the day now has both sides', () => {
  publish(BANK.id, END + 3 * MIN, [town(1, 'Lord03 One', 10e9, 700e9, 2e9, 1e9, 5e9), town(2, 'Lord03 Two', 20e9, 800e9, 1e9, 1e9, 4e9)]);
  publish(OURS.id, END + 3 * MIN, [town(1, 'Lord04 One', 50e9, 700e9, 10e9, 10e9, 100e9)]);
  const r = GL.take({ orgId: ORGID, day: DAY, side: 'after', now: END + 4 * MIN });
  assert.equal(r.taken, true);
  assert.equal(r.rows, 3);
  const row = GL.eventRow(ORGID, DAY);
  assert.ok(row.beforeAt && row.afterAt);
});

console.log('\na record taken from the wrong side of the window\n');

t('a late "before" will not file figures a console read after the server went down', () => {
  const day = GL.dayKey(Date.now() - 3 * 86400000);
  const start = GL.atOn(day, 9, 0);
  GL.saveEvent(ORGID, day, { server: 'ss71', startAt: start, pauseAt: start - 5 * MIN, resumeAt: start + 15 * MIN, source: 'announced' });
  // the bank was still reporting from before it; ours has already been through it
  publish(BANK.id, start - 4 * MIN, [town(1, 'Lord03 One', 10e9, 1e9, 2e9, 1e9, 5e9)]);
  publish(OURS.id, start + 40 * MIN, [town(1, 'Lord04 One', 50e9, 700e9, 10e9, 10e9, 100e9)]);
  const r = GL.take({ orgId: ORGID, day, side: 'before', now: start + 45 * MIN, maxSnapAt: start });
  assert.equal(r.rows, 1, 'only the town whose reading really is from before it');
  assert.ok(r.skipped.some((s) => /other side of the maintenance/.test(s)), 'and it says which account was left out');
  const rows = D.all('SELECT label FROM city_resources WHERE orgId = ? AND kind = ?', ORGID, GL.kindOf(day, 'before'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Lord03');
});

t('an "after" will not file figures read before the server came back', () => {
  const day = GL.dayKey(Date.now() - 3 * 86400000);
  const start = GL.atOn(day, 9, 0), end = start + 32 * MIN;
  publish(BANK.id, start - 4 * MIN, [town(1, 'Lord03 One', 10e9, 1e9, 2e9, 1e9, 5e9)]);
  publish(OURS.id, end + 5 * MIN, [town(1, 'Lord04 One', 50e9, 700e9, 10e9, 10e9, 100e9)]);
  const r = GL.take({ orgId: ORGID, day, side: 'after', now: end + 25 * MIN, minSnapAt: end });
  assert.equal(r.rows, 1);
  assert.ok(r.skipped.some((s) => /other side of the maintenance/.test(s)));
});

t('nothing on the right side at all is not a record taken', () => {
  const day = GL.dayKey(Date.now() - 4 * 86400000);
  const start = GL.atOn(day, 9, 0);
  GL.saveEvent(ORGID, day, { server: 'ss71', startAt: start, pauseAt: start - 5 * MIN, resumeAt: start + 15 * MIN, source: 'announced' });
  publish(BANK.id, start + 50 * MIN, [town(1, 'Lord03 One', 10e9, 1e9, 2e9, 1e9, 5e9)]);
  publish(OURS.id, start + 50 * MIN, [town(1, 'Lord04 One', 50e9, 700e9, 10e9, 10e9, 100e9)]);
  const r = GL.take({ orgId: ORGID, day, side: 'before', now: start + 55 * MIN, maxSnapAt: start });
  assert.equal(r.taken, false, 'it stays owed rather than filing the wrong numbers');
  assert.equal(GL.eventRow(ORGID, day).beforeAt, 0);
  assert.equal(D.one('SELECT count(*) c FROM city_resources WHERE orgId = ? AND kind = ?', ORGID, GL.kindOf(day, 'before')).c, 0);
});

t('the step says which cut-off applies', () => {
  const org = orgLike(store());
  GL.saveEvent(ORGID, DAY, { beforeAt: 0, afterAt: 0, relogAt: PAUSE - 3 * MIN });
  assert.equal(GL.due(org, PAUSE + MIN).maxSnapAt, START);
  GL.saveEvent(ORGID, DAY, { beforeAt: PAUSE, endAt: END });
  assert.equal(GL.due(org, END + GL.AFTER_WAIT_MS + MIN).minSnapAt, END);
});

console.log('\nreading it back\n');

t('the day names what each town went in with and came out with', () => {
  const d = GL.detail({ orgId: ORGID, day: DAY });
  assert.equal(d.found, true);
  const one = d.towns.find((x) => x.city === 'Lord03 One');
  assert.equal(one.before.wood, 1e9);
  assert.equal(one.after.wood, 700e9);
  assert.equal(one.delta.wood, 699e9, 'the wood was put back');
  const two = d.towns.find((x) => x.city === 'Lord03 Two');
  assert.equal(two.delta.wood, 0, 'this one was never drained, so nothing moved');
});

t('a town counts as "live" only if its account really was relogged first', () => {
  // the bank was relogged at START-9min and its "before" snapshot taken at PAUSE-1min,
  // which is after that login — so those figures came out of the fresh session
  const d = GL.detail({ orgId: ORGID, day: DAY });
  assert.equal(d.towns.filter((x) => x.live).length, 2, 'the bank\'s two towns');
  assert.equal(d.towns.find((x) => x.city === 'Lord04 One').live, false, 'ours was never relogged');
});

t('a relog that only landed AFTER the record does not make it live', () => {
  // this is the case that matters: a login that came back late is no use to a record
  // already taken, and the page must not claim the server\'s figures for a cache
  GL.markRelog(ORGID, DAY, { [BANK.id]: { ok: true, at: PAUSE + 2 * MIN, label: 'Lord03' } }, PAUSE + 2 * MIN);
  const d = GL.detail({ orgId: ORGID, day: DAY });
  assert.equal(d.towns.every((x) => x.live === false), true);
  // and a relog that failed is never live, whatever its time says
  GL.markRelog(ORGID, DAY, { [BANK.id]: { ok: false, at: PAUSE - 3 * MIN, error: 'timeout', label: 'Lord03' } }, PAUSE - 3 * MIN);
  assert.equal(GL.detail({ orgId: ORGID, day: DAY }).towns.every((x) => x.live === false), true);
  GL.markRelog(ORGID, DAY, { [BANK.id]: { ok: true, at: PAUSE - 3 * MIN, label: 'Lord03' } }, PAUSE - 3 * MIN);
});

t('the totals split by which side of the holiday each account was on', () => {
  const d = GL.detail({ orgId: ORGID, day: DAY });
  assert.equal(d.bySide.hol.wood, 699e9, 'the put-back is the holiday side');
  assert.equal(d.bySide.out.wood, 0);
  assert.equal(d.totals.delta.wood, 699e9);
});

t('the day list filters by date', () => {
  const inRange = GL.days({ orgId: ORGID, from: DAY, to: DAY });
  assert.equal(inRange.days.length, 1);
  assert.equal(inRange.days[0].delta.wood, 699e9);
  const before = GL.days({ orgId: ORGID, from: '2000-01-01', to: '2000-01-02' });
  assert.equal(before.days.length, 0);
  // `first` is the whole log's reach, not the filtered range's — that is what the page
  // needs to say "the log goes back to ..." while you are looking at one week of it
  assert.ok(inRange.first < DAY, 'and says how far back the whole log goes, not the range');
});

t('searching narrows the towns without changing what they say', () => {
  const d = GL.detail({ orgId: ORGID, day: DAY, q: 'lord03 one' });
  assert.equal(d.towns.length, 1);
  assert.equal(d.towns[0].city, 'Lord03 One');
  const byAcc = GL.detail({ orgId: ORGID, day: DAY, accounts: [OURS.id] });
  assert.equal(byAcc.towns.length, 1);
  assert.equal(byAcc.towns[0].label, 'Lord04');
});

console.log('\nthe runs of that day\n');

t('a run is kept after the next one replaces it in the settings', () => {
  const a = { id: 'r1', state: 'running', createdAt: START - 90 * MIN, kind: 'gold', bankSide: 'buy',
    res: 'stone', price: 150, buy: [BANK.id], sell: [OURS.id], banks: [BANK.id], labels: {}, events: [] };
  GL.archiveRun(ORGID, a);
  GL.archiveRun(ORGID, { ...a, state: 'stopped', stoppedAt: START - 40 * MIN });
  const b = { id: 'r2', state: 'running', createdAt: END + 5 * MIN, kind: 'res', bankSide: 'sell',
    res: 'wood', price: 1, buy: [OURS.id], sell: [BANK.id], banks: [BANK.id], labels: {}, events: [] };
  GL.archiveRun(ORGID, b);
  const runs = GL.runsOf(ORGID, DAY);
  assert.equal(runs.length, 2, 'both runs of the day');
  assert.equal(runs[0].id, 'r1');
  assert.equal(runs[0].state, 'stopped', 'the last state is the one that sticks');
  assert.equal(runs[0].price, 150);
  assert.equal(runs[1].res, 'wood');
});

t('the day list carries the runs', () => {
  const out = GL.days({ orgId: ORGID, from: DAY, to: DAY });
  assert.equal(out.days[0].runs.length, 2);
  assert.equal(out.days[0].runs[0].banks, 1);
});

console.log('\nthe window it hangs on\n');

t('an announced window is written down from the fleet\'s own record', () => {
  const st = store();
  const other = '1999-12-31';
  MAINT.declare(st, 'ss71', { startAt: GL.atOn(other, 9, 0), text: 'the chat said so', by: 'a console' }, GL.atOn(other, 8, 50));
  const rec = MAINT.read(st, 'ss71', GL.atOn(other, 8, 50));
  const row = GL.ensureEvent(ORGID, rec, GL.atOn(other, 8, 50));
  assert.equal(row.day, other);
  assert.equal(row.source, 'announced');
  assert.equal(row.startAt, GL.atOn(other, 9, 0));
  assert.equal(row.pauseAt, GL.atOn(other, 8, 55), 'the stand-down is five minutes before it');
});

t('the announcement repeating does not move a start we have already acted on', () => {
  const day = '1999-12-31';
  const st = store();
  MAINT.declare(st, 'ss71', { startAt: GL.atOn(day, 9, 10), text: 'again', by: 'a console' }, GL.atOn(day, 8, 58));
  const again = GL.ensureEvent(ORGID, MAINT.read(st, 'ss71', GL.atOn(day, 8, 58)), GL.atOn(day, 8, 58));
  assert.equal(again.startAt, GL.atOn(day, 9, 0), 'still the first one');
});

t('old records are pruned by day', () => {
  GL.prune(1);
  assert.equal(GL.eventRow(ORGID, '1999-12-31'), null);
  assert.ok(GL.eventRow(ORGID, DAY), 'today stays');
  const left = D.one("SELECT count(*) c FROM city_resources WHERE orgId = ? AND kind LIKE 'maint:%'", ORGID);
  assert.equal(left.c, 6, 'today\'s six rows are still there');
});

console.log('\nthe switches\n');

t('the relog is on by default and can be switched off', () => {
  const org = orgLike(store());
  assert.equal(GL.config(org).relog, true);
  GL.setConfig(org, { relog: false });
  assert.equal(GL.config(org).relog, false);
  GL.saveEvent(ORGID, DAY, { relogAt: 0, beforeAt: 0 });
  assert.equal(GL.due(org, START - 10 * MIN), null, 'switched off, it never asks for one');
  GL.setConfig(org, { relog: true });
});

t('the lead time cannot be set so short the relog runs into the stand-down', () => {
  const org = orgLike(store());
  assert.equal(GL.setConfig(org, { leadMin: 1 }).leadMin, 6, 'floored');
  assert.equal(GL.setConfig(org, { leadMin: 500 }).leadMin, 30, 'capped');
  assert.equal(GL.setConfig(org, { leadMin: 12 }).leadMin, 12);
});

t('switched off, nothing at all is recorded', () => {
  const org = orgLike(store());
  GL.setConfig(org, { on: false });
  GL.saveEvent(ORGID, DAY, { beforeAt: 0, afterAt: 0, relogAt: 0 });
  assert.equal(GL.due(org, PAUSE + MIN), null);
  GL.setConfig(org, { on: true });
});

console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows holds the db file */ }
process.exit(fail ? 1 : 0);
