'use strict';
// The abandon guard. city.giveupCastle is irreversible and takes the account
// password, so every one of these is a test that a REAL city stays safe.
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

// throwaway database — never touch the live registry from a test
const TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evony-bnpc-')), 'test.db');
process.env.EVONY_DB = TMP;

const D = require('./db');
const B = require('./goal-buildnpc');
const { canAbandon, cityTotals, pickFlat, DEF } = B._internals;

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
};
const section = (s) => console.log('\n' + s + '\n');

const ACC = 'a1';
const HOME_FIELD = 100 * 800 + 100;
const BUILT_FIELD = 105 * 800 + 105;

function city(fieldId, over = {}) {
  return {
    id: fieldId, fieldId, name: 'C' + fieldId,
    resource: { food: { amount: 0 }, wood: { amount: 0 }, stone: { amount: 0 }, iron: { amount: 0 }, gold: 0 },
    troop: {}, heros: [], fortification: {},
    ...over,
  };
}

function gameWith(cities) {
  return {
    castles: cities,
    castleId: (c) => c.id,
    castleXY: (c) => ({ x: Math.floor(c.fieldId / 800), y: c.fieldId % 800 }),
    player: { selfArmys: [] },
  };
}

// a home city plus a freshly built buildnpc city, wired into the registry
function freshSetup({ builtAgeMs = 30 * 60000 } = {}) {
  D.run('DELETE FROM city_registry');
  D.accounts.upsert({ id: ACC, label: 'T', email: 't@t', password: 'pw' });
  const home = city(HOME_FIELD);
  const extra = city(HOME_FIELD + 1);
  const built = city(BUILT_FIELD);
  const g = gameWith([home, extra, built]);
  D.registry.reconcile(ACC, [
    { fieldId: HOME_FIELD, castleId: home.id, name: home.name },
    { fieldId: HOME_FIELD + 1, castleId: extra.id, name: extra.name },
  ]);
  D.registry.claimFlat(ACC, BUILT_FIELD, { x: 105, y: 105 });
  D.registry.markBuilt(ACC, BUILT_FIELD, built.id, built.name);
  D.run('UPDATE city_registry SET builtAt = ? WHERE accountId = ? AND fieldId = ?',
    Date.now() - builtAgeMs, ACC, BUILT_FIELD);
  return { g, home, extra, built };
}

const verdict = (g, castle, over = {}) =>
  canAbandon({ accountId: ACC, game: g, castle, policy: DEF, ...over });

// ===========================================================================
section('the happy path is the ONLY path');

t('a registered, empty, in-window buildnpc city may be abandoned', () => {
  const { g, built } = freshSetup();
  const v = verdict(g, built);
  assert.ok(v.ok, 'should have been allowed: ' + v.why);
});

// ===========================================================================
section('real cities are never abandonable');

t('the home city is refused', () => {
  const { g, home } = freshSetup();
  assert.ok(!verdict(g, home).ok);
});

t('a pre-existing city is refused even when completely empty', () => {
  const { g, extra } = freshSetup();
  const v = verdict(g, extra);
  assert.ok(!v.ok);
  assert.match(v.why, /origin "pre-existing"/);
});

t('a city that simply APPEARED (a capture) is refused', () => {
  const { g } = freshSetup();
  const captured = city(300 * 800 + 300);
  g.castles.push(captured);
  D.registry.reconcile(ACC, g.castles.map((c) => ({ fieldId: c.fieldId, castleId: c.id, name: c.name })));
  const row = D.registry.get(ACC, captured.fieldId);
  assert.strictEqual(row.origin, 'appeared');
  assert.strictEqual(row.abandonable, false);
  const v = verdict(g, captured);
  assert.ok(!v.ok);
  assert.match(v.why, /origin "appeared"/);
});

t('an unrecorded city is refused outright', () => {
  const { g } = freshSetup();
  const ghost = city(400 * 800 + 400);
  g.castles.push(ghost);
  const v = verdict(g, ghost);
  assert.ok(!v.ok);
  assert.match(v.why, /no registry entry/);
});

t('reconcile can never flip a protected city to abandonable', () => {
  const { g, extra } = freshSetup();
  for (let i = 0; i < 5; i++) {
    D.registry.reconcile(ACC, g.castles.map((c) => ({ fieldId: c.fieldId, castleId: c.id, name: c.name })));
  }
  assert.strictEqual(D.registry.get(ACC, extra.fieldId).abandonable, false);
});

