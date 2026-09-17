'use strict';
// New cities and the account-wide goals (NEAT's !NewCityGoals.txt,
// !NewCityScript.txt, !PrependGoals.txt and !AppendGoals.txt; wiki NewCityGoals,
// NewCityScript, GlobalGoals, PrependGoals, AppendGoals).
//
//   * a city that appears (server.CastleUpdate add) with no goals of its own
//     gets the account's new-city template at once, logged; one that has goals
//     keeps them
//   * the city registry learns of it at once, so buildnpc sees it mid-session
//   * the account's new-city script runs once in it, through the console
//   * every city runs the account's prepend goals, then its own, then the
//     append goals; a later layer wins for config keys and singletons, and a
//     parse error says which text it is in ("append line 3: …")
//   * engine state and reports are keyed by castle id, and state saved under a
//     city NAME is moved over once
// Offline: a temp database, a fake game, no socket.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const EventEmitter = require('events');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-newcity-')), 't.db');

const D = require('./db');
const C = require('./constants');
const G = require('./goallayers');
const { parseGoals, describe } = require('./goals');
const { Engine } = require('./engine');
const { Session } = require('./session');

let pass = 0, fail = 0;
const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ORG = D.orgs.create('Acme Raiders');
const RIVAL = D.orgs.create('Rival Guild');
const a = D.org(ORG.id);
const b = D.org(RIVAL.id);
const acct = (label) => a.accounts.upsert({ label, email: `${label.toLowerCase()}@x.com`, password: 'x' });
const rival = b.accounts.upsert({ label: 'RivalMain', email: 'rival@x.com', password: 'x' });

// A castle as CastleBean has it (castleId via `id`), and a game with a socket to
// push server events through. castleId() is the real Game.castleId rule.
const castle = (id, name, x, y, over = {}) => ({
  id, name, fieldId: C.coordsToFieldId(x, y),
  resource: { food: { amount: 1e6 }, wood: { amount: 1e6 }, stone: { amount: 1e6 }, iron: { amount: 1e6 }, gold: 1e6,
    curPopulation: 100, maxPopulation: 1000 },
  buildings: [], heros: [], troop: {}, fortification: {}, ...over,
});
function fakeGame(castles) {
  return {
    c: new EventEmitter(), castles,
    player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [] },
    castleId: (c) => c.castleId ?? c.id,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    castle: () => castles[0],
    now: () => Date.now(),
    req: async () => ({ ok: 1 }),
  };
}

// A console session on a fresh account, wired to a fake game that already
// holds `home`, as it would after a login.
function world(label, { runner } = {}) {
  const account = acct(label);
  const s = new Session(account.id);
  const lines = [];
  s.note = (m, meta) => lines.push({ m: String(m), ...(typeof meta === 'string' ? { city: meta } : (meta || {})) });
  if (runner) s.runNewCityScript = runner;
  const home = castle(100, 'Home', 300, 300);
  const g = fakeGame([home]);
  s.wire(g);
  s.game = g;
  s.reconcileRegistry(g);        // the login's reconcile
  const add = (bean) => g.c.emit('cmd', 'server.CastleUpdate', { updateType: 0, castleBean: bean });
  const said = (re) => lines.filter((l) => re.test(l.m));
  return { s, g, id: account.id, lines, said, add, home };
}

// ---------------------------------------------------------------------------
section('the new-city template, applied the moment a city appears');

t('a new city with no goals of its own gets the template at once, and the log names it and counts the lines', () => {
  const w = world('Alpha');
  a.goals.set(w.id, 'default', 'goal', '// my template\nconfig comfort:1\ntroop a:1k\n\nfortification ab:10');
  w.add(castle(501, 'Newtown', 310, 300));
  assert.strictEqual(a.goals.exact(w.id, '501', 'goal').src, '// my template\nconfig comfort:1\ntroop a:1k\n\nfortification ab:10');
  const l = w.said(/goals set from/)[0];
  assert.ok(l, 'no log line for the seeding');
  assert.strictEqual(l.m, 'new city Newtown: goals set from the new-city template, 3 goal line(s) applied');
  assert.strictEqual(l.city, 'Newtown');
  assert.strictEqual(l.kind, 'act');
  assert.ok(w.said(/^new city: Newtown \(310,300\) has joined the account$/).length, 'no line saying the city appeared');
});

