'use strict';
// The console's events feed for Claude (claude-events.js, and the hooks in
// session.js that feed it). Offline: the game login is a stub, the database a
// temp file; nothing here goes near the live Director or the consoles.
//
//   node test-claude-events.js
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const EventEmitter = require('events');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-claude-events-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMP, 't.db');
delete process.env.ACCOUNT_ID;

const CE = require('./claude-events');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('EventRing: monotonic seq, since, types, and the ring limit', () => {
  const r = new CE.EventRing(5);
  for (let i = 0; i < 8; i++) r.emit(i % 2 ? 'b' : 'a', { i });
  assert.strictEqual(r.seq, 8);
  assert.strictEqual(r.list.length, 5);
  assert.deepStrictEqual(r.since(0).map((e) => e.seq), [4, 5, 6, 7, 8]);
  assert.deepStrictEqual(r.since(6).map((e) => e.seq), [7, 8]);
  assert.deepStrictEqual(r.since(0, CE.typeSet('a')).map((e) => e.i), [4, 6]);
  assert.strictEqual(r.since(0, null, 2).length, 2);
  // a seq from before a restart (higher than ours) reads from the start
  assert.strictEqual(r.since(999).length, 5);
});

test('EventRing.wait: at once when there is news, woken by a matching emit, else times out', async () => {
  const r = new CE.EventRing();
  r.emit('x');
  assert.strictEqual((await r.wait(0, null, 5000)).length, 1);
  const t0 = Date.now();
  setTimeout(() => r.emit('noise'), 20);
  setTimeout(() => r.emit('attack_incoming', { city: 'Alfa' }), 60);
  const got = await r.wait(1, CE.typeSet('attack_incoming'), 5000);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].city, 'Alfa');
  assert.ok(Date.now() - t0 < 2000, 'woke on the event, not the timeout');
  const t1 = Date.now();
  assert.strictEqual((await r.wait(r.seq, null, 80)).length, 0);
  assert.ok(Date.now() - t1 >= 70);
  assert.strictEqual(r.waiters.size, 0, 'no waiter left behind');
});

const castles = [{ id: 11, name: 'Alfa', fieldId: 1000 }, { id: 12, name: 'Bravo', fieldId: 2000 }];
const army = (id, o = {}) => ({ armyId: id, missionType: 5, direction: 1, targetFieldId: 1000, king: 'Raider',
  startPosName: 'Camp', reachTime: 1e13, troop: { a: '5000', c: '0' }, ...o });

test('diffEnemy: new real attacks, junk, scouts; landed and turned back', () => {
  const now = 1e12;
  let r = CE.diffEnemy(new Map(), [
    army(1, { reachTime: now + 60000 }),
    army(2, { troop: { a: '10' }, reachTime: now + 60000 }),
    army(3, { missionType: 3 }),
    army(4, { troop: { a: '?' } }),
    army(5, { targetFieldId: 9999 }),            // a valley, not a city
    army(6, { direction: 2 }),                   // going home
  ], castles, { now });
  const types = r.events.map((e) => `${e.armyId}:${e.type}`);
  assert.deepStrictEqual(types, ['1:attack_incoming', '2:attack_junk', '3:scout_incoming', '4:attack_incoming']);
  assert.strictEqual(r.events[0].city, 'Alfa');
  assert.strictEqual(r.events[0].troops, 5000);
  assert.strictEqual(r.events[0].inSec, 60);
  assert.strictEqual(r.events[3].troops, null, 'unknown size is null, and counts as real');
  // the same list again: nothing new
  const again = CE.diffEnemy(r.next, [army(1, { reachTime: now + 60000 }), army(2, { troop: { a: '10' }, reachTime: now + 60000 }),
    army(3, { missionType: 3 }), army(4, { troop: { a: '?' } })], castles, { now });
  assert.strictEqual(again.events.length, 0);
  // 1 lands, 4 turns back (not due yet), 2 (junk) lands
  const later = CE.diffEnemy(again.next, [army(3, { missionType: 3 })], castles, { now: now + 61000 });
  const t2 = later.events.map((e) => `${e.armyId}:${e.type}`).sort();
  assert.deepStrictEqual(t2, ['1:attack_landed', '2:junk_landed', '4:attack_turned_back']);
});

test('diffEnemy: the junk filter can be the city\'s own line (isReal)', () => {
  const r = CE.diffEnemy(new Map(), [army(1)], castles, { isReal: (s) => s.troops >= 10000 });
  assert.strictEqual(r.events[0].type, 'attack_junk');
});