t('claimFlat refuses to re-label a city that already exists', () => {
  const { g, extra } = freshSetup();
  D.registry.claimFlat(ACC, extra.fieldId, { x: 1, y: 1 });
  const row = D.registry.get(ACC, extra.fieldId);
  assert.strictEqual(row.origin, 'pre-existing', 'origin was overwritten');
  assert.strictEqual(row.abandonable, false);
  assert.ok(!verdict(g, extra).ok);
});

t('markBuilt refuses a field that was never claimed', () => {
  const { extra } = freshSetup();
  assert.strictEqual(D.registry.markBuilt(ACC, extra.fieldId, extra.id, 'x'), null);
  assert.strictEqual(D.registry.get(ACC, extra.fieldId).abandonable, false);
});

// ===========================================================================
section('the contents checks');

t('resources over 5m block it', () => {
  const { g, built } = freshSetup();
  built.resource.food.amount = 5e6 + 1;
  const v = verdict(g, built);
  assert.ok(!v.ok);
  assert.match(v.why, /resources inside/);
});

t('exactly 5m is still allowed', () => {
  const { g, built } = freshSetup();
  built.resource.food.amount = 5e6;
  assert.ok(verdict(g, built).ok);
});

t('resources are summed across every type, not checked one by one', () => {
  const { g, built } = freshSetup();
  built.resource.food.amount = 2e6;
  built.resource.wood.amount = 2e6;
  built.resource.iron.amount = 2e6;      // 6m total, none over 5m alone
  assert.ok(!verdict(g, built).ok);
});

t('a single hero blocks it', () => {
  const { g, built } = freshSetup();
  built.heros = [{ id: 1, name: 'H' }];
  const v = verdict(g, built);
  assert.ok(!v.ok);
  assert.match(v.why, /hero/);
});

t('more than 250 troops blocks it', () => {
  const { g, built } = freshSetup();
  built.troop = { archer: 251 };
  const v = verdict(g, built);
  assert.ok(!v.ok);
  assert.match(v.why, /troops inside/);
});

t('250 troops exactly is allowed', () => {
  const { g, built } = freshSetup();
  built.troop = { archer: 200, scouter: 50 };
  assert.ok(verdict(g, built).ok);
});

t('troops are summed across types', () => {
  const { g, built } = freshSetup();
  built.troop = { archer: 200, scouter: 200 };
  assert.ok(!verdict(g, built).ok);
});

// ===========================================================================
section('age window');

t('too young is refused', () => {
  const { g, built } = freshSetup({ builtAgeMs: 60000 });
  const v = verdict(g, built);
  assert.ok(!v.ok);
  assert.match(v.why, /waiting for/);
});

t('too old is refused — an old city is suspicious, not stale', () => {
  const { g, built } = freshSetup({ builtAgeMs: 48 * 3600000 });
  const v = verdict(g, built);
  assert.ok(!v.ok);
  assert.match(v.why, /past the/);
});

// ===========================================================================
section('never strand the account');

t('keepCities is honoured', () => {
  const { g, built } = freshSetup();
  const v = canAbandon({ accountId: ACC, game: g, castle: built, policy: { ...DEF, keepCities: 3 } });
  assert.ok(!v.ok);
  assert.match(v.why, /keeping at least/);
});

t('the daily cap is honoured', () => {
  const { g, built } = freshSetup();
  const v = verdict(g, built, { abandonedToday: DEF.perDay });
  assert.ok(!v.ok);
  assert.match(v.why, /already abandoned/);
});

t('a missing account id disqualifies everything', () => {
  const { g, built } = freshSetup();
  const v = canAbandon({ accountId: null, game: g, castle: built, policy: DEF });
  assert.ok(!v.ok);
  assert.match(v.why, /no account id/);
});

t('a castle id that no longer matches the registry is refused', () => {
  const { g, built } = freshSetup();
  D.run('UPDATE city_registry SET castleId = 999999 WHERE accountId = ? AND fieldId = ?', ACC, BUILT_FIELD);
  const v = verdict(g, built);
  assert.ok(!v.ok);
  assert.match(v.why, /refusing on identity/);
});

t('a city with no map position is refused', () => {
  const { g, built } = freshSetup();
  delete built.fieldId;
  assert.ok(!verdict(g, built).ok);
});

t('once abandoned it can never be abandoned again', () => {
  const { g, built } = freshSetup();
  D.registry.markAbandoned(ACC, BUILT_FIELD);
  const v = verdict(g, built);
  assert.ok(!v.ok);
  assert.match(v.why, /not abandonable|state is "abandoned"/);
});

// ===========================================================================
section('teleports — castleId is the identity, fieldId is not');