t('the copy is the template as it stands when the city appears, not when the engine first reads it', () => {
  const w = world('Bravo');
  a.goals.set(w.id, 'default', 'goal', 'troop s:5');
  w.add(castle(511, 'Early', 320, 300));
  a.goals.set(w.id, 'default', 'goal', 'troop s:999');
  const e = new Engine(w.g, () => {}, w.id);
  assert.deepStrictEqual(e.goalsFor(511, 'Early').goals.map((x) => x.raw), ['troop s:5']);
});

t('a city that already has goals of its own is not overwritten', () => {
  const w = world('Charlie');
  a.goals.set(w.id, 'default', 'goal', 'troop a:1');
  a.goals.set(w.id, '521', 'goal', 'troop w:500');
  w.add(castle(521, 'Recaptured', 330, 300));
  assert.strictEqual(a.goals.exact(w.id, '521', 'goal').src, 'troop w:500');
  assert.ok(w.said(/new city Recaptured: it already has goals of its own, so the new-city template was not applied/).length);
  assert.strictEqual(w.said(/goals set from/).length, 0);
});

t('a city saved EMPTY keeps its empty goals too', () => {
  const w = world('Delta');
  a.goals.set(w.id, 'default', 'goal', 'troop a:1');
  a.goals.set(w.id, '522', 'goal', '');
  w.add(castle(522, 'Quiet', 331, 300));
  assert.strictEqual(a.goals.exact(w.id, '522', 'goal').src, '');
  assert.strictEqual(w.said(/goals set from/).length, 0);
});

t('a city the account already holds (the login list, a repeated push) is not a new city', () => {
  const w = world('Echo');
  a.goals.set(w.id, 'default', 'goal', 'troop a:1');
  w.add({ ...w.home });
  assert.strictEqual(w.said(/new city/).length, 0);
  assert.strictEqual(a.goals.exact(w.id, '100', 'goal'), null, 'the template was written into a city that was already there');
  assert.strictEqual(w.g.castles.length, 1);
});

t('no template: the log says so and the city starts with no goals, so the engine leaves it alone', async () => {
  const w = world('Foxtrot');
  w.add(castle(531, 'Bare', 340, 300));
  assert.ok(w.said(/new city Bare: this account has no new-city template, so it starts with no goals of its own; with no global goals either, the engine leaves it alone/).length);
  assert.strictEqual(a.goals.exact(w.id, '531', 'goal'), null);
  const e = new Engine(w.g, () => {}, w.id);
  const r = await e.focus(w.g.castles[1]);
  assert.strictEqual(r.note, 'no goals set');
});

t('with global goals the new city\'s log line says they run there too', () => {
  const w = world('Golf');
  a.goals.set(w.id, 'default', 'goal', 'troop a:1');
  a.goals.set(w.id, 'prepend', 'goal', 'config comfort:1\n// note\ncomfortpolicy 15 16 popraise');
  a.goals.set(w.id, 'append', 'goal', 'fortification ab:5');
  w.add(castle(541, 'Layered', 350, 300));
  assert.ok(w.said(/goals set from the new-city template, 1 goal line\(s\) applied; the global goals run there too \(2 prepend line\(s\), 1 append line\(s\)\)/).length);
});

t('a city called "prepend" is not seeded from the prepend goals', () => {
  const w = world('Hotel');
  a.goals.set(w.id, 'prepend', 'goal', 'troop b:1');
  w.add(castle(551, 'prepend', 360, 300));
  assert.strictEqual(a.goals.exact(w.id, '551', 'goal'), null);
});

t('an empty template means no template, even with an install-wide default behind it', () => {
  const w = world('India');
  D.goals.set('', 'default', 'goal', 'troop s:77');        // the old shared default
  try {
    a.goals.set(w.id, 'default', 'goal', '');
    w.add(castle(561, 'NoTpl', 370, 300));
    assert.strictEqual(a.goals.exact(w.id, '561', 'goal'), null);
    assert.ok(w.said(/has no new-city template/).length);
  } finally { D.goals.remove('', 'default', 'goal'); }
});

t('an account with no template row still takes the install-wide default, and the log says which', () => {
  const w = world('Juliet');
  D.goals.set('', 'default', 'goal', 'troop s:77');
  try {
    w.add(castle(562, 'Shared', 371, 300));
    assert.strictEqual(a.goals.exact(w.id, '562', 'goal').src, 'troop s:77');
    assert.ok(w.said(/new city Shared: goals set from the install-wide default goals, 1 goal line\(s\) applied/).length);
  } finally { D.goals.remove('', 'default', 'goal'); }
});

