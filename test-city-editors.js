'use strict';
// Every city's goals and scripts are its own.
//
// Goals used to be looked up through a fallback chain (city id -> city name ->
// the account's default -> the shared default), so a city with no goals of its
// own showed and ran the default, and a city saved empty went back to running
// it. Script loadouts were ten slots per ACCOUNT, so Load 1 in one city was
// Load 1 in all of them. These tests hold the per-city behaviour in place.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-editors-')), 't.db');
const D = require('./db');
const { Engine } = require('./engine');

let pass = 0, fail = 0;
const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);

const A = D.orgs.create('Acme Raiders');
const B = D.orgs.create('Rival Guild');
const a = D.org(A.id);
const b = D.org(B.id);
const acc = a.accounts.upsert({ label: 'AcmeMain', email: 'acme@x.com', password: 'x' });
const alt = a.accounts.upsert({ label: 'AcmeAlt', email: 'alt@x.com', password: 'x' });
const rival = b.accounts.upsert({ label: 'RivalMain', email: 'rival@x.com', password: 'x' });

const src = (row) => (row ? row.src : null);
const saveLoad = (acct, city, slot, text) => a.goals.set(acct, `${city}:load${slot}`, 'script', text.trim() ? text : '');
const slots = (acct, city) => Object.fromEntries(a.goals.loadouts(acct, city).map((s) => [s.slot, s.src]));

section('goals: a city runs its own goals and no other city\'s');

t('a city with none of its own starts from a copy of the account default', () => {
  a.goals.set(acc.id, 'default', 'goal', 'troop a:1k');
  assert.strictEqual(src(a.goals.own(acc.id, 101, 'North')), 'troop a:1k');
});

t('once copied, a change to the default no longer reaches it', () => {
  a.goals.set(acc.id, 'default', 'goal', 'troop a:2k');
  assert.strictEqual(src(a.goals.own(acc.id, 101, 'North')), 'troop a:1k');
});

t('saving one city leaves another alone', () => {
  assert.strictEqual(src(a.goals.own(acc.id, 102, 'South')), 'troop a:2k');
  a.goals.set(acc.id, '101', 'goal', 'troop w:500');
  assert.strictEqual(src(a.goals.own(acc.id, 101, 'North')), 'troop w:500');
  assert.strictEqual(src(a.goals.own(acc.id, 102, 'South')), 'troop a:2k');
});

t('a city saved empty has no goals — it does not fall back to the default', () => {
  a.goals.set(acc.id, '102', 'goal', '');
  assert.strictEqual(a.goals.own(acc.id, 102, 'South'), null);
  assert.strictEqual(a.goals.own(acc.id, 102, 'South'), null, 'the default came back on the second read');
});

t('goals an old install kept under the city\'s name become that city\'s own', () => {
  a.goals.set(acc.id, 'East', 'goal', 'troop p:300');
  assert.strictEqual(src(a.goals.own(acc.id, 103, 'East')), 'troop p:300');
  a.goals.set(acc.id, 'East', 'goal', 'troop p:999');
  assert.strictEqual(src(a.goals.own(acc.id, 103, 'East')), 'troop p:300', 'still reading through the name');
});

t('with no default and nothing of its own, a city has no goals and no row is written', () => {
  assert.strictEqual(a.goals.own(alt.id, 201, 'Lone'), null);
  a.goals.set(alt.id, 'default', 'goal', 'troop s:10');
  assert.strictEqual(src(a.goals.own(alt.id, 201, 'Lone')), 'troop s:10', 'a later default should still seed it');
});

t('no city id: nothing, and nothing written', () => {
  assert.strictEqual(a.goals.own(acc.id, null, 'North'), null);
  assert.strictEqual(a.goals.own(acc.id, '', 'North'), null);
  assert.ok(!a.goals.list('goal').some((r) => r.cityKey === 'null' || r.cityKey === ''));
});