t('a protected city that teleports stays protected at its new tile', () => {
  const { g, extra } = freshSetup();
  const NEW = 700 * 800 + 700;
  extra.fieldId = NEW;
  D.registry.reconcile(ACC, g.castles.map((c) => ({ fieldId: c.fieldId, castleId: c.id, name: c.name })));
  const row = D.registry.get(ACC, NEW);
  assert.ok(row, 'the row did not follow the city');
  assert.strictEqual(row.origin, 'pre-existing');
  assert.strictEqual(row.abandonable, false);
  assert.ok(!verdict(g, extra).ok);
});

t('a teleport does not leave a duplicate row behind', () => {
  const { g, extra } = freshSetup();
  const OLD = extra.fieldId;
  extra.fieldId = 700 * 800 + 700;
  D.registry.reconcile(ACC, g.castles.map((c) => ({ fieldId: c.fieldId, castleId: c.id, name: c.name })));
  assert.strictEqual(D.registry.get(ACC, OLD), null, 'the old tile still has a row');
  assert.strictEqual(D.registry.all(ACC).filter((r) => Number(r.castleId) === extra.id).length, 1);
});

t('THE DANGEROUS ONE: a real city teleporting onto a claimed flat is NOT promoted', () => {
  const { g, extra } = freshSetup();
  const FLAT = 200 * 800 + 200;
  D.registry.claimFlat(ACC, FLAT, { x: 200, y: 200 });        // we intend to build here
  extra.fieldId = FLAT;                                        // ...a real city lands on it
  D.registry.reconcile(ACC, g.castles.map((c) => ({ fieldId: c.fieldId, castleId: c.id, name: c.name })));
  const row = D.registry.get(ACC, FLAT);
  assert.strictEqual(Number(row.castleId), extra.id, 'the row should belong to the real city');
  assert.strictEqual(row.abandonable, false, 'a REAL CITY was marked abandonable');
  assert.notStrictEqual(row.state, 'built');
  const v = verdict(g, extra);
  assert.ok(!v.ok, 'a real city that teleported onto a claimed flat could be abandoned: ' + v.why);
});

t('markBuilt refuses a castleId that is already known elsewhere', () => {
  const { extra } = freshSetup();
  const FLAT = 210 * 800 + 210;
  D.registry.claimFlat(ACC, FLAT, { x: 210, y: 210 });
  assert.strictEqual(D.registry.markBuilt(ACC, FLAT, extra.id, 'sneaky'), null);
  assert.strictEqual(D.registry.get(ACC, FLAT).abandonable, false);
});

t('a buildnpc city that teleports loses its claim', () => {
  const { g, built } = freshSetup();
  assert.ok(verdict(g, built).ok, 'precondition: it was abandonable');
  built.fieldId = 800 * 800 + 1;
  D.registry.reconcile(ACC, g.castles.map((c) => ({ fieldId: c.fieldId, castleId: c.id, name: c.name })));
  const v = verdict(g, built);
  assert.ok(!v.ok, 'a teleported buildnpc city should stop being abandonable');
});

t('a flat we abandoned can be claimed again', () => {
  freshSetup();
  D.registry.markAbandoned(ACC, BUILT_FIELD);
  const r = D.registry.claimFlat(ACC, BUILT_FIELD, { x: 105, y: 105 });
  assert.strictEqual(r.state, 'pending-build');
  assert.strictEqual(r.abandonable, false);
  assert.strictEqual(r.castleId, null, 'the old castle id must be cleared');
});

// ===========================================================================
section('flat picking');

t('a flat already in the registry is never picked twice', () => {
  freshSetup();
  D.mapCache.upsertMany([
    { id: BUILT_FIELD, x: 105, y: 105, kind: 'flat', type: 10, seen: Date.now() },
    { id: 102 * 800 + 102, x: 102, y: 102, kind: 'flat', type: 10, seen: Date.now() },
  ]);
  const picked = pickFlat(ACC, { x: 100, y: 100 }, 20, null);
  assert.ok(picked, 'nothing picked at all');
  assert.notStrictEqual(Number(picked.id), BUILT_FIELD, 'picked a flat it already owns');
});

t('an occupied tile is never picked', () => {
  freshSetup();
  D.run('DELETE FROM map_cache');
  D.mapCache.upsertMany([
    { id: 101 * 800 + 101, x: 101, y: 101, kind: 'flat', type: 10, userName: 'SomeoneElse', seen: Date.now() },
  ]);
  assert.strictEqual(pickFlat(ACC, { x: 100, y: 100 }, 20, null), null);
});

// ===========================================================================
console.log(`\n${pass} passed, ${fail} failed\n`);
try { fs.rmSync(path.dirname(TMP), { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