t('the engine still seeds lazily, on its first read, a city that appeared while the console was away', () => {
  const k = acct('Kilo');
  a.goals.set(k.id, 'default', 'goal', 'troop p:3');
  const g = fakeGame([castle(571, 'Offline', 380, 300)]);
  const e = new Engine(g, () => {}, k.id);
  assert.deepStrictEqual(e.goalsFor(571, 'Offline').goals.map((x) => x.raw), ['troop p:3']);
  assert.strictEqual(a.goals.exact(k.id, '571', 'goal').src, 'troop p:3');
});

// ---------------------------------------------------------------------------
section('the city registry learns of a new city at once');

t('a captured or founded city is recorded (protected) the moment it appears, not at the next login', () => {
  const w = world('Lima');
  w.add(castle(601, 'Taken', 400, 300));
  const r = a.registry.byCastleId(w.id, 601);
  assert.ok(r, 'the registry did not record the new city');
  assert.strictEqual(r.origin, 'appeared');
  assert.strictEqual(r.state, 'protected');
  assert.strictEqual(r.abandonable, false);
  assert.ok(w.said(/city registry: Taken recorded as appeared and PROTECTED/).length);
});

t('a flat buildnpc claimed is promoted as its city appears, and that city is left bare', async () => {
  const calls = [];
  const w = world('Mike', { runner: async (...x) => { calls.push(x); return { ok: true, actions: 0 }; } });
  a.goals.set(w.id, 'default', 'goal', 'troop a:1k');
  a.goals.set(w.id, 'newcity', 'script', 'echo hello');
  const bean = castle(611, 'Throwaway', 410, 300);
  a.registry.claimFlat(w.id, bean.fieldId, { x: 410, y: 300 }, 'buildnpc: occupying');
  Session.NEW_CITY_SCRIPT_DELAY_MS = 0;
  w.add(bean);
  await sleep(20);
  const r = a.registry.byCastleId(w.id, 611);
  assert.strictEqual(r.state, 'built');
  assert.strictEqual(r.abandonable, true);
  assert.strictEqual(a.goals.exact(w.id, '611', 'goal').src, '', 'the throwaway was not given an empty goal row');
  assert.strictEqual(calls.length, 0, 'the new-city script ran in a city buildnpc is about to hand back');
  assert.ok(w.said(/Throwaway was built by buildnpc to be handed back as an NPC: it gets no new-city template and no new-city script/).length);
  // and the engine's first read does not copy the template in after all
  const e = new Engine(w.g, () => {}, w.id);
  assert.strictEqual(e.goalsFor(611, 'Throwaway'), null);
});

t('a buildnpc city found at login is left bare the same way', () => {
  const k = acct('November');
  a.goals.set(k.id, 'default', 'goal', 'troop a:1k');
  const s = new Session(k.id);
  s.note = () => {};
  const home = castle(620, 'Home', 420, 320);
  const built = castle(621, 'Built', 421, 320);
  s.reconcileRegistry(fakeGame([home]));                  // an earlier login
  a.registry.claimFlat(k.id, built.fieldId, { x: 421, y: 320 }, 'buildnpc: occupying');
  s.reconcileRegistry(fakeGame([home, built]));           // this login: it was built meanwhile
  assert.strictEqual(a.registry.byCastleId(k.id, 621).state, 'built');
  assert.strictEqual(a.goals.exact(k.id, '621', 'goal').src, '');
  assert.strictEqual(a.goals.exact(k.id, '620', 'goal'), null, 'the home city was touched');
});

// ---------------------------------------------------------------------------
section('the new-city script (NEAT\'s !NewCityScript.txt)');

t('it runs once in the new city, through the console\'s runner, and the log shows the run', async () => {
  const calls = [];
  const w = world('Oscar', { runner: async (id, src, log) => { calls.push([id, src]); log('line 1: echo hi'); return { ok: true, actions: 1 }; } });
  a.goals.set(w.id, 'newcity', 'script', '// setup\necho hi');
  Session.NEW_CITY_SCRIPT_DELAY_MS = 0;
  w.add(castle(701, 'Scripted', 500, 300));
  await sleep(20);
  assert.deepStrictEqual(calls, [[701, '// setup\necho hi']]);
  assert.ok(w.said(/^new city Scripted: running the new-city script$/).length);
  assert.ok(w.said(/^new-city script: line 1: echo hi$/).length);
  assert.ok(w.said(/^new city Scripted: the new-city script finished \(1 action\(s\)\)$/).length);
  w.add(castle(701, 'Scripted', 500, 300));                // the same city again: not new
  await sleep(20);
  assert.strictEqual(calls.length, 1);
});