test('diffSelf: first look is the baseline; started, arrived, returned', () => {
  const now = 1e12;
  const mine = (id, o = {}) => ({ armyId: id, missionType: 1, direction: 1, startPosName: 'Alfa', targetPosName: 'Bravo', reachTime: now + 5000, troop: { t: '100' }, ...o });
  let r = CE.diffSelf(null, [mine(1)], { now });
  assert.strictEqual(r.events.length, 0);
  r = CE.diffSelf(r.next, [mine(1), mine(2)], { now });
  assert.deepStrictEqual(r.events.map((e) => `${e.armyId}:${e.type}`), ['2:march_started']);
  r = CE.diffSelf(r.next, [mine(1, { direction: 2 }), mine(2)], { now });
  assert.deepStrictEqual(r.events.map((e) => `${e.armyId}:${e.type}`), ['1:march_arrived']);
  r = CE.diffSelf(r.next, [mine(2)], { now: now + 10000 });
  assert.deepStrictEqual(r.events.map((e) => `${e.armyId}:${e.type}`), ['1:march_returned']);
});

// ---- the hooks in session.js, with the login stubbed --------------------------
const D = require('./db');
const AUTH = require('./auth');
const op = AUTH.register({ email: 'op@example.com', password: 'correct horse battery', orgName: 'Events Org' });
const ORG = D.org(op.org.id);
const ACC = ORG.accounts.upsert({ label: 'Alfa', server: 'ss0', email: 'a@example.com', password: 'x' });

const { Game } = require('./game');
Game.prototype.connect = async function () {
  this.c = new EventEmitter();
  this.c.sock = { destroyed: false };
  this.c.lastFrameAt = Date.now();
  this.c.close = () => { if (!this.c.sock.destroyed) { this.c.sock.destroyed = true; this.c.emit('log', 'socket closed'); } };
  this.player = { playerInfo: { userName: 'alfa' }, enemyArmys: [army(77, { reachTime: Date.now() + 90000 })], selfArmys: [] };
  this.castles = [{ id: 11, name: 'Alfa', fieldId: 1000, resource: {} }];
};
Game.prototype.castleId = function (c) { return c.id; };

test('Session: connected at login, an attack already on its way announced, pushes diffed, a drop reported', async () => {
  const { Session } = require('./session');
  const s = new Session(ACC.id);
  const g = await s.connect();
  const types = () => s.eventFeed().since(0).map((e) => e.type);
  assert.deepStrictEqual(types().slice(0, 2), ['connected', 'attack_incoming']);
  assert.strictEqual(s.eventFeed().since(0)[1].account, ACC.id);
  // a push with a second attack and a scout
  g.c.emit('cmd', 'server.EnemyArmysUpdate', { armys: [army(77, { reachTime: Date.now() + 90000 }), army(78), army(79, { missionType: 3 })] });
  assert.deepStrictEqual(types().slice(2), ['attack_incoming', 'scout_incoming']);
  // our own march goes out, then home
  g.c.emit('cmd', 'server.SelfArmysUpdate', { armys: [{ armyId: 5, missionType: 2, direction: 1, reachTime: Date.now() + 60000 }] });
  g.c.emit('cmd', 'server.SelfArmysUpdate', { armys: [] });
  assert.deepStrictEqual(types().slice(4), ['march_started', 'march_gone']);
  // the gate through the engine's route (game.emitEvent, installed at login)
  g.emitEvent('gate_changed', { city: 'Alfa', open: false, by: 'engine' });
  assert.strictEqual(types().pop(), 'gate_changed');
  // a close by the server
  s.kickHoldMin = () => 0;           // not what this test is about: no hold
  g.c.close();
  assert.strictEqual(types().pop(), 'disconnected');
  const last = s.eventFeed().since(0).pop();
  assert.ok(['us', 'server', 'error'].includes(last.by));
  s.stopSupervisor && s.stopSupervisor();
});

test('Session: a relog does not announce the same attack twice', async () => {
  const { Session } = require('./session');
  const s = new Session(ACC.id);
  await s.connect();
  const n1 = s.eventFeed().since(0).filter((e) => e.type === 'attack_incoming').length;
  s.game.c.sock.destroyed = true;           // dropped, quietly
  s.game = null;
  await s.connect();
  const n2 = s.eventFeed().since(0).filter((e) => e.type === 'attack_incoming').length;
  assert.strictEqual(n1, 1);
  assert.strictEqual(n2, 1);
  assert.strictEqual(s.eventFeed().since(0).filter((e) => e.type === 'connected').length, 2);
});

test('Session.emitEvent never throws', () => {
  const { Session } = require('./session');
  const s = new Session(ACC.id);
  s._events = { emit: () => { throw new Error('boom'); } };
  assert.strictEqual(s.emitEvent('x'), null);
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