t('another organization\'s account does not resolve', () => {
  b.goals.set(rival.id, 'default', 'goal', 'troop c:1');
  assert.strictEqual(a.goals.own(rival.id, 301, 'Theirs'), null);
  assert.strictEqual(src(b.goals.own(rival.id, 301, 'Theirs')), 'troop c:1');
});

t('the engine plans each city from that city\'s goals', () => {
  const castles = [{ id: 101, name: 'North' }, { id: 102, name: 'South' }, { id: 104, name: 'West' }];
  const game = { castles, castleId: (c) => c.id };
  const e = new Engine(game, () => {}, acc.id);
  const troops = (c) => { const p = e.goalsFor(c.id, c.name); return p ? p.goals.map((g) => g.raw) : null; };
  assert.deepStrictEqual(troops(castles[0]), ['troop w:500']);
  assert.strictEqual(troops(castles[1]), null, 'South was saved empty');
  assert.deepStrictEqual(troops(castles[2]), ['troop a:2k'], 'a city seen for the first time starts from the default');
});

section('script loadouts: every city has its own ten');

t('a city\'s first look copies the account-wide slots the console used to share', () => {
  a.goals.set(acc.id, 'load1', 'script', 'buy food 1000 @0.5');
  a.goals.set(acc.id, 'load3', 'script', '// farm\ntrain a 10');
  assert.deepStrictEqual(slots(acc.id, 101), { 1: 'buy food 1000 @0.5', 3: '// farm\ntrain a 10' });
  assert.deepStrictEqual(slots(acc.id, 102), { 1: 'buy food 1000 @0.5', 3: '// farm\ntrain a 10' });
});

t('saving Load 1 in one city leaves the other city\'s Load 1 alone', () => {
  saveLoad(acc.id, 101, 1, 'sell wood 5 @9');
  assert.strictEqual(slots(acc.id, 101)[1], 'sell wood 5 @9');
  assert.strictEqual(slots(acc.id, 102)[1], 'buy food 1000 @0.5');
});

t('an emptied slot stays empty; the old shared copy does not come back', () => {
  saveLoad(acc.id, 102, 1, '   ');
  saveLoad(acc.id, 102, 3, '');
  assert.deepStrictEqual(slots(acc.id, 102), {});
  assert.deepStrictEqual(slots(acc.id, 102), {}, 'the account-wide slots were copied in again');
});

t('the old account-wide slots are no longer written, and a city opened later still gets them', () => {
  assert.strictEqual(a.goals.list('script').find((r) => r.accountId === acc.id && r.cityKey === 'load1').src, 'buy food 1000 @0.5');
  assert.deepStrictEqual(slots(acc.id, 105), { 1: 'buy food 1000 @0.5', 3: '// farm\ntrain a 10' });
});

t('city ids that share a prefix do not share slots', () => {
  saveLoad(acc.id, 12, 2, 'echo twelve');
  saveLoad(acc.id, 123, 2, 'echo one-two-three');
  assert.strictEqual(slots(acc.id, 12)[2], 'echo twelve');
  assert.strictEqual(slots(acc.id, 123)[2], 'echo one-two-three');
});

t('another account\'s slots never seed this account\'s city', () => {
  a.goals.set(alt.id, 'load7', 'script', 'echo alt');
  assert.ok(!(7 in slots(acc.id, 106)));
  assert.deepStrictEqual(slots(alt.id, 206), { 7: 'echo alt' });
});

t('another organization\'s account gets nothing', () => {
  b.goals.set(rival.id, 'load1', 'script', 'echo rival');
  assert.deepStrictEqual(a.goals.loadouts(rival.id, 301), []);
  assert.deepStrictEqual(b.goals.loadouts(rival.id, 301).map((s) => s.src), ['echo rival']);
});

// ---------------------------------------------------------------------------

for (const [n, f] of tests) {
  if (!f) { console.log('\n' + n + '\n'); continue; }
  try { f(); console.log('  ok    ' + n); pass++; }
  catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