t('a script with errors is reported and not run', async () => {
  const w = world('Papa', { runner: async () => ({ ok: false, errors: [{ line: 2, error: 'unknown command "frobnicate"' }] }) });
  a.goals.set(w.id, 'newcity', 'script', 'echo a\nfrobnicate');
  Session.NEW_CITY_SCRIPT_DELAY_MS = 0;
  w.add(castle(711, 'Broken', 510, 300));
  await sleep(20);
  assert.ok(w.said(/new city Broken: the new-city script has 1 error\(s\) and was not run — line 2: unknown command "frobnicate"/).length);
});

t('no new-city script, or an empty one: nothing runs', async () => {
  const calls = [];
  const w = world('Quebec', { runner: async (...x) => { calls.push(x); return { ok: true }; } });
  w.add(castle(721, 'NoScript', 520, 300));
  a.goals.set(w.id, 'newcity', 'script', '   \n');
  w.add(castle(722, 'Blank', 521, 300));
  await sleep(20);
  assert.strictEqual(calls.length, 0);
});

t('outside the console (no runner) the script is not run, and the log says so', () => {
  const w = world('Romeo');
  a.goals.set(w.id, 'newcity', 'script', 'echo hi');
  w.add(castle(731, 'Daemon', 530, 300));
  assert.ok(w.said(/new city Daemon: the new-city script only runs under the console, so it was not run here/).length);
});

// ---------------------------------------------------------------------------
section('global goals: prepend, the city\'s own, append');

const layered = (p, c, ap) => G.parseLayered({ prepend: p, city: c, append: ap });

t('troop stages stack in load order: prepend first, then the city, then append', () => {
  const m = layered('troop a:1k', 'troop w:2k\ntroop p:3k', 'troop s:5');
  assert.deepStrictEqual(m.goals.filter((x) => x.name === 'troop').map((x) => `${x.source}:${x.raw}`),
    ['prepend:troop a:1k', 'city:troop w:2k', 'city:troop p:3k', 'append:troop s:5']);
});

t('config: a later layer wins per key (append over the city over prepend)', () => {
  const m = layered('config npc:5,comfort:1,hero:1', 'config npc:10', 'config hero:0');
  assert.deepStrictEqual(m.config, { npc: 10, comfort: 1, hero: 0 });
});

t('a singleton: the city\'s line overrides the prepend one, append overrides both', () => {
  let m = layered('comfortpolicy 10 20 popraise', 'comfortpolicy 15 16 popraise', null);
  assert.deepStrictEqual(m.goals.filter((x) => x.name === 'comfortpolicy').map((x) => x.source), ['city']);
  assert.strictEqual(m.goals.find((x) => x.name === 'comfortpolicy').everyMinMin, 15);
  m = layered('comfortpolicy 10 20 popraise', 'comfortpolicy 15 16 popraise', 'comfortpolicy 30 40 popraise');
  assert.deepStrictEqual(m.goals.filter((x) => x.name === 'comfortpolicy').map((x) => x.source), ['append']);
  assert.strictEqual(m.goals.find((x) => x.name === 'comfortpolicy').everyMinMin, 30);
});

t('an override across layers is not an error; a repeat within one text still is', () => {
  let m = layered('defensepolicy /usetruce:79', 'defensepolicy /usetruce:50', null);
  assert.deepStrictEqual(m.errors, []);
  m = layered('defensepolicy /usetruce:79\ndefensepolicy /usetruce:1', null, null);
  assert.strictEqual(m.errors.length, 1);
  has(m.errors[0].where, 'prepend line 2');
  has(m.errors[0].error, 'appears more than once');
});

t('errors say which text they are in: "append line 3", "prepend line 1", and plain "line N" in the city', () => {
  // r is NEAT's rolling logs since Step 9; ro is still no fortification at all
  const m = layered('bogus thing', 'troop zz:1', 'config comfort:1\n\nfortification ro:10');
  assert.deepStrictEqual(m.errors.map((e) => `${e.where}: ${e.error}`), [
    'prepend line 1: unknown goal "bogus"',
    'line 1: TROOP: unknown troop code "zz"',
    'append line 3: FORTIFICATION: unknown fortification "ro"',
  ]);
  const note = G.layerNote(m);
  has(note, 'global goals: 2 line(s) skipped, not understood');
  has(note, 'prepend line 1: unknown goal "bogus"; append line 3: FORTIFICATION: unknown fortification "ro"');
  assert.ok(!note.includes('troop code'), 'the city\'s own error was reported as a global one');
});

t('a global text that is only comments does not wake a city with no goals', () => {
  assert.strictEqual(layered('// nothing yet\n\n# really', null, '   '), null);
  assert.strictEqual(layered(null, null, null), null);
});

t('a city saved empty still runs the global goals (they are for every city)', () => {
  const m = layered('config comfort:1', null, 'troop s:1');
  assert.deepStrictEqual(m.goals.map((x) => x.raw), ['troop s:1']);
  assert.deepStrictEqual(m.config, { comfort: 1 });
});

t('the engine runs the layers from the database, and says in every city when a global line is broken', async () => {
  const k = acct('Sierra');
  a.goals.set(k.id, 'prepend', 'goal', 'config comfort:1\ncomfortpolicy 15 16 popraise');
  a.goals.set(k.id, '801', 'goal', 'troop w:10');
  a.goals.set(k.id, 'append', 'goal', 'troop s:10\nwibble 3');
  const g = fakeGame([castle(801, 'One', 600, 300), castle(802, 'Two', 601, 300)]);
  a.goals.set(k.id, '802', 'goal', '');
  const e = new Engine(g, () => {}, k.id);
  e.dryRun = true;
  const one = e.goalsFor(801, 'One');
  assert.deepStrictEqual(one.goals.map((x) => x.raw), ['comfortpolicy 15 16 popraise', 'troop w:10', 'troop s:10']);
  for (const c of g.castles) {
    const r = await e.focus(c);
    assert.ok(r.globals, `${c.name}: no plan note for the broken append line`);
    has(r.globals.note, 'append line 2: unknown goal "wibble"');
  }
  a.goals.set(k.id, 'append', 'goal', 'troop s:10');
  const r = await e.focus(g.castles[0]);
  assert.strictEqual(r.globals, undefined, 'the note stayed after the line was fixed');
});

t('with no global goals a city\'s goals are exactly what they were (the live goals do not change)', () => {
  const live = [
    '// Lord22 build-up', 'config comfort:1,hero:1,troopsusepopmax:1', 'comfortpolicy 15 16 popraise',
    'defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1',
    'build f:10:37,s:0:0,i:0:0,q:0:0', 'troop b:5k,t:5k',
    'troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k', 'troop a:100k,s:100k', '',
    'fortification ab:5000', '', 'distancepolicy 15', 'npcteams 3', 'traininghero OTTO 30 60', 'npcheroes !OTTO,any',
    // in NEAT's order, as migrate-goals-transfer.js rewrites the saved line (Step 9)
    'requestresources any wood 2000000 200000 * 500000 /below:100000', 'farmingpolicy 10 /distance:5', 'farmingpolicy 5 /distance:10',
  ].join('\r\n');
  const plain = parseGoals(live);
  const m = layered(null, live, null);
  assert.deepStrictEqual(m.config, plain.config);
  assert.deepStrictEqual(m.goals.map(({ source, ...x }) => x), plain.goals);
  assert.deepStrictEqual(m.errors.map(({ source, where, ...x }) => x), plain.errors);
  assert.deepStrictEqual(describe(m), describe(plain));
});

// ---------------------------------------------------------------------------
section('engine state and reports keyed by castle id');

t('state saved under city names moves to castle ids, and the name rows leave the database', () => {
  const k = acct('Tango');
  const fails = { failures: { 'build:upgrade:7:1001': { n: 2, until: Date.now() + 600e3, msg: 'Insufficient resources' } }, lastComfort: 42 };
  D.engineState.save({ Eldian: fails, hero: { otto: { since: 1, at: 86253479 } }, Gone: { lastComfort: 7 } }, k.id);
  const lines = [];
  const g = fakeGame([castle(86253479, 'Eldian', 700, 300), castle(86253480, 'Other', 701, 300)]);
  const e = new Engine(g, (m) => lines.push(m), k.id);
  assert.deepStrictEqual(e.state['86253479'], fails);
  assert.strictEqual(e.state.Eldian, undefined);
  assert.deepStrictEqual(e.state.hero, { otto: { since: 1, at: 86253479 } }, 'the traininghero record was taken for a city');
  const saved = D.engineState.load(k.id);
  assert.ok(!('Eldian' in saved), 'the name row came back from the database');
  assert.deepStrictEqual(saved['86253479'], fails);
  assert.ok(saved.Gone, 'state for a city no longer held was deleted');
  assert.ok(lines.some((l) => l.includes('engine state: moved from city names to castle ids — Eldian -> 86253479')), lines.join('\n'));
  // a restart finds nothing left to move
  const lines2 = [];
  const e2 = new Engine(g, (m) => lines2.push(m), k.id);
  assert.deepStrictEqual(e2.state['86253479'], fails);
  assert.strictEqual(lines2.length, 0);
});

t('two cities that shared a name each keep a copy of what they shared', () => {
  const k = acct('Uniform');
  D.engineState.save({ 'New City': { builderHeld: 123 } }, k.id);
  const g = fakeGame([castle(901, 'New City', 710, 300), castle(902, 'New City', 711, 300)]);
  const e = new Engine(g, () => {}, k.id);
  assert.deepStrictEqual(e.state['901'], { builderHeld: 123 });
  assert.deepStrictEqual(e.state['902'], { builderHeld: 123 });
  assert.notStrictEqual(e.state['901'], e.state['902'], 'the two cities still share one object');
});

t('a city that already has state under its id keeps that; a name that is also a castle id is left alone', () => {
  const k = acct('Victor');
  D.engineState.save({ Keep: { lastComfort: 1 }, 911: { lastComfort: 2 }, 912: { lastComfort: 3 } }, k.id);
  const g = fakeGame([castle(911, 'Keep', 720, 300), castle(913, '912', 721, 300), castle(912, 'Twelve', 722, 300)]);
  const e = new Engine(g, () => {}, k.id);
  assert.deepStrictEqual(e.state['911'], { lastComfort: 2 });
  assert.deepStrictEqual(e.state['912'], { lastComfort: 3 }, 'city "912" took castle 912\'s state');
  assert.strictEqual(e.state['913'], undefined);
});

t('it happens once: a later city carrying an old name does not inherit what is left under it', async () => {
  const k = acct('Whiskey');
  D.engineState.save({ Ghost: { failures: { x: { n: 5, until: Date.now() + 3600e3, msg: 'old' } } } }, k.id);
  const g = fakeGame([castle(921, 'Alive', 730, 300)]);
  const e = new Engine(g, () => {}, k.id);
  assert.ok(e.state.Ghost, 'state for a city not held was dropped');
  g.castles.push(castle(922, 'Ghost', 731, 300));       // a new city takes the old name
  await e.tick();
  assert.ok(!e.state['922'] || !e.state['922'].failures, 'the new city inherited the old city\'s backoffs');
});

t('a reconnect that carries name-keyed state over is moved on the next tick', async () => {
  const k = acct('Xray');
  const g = fakeGame([castle(931, 'Carried', 740, 300)]);
  const e = new Engine(g, () => {}, k.id);
  e.state = { Carried: { lastComfort: 9 } };             // session.js: engine.state = prev
  await e.tick();
  assert.strictEqual(e.state['931'].lastComfort, 9);
  assert.strictEqual(e.state.Carried, undefined);
});

t('two new cities with the same name keep separate backoffs', async () => {
  const k = acct('Yankee');
  const refuse = { ok: -1, errorMsg: 'Insufficient resources. Required Lumber 139300.' };
  const twin = (id, x) => castle(id, 'New City', x, 300, {
    buildings: [{ typeId: C.TOWN_HALL, positionId: -1, level: 5, status: 0 }],
  });
  const g = fakeGame([twin(941, 750), twin(942, 751)]);
  const sent = [];
  g.newBuilding = async (cid, pos, type) => { sent.push(cid); return cid === 941 ? refuse : { ok: 1 }; };
  const e = new Engine(g, () => {}, k.id);
  e.dryRun = false;
  e.goalsFor = () => parseGoals('config hero:0\nbuild c:1:1');
  await e.focus(g.castles[0]);
  await e.focus(g.castles[1]);
  assert.deepStrictEqual(sent, [941, 942], 'the second city was held back by the first one\'s refusal');
  assert.ok(Object.keys(e.state['941'].failures || {}).length, 'the refusal was not recorded');
  assert.ok(!Object.keys(e.state['942'].failures || {}).length, 'the refusal was recorded against the other city too');
});

t('reports are filed by castle id; the log still names the city; the console reads them by id', async () => {
  const k = acct('Zulu');
  a.goals.set(k.id, '951', 'goal', 'config hero:0\ntroop a:1');
  const g = fakeGame([castle(951, 'Named', 760, 300)]);
  const lines = [];
  const e = new Engine(g, (m, meta) => lines.push({ m, ...(meta || {}) }), k.id);
  e.dryRun = true;
  await e.tick();
  assert.ok(e.lastReport['951'], 'no report under the castle id');
  assert.strictEqual(e.lastReport.Named, undefined);
  assert.strictEqual(e.lastReport['951'].city, 'Named');
  assert.ok(lines.some((l) => l.city === 'Named' && l.kind === 'plan'), 'the plan line was not filed under the city name');
  const s = new Session(k.id);
  s.game = g; s.engine = e;
  const view = s.engineReport(951);
  assert.ok(view && view.notes.length, 'the console\'s engine view found no report');
});

// ---------------------------------------------------------------------------
section('the account-wide texts in the console (/api/goals/account)');

t('an account with no template is offered NEAT\'s default, unsaved', () => {
  const k = acct('Able');
  const r = G.readText(a.goals, k.id, 'template');
  assert.strictEqual(r.src, '');
  assert.strictEqual(r.exists, false);
  assert.strictEqual(r.suggested, G.NEW_CITY_GOALS);
  assert.strictEqual(a.goals.exact(k.id, 'default', 'goal'), null, 'the suggestion was saved without being asked');
});

t('NEAT\'s default reads cleanly in NEAT\'s own codes, its build c:1 and r:10,rock:10 included', () => {
  const p = parseGoals(G.NEW_CITY_GOALS);
  assert.deepStrictEqual(p.errors, []);
  assert.ok(G.NEW_CITY_GOALS.includes('fortification trap:10,ab:10,at:1,r:10,rock:10'), 'the wiki\'s line, word for word (Step 9)');
  assert.deepStrictEqual(p.config, { comfort: 1, gate: 1 });
  assert.deepStrictEqual(p.goals.filter((x) => x.name === 'build').map((x) => x.raw), ['build c:1']);
  const troop = p.goals.find((x) => x.name === 'troop');
  assert.deepStrictEqual(Object.keys(troop.troops).sort(), C.TROOPS.map((x) => x.key).filter((x) => !['ballista', 'carriage'].includes(x)).sort());
  assert.deepStrictEqual(p.goals.find((x) => x.name === 'fortification').forts, { trap: 10, abatis: 10, tower: 1, logs: 10, rocks: 10 });
});

t('its build c:1 asks for one cottage in a bare city and pulls down none in a captured one', () => {
  const { buildPlan } = require('./engine');
  const goals = parseGoals(G.NEW_CITY_GOALS);
  const th = { typeId: C.TOWN_HALL, positionId: -1, level: 5, status: 0 };
  const plan = (buildings) => buildPlan({ castle: castle(1, 'X', 1, 1, { buildings }), goals: goals.goals, config: goals.config });
  const bare = plan([th]);
  assert.ok(bare.ranked.some((a) => a.kind === 'new' && a.def.typeId === 1), 'no cottage for a city with its Town Hall alone');
  const cottages = [1, 2, 3, 4, 5, 6].map((i) => ({ typeId: 1, positionId: i, level: i, status: 0 }));
  const taken = plan([th, { typeId: C.WALLS_TYPE, positionId: -2, level: 1, status: 0 }, ...cottages]);
  assert.ok(!(taken && taken.ranked.some((a) => a.kind === 'demolish')), 'the template would demolish in a captured city');
  assert.ok(!(taken && taken.ranked.some((a) => a.def && a.def.typeId === 1)), 'six cottages still leave build c:1 unmet');
});

t('the template is the account\'s default row: saved from the console, it seeds the next new city', () => {
  const w = world('Baker');
  const r = G.saveText(a.goals, w.id, { which: 'template', src: G.NEW_CITY_GOALS, save: true });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.saved, 'template');
  has(r.note, 'Cities that appear from now on start from it');
  assert.strictEqual(a.goals.exact(w.id, 'default', 'goal').src, G.NEW_CITY_GOALS);
  assert.strictEqual(G.readText(a.goals, w.id, 'template').suggested, undefined);
  w.add(castle(1001, 'Fresh', 800, 300));
  assert.strictEqual(a.goals.exact(w.id, '1001', 'goal').src, G.NEW_CITY_GOALS);
  assert.ok(w.said(/new city Fresh: goals set from the new-city template, 4 goal line\(s\) applied/).length);
});

t('prepend and append save, read back, and report errors with their text\'s name', () => {
  const k = acct('Charlie2');
  let r = G.saveText(a.goals, k.id, { which: 'prepend', src: 'config comfort:1\nnosuchgoal 1', save: true });
  assert.deepStrictEqual(r.errors.map((e) => `${e.where}: ${e.error}`), ['prepend line 2: unknown goal "nosuchgoal"']);
  has(r.note, 'before its own goals');
  assert.strictEqual(G.readText(a.goals, k.id, 'prepend').src, 'config comfort:1\nnosuchgoal 1');
  // rock is NEAT's rock fall (Step 9); ro is still no fortification at all
  r = G.saveText(a.goals, k.id, { which: 'append', src: 'troop s:1\n\nfortification ro:1', save: false });
  assert.deepStrictEqual(r.errors.map((e) => e.where), ['append line 3']);
  assert.strictEqual(r.saved, null);
  assert.strictEqual(a.goals.exact(k.id, 'append', 'goal'), null, 'Apply saved it');
  assert.ok(r.described.length, 'no description of what the lines do');
});

t('the new-city script is checked as a script; its errors are "new-city script line N"', () => {
  const k = acct('Dog');
  const r = G.saveText(a.goals, k.id, { which: 'script', src: 'echo hi\nfrobnicate now', save: true });
  assert.strictEqual(r.errors.length, 1);
  has(`${r.errors[0].where}: ${r.errors[0].error}`, 'new-city script line 2');
  assert.strictEqual(a.goals.exact(k.id, 'newcity', 'script').src, 'echo hi\nfrobnicate now');
  assert.deepStrictEqual(a.goals.loadouts(k.id, 5), [], 'the new-city script turned up as a city loadout');
});

t('the account texts answer with each line\'s standing, for the editor\'s colours', () => {
  const k = acct('Dog2');
  let r = G.saveText(a.goals, k.id, { which: 'append', src: '// c\nconfig comfort:1\n\nbogus 1', save: false });
  assert.deepStrictEqual(r.lines.map((l) => l.status), ['comment', 'ok', 'blank', 'error']);
  // a huge repeat is checked, not expanded (script.js lineStatus)
  r = G.saveText(a.goals, k.id, { which: 'script', src: '// s\necho hi\nfrobnicate now\nrepeat 100000000', save: false });
  assert.deepStrictEqual(r.lines.map((l) => l.status), ['comment', 'ok', 'error', 'ok']);
  assert.deepStrictEqual(r.errors.map((e) => e.where), ['new-city script line 3']);
});

t('a text saved blank is stored empty', () => {
  const k = acct('Easy');
  G.saveText(a.goals, k.id, { which: 'append', src: '  \n ', save: true });
  assert.strictEqual(a.goals.exact(k.id, 'append', 'goal').src, '');
  assert.strictEqual(G.readText(a.goals, k.id, 'append').exists, true);
});

t('an install-wide default shows as the inherited template', () => {
  const k = acct('Fox');
  D.goals.set('', 'default', 'goal', 'troop s:3');
  try {
    const r = G.readText(a.goals, k.id, 'template');
    assert.strictEqual(r.src, 'troop s:3');
    assert.strictEqual(r.inherited, true);
    assert.strictEqual(r.suggested, undefined);
  } finally { D.goals.remove('', 'default', 'goal'); }
});

t('an unknown text and another organization\'s account are refused', () => {
  const k = acct('George');
  assert.throws(() => G.readText(a.goals, k.id, 'bogus'), /template, prepend, append or script/);
  assert.throws(() => G.saveText(a.goals, rival.id, { which: 'prepend', src: 'troop a:1', save: true }), /does not belong/);
  b.goals.set(rival.id, 'prepend', 'goal', 'troop c:1');
  assert.strictEqual(G.readText(a.goals, rival.id, 'prepend').src, '', 'read another organization\'s prepend goals');
  assert.deepStrictEqual(a.goals.layers(rival.id, 1, 'x'), { prepend: null, city: null, append: null });
});

// ---------------------------------------------------------------------------

(async () => {
  for (const [n, f] of tests) {
    if (!f) { console.log('\n' + n + '\n'); continue; }
    try { await f(); console.log('  ok    ' + n); pass++; }
    catch (e) { console.log('  FAIL  ' + n + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
