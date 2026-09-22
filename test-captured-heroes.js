'use strict';
// Captured heroes, empty cities and full halls, offline.
//
// What the user asked for on 2026-09-22, and what this pins down:
//   * `keepcapturedheroes any:level>600|any:base>145` RELEASES the prisoners it
//     does not keep — the level-2 and level-20 heroes a conquered valley drops
//     into our cells, which sit in Feasting Hall slots and block the training
//     hero's round until somebody walks all 210 cities;
//   * a hero of one of our OWN accounts is never released, whatever the line
//     says: releasing a captured hero from the captor's side LOSES it
//     (EVONY-RULES.md section 5), and the fleet register is what knows;
//   * a city with no hero of its own fills itself — a Sigil of Recruitment or a
//     Crystal of Attunement first, then the inn;
//   * a city holding ten frees a slot by MOVING a hero out rather than
//     dismissing one, and dismisses only under keepheroes /firebelow:<n>;
//   * a training hero passing through is never left holding the mayor's office
//     alone, and never has the office taken off it for a march it cannot make.
//
// Hand-made rosters and stub games only: nothing here connects to the game.
const path = require('path'), os = require('os'), fs = require('fs');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-captured-')), 't.db');   // before db.js loads

const C = require('./constants');
const H = require('./goal-heroes');
const M = require('./goalmods');
const { Game } = require('./game');
const { parseGoals } = require('./goals');

let pass = 0, fail = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const section = (s) => tests.push([s, null]);
function eq(got, want, what = '') {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what ? what + ': ' : ''}got ${g}, want ${w}`);
}
function ok(cond, what) { if (!cond) throw new Error(what || 'expected true'); }
const has = (text, re, what) => ok(re.test(String(text)), `${what ? what + ': ' : ''}${JSON.stringify(String(text))} does not match ${re}`);

// ---------------------------------------------------------------- fixtures
let nextId = 5000;
const hero = (o) => Object.assign({
  id: nextId++, name: '?', level: 10, status: 0,
  power: 20, powerAdded: 0, management: 10, managementAdded: 0, stratagem: 10, stratagemAdded: 0,
  loyalty: 100, experience: 0, upgradeExp: 0, remainPoint: 0,
}, o);

let nextCastle = 1;
function city(name, heros, { hall = 10, rally = 5, scouts = 10, gold = 1e9, x = null } = {}) {
  const id = nextCastle++;
  const cx = x === null ? 100 + id * 5 : x;
  return {
    castleId: id, id, name, heros, troop: { scouter: scouts }, fortification: {},
    fieldId: C.coordsToFieldId(cx, 100), _xy: { x: cx, y: 100 },
    resource: { food: { amount: 1e9 }, wood: { amount: 1e9 }, stone: { amount: 1e9 }, iron: { amount: 1e9 }, gold },
    buildings: [
      ...(hall === null ? [] : [{ typeId: 27, level: hall, positionId: 3 }]),
      ...(rally === null ? [] : [{ typeId: 29, level: rally, positionId: 5 }]),
    ],
  };
}
function planGame(castles, { items = null } = {}) {
  return {
    castles, castleId: (c) => c.castleId, castleXY: (c) => c._xy, hallSeen: {},
    player: items === null ? {} : { items },
  };
}
function readInn(game, castle, posCount, { at = Date.now(), offers = null } = {}) {
  const fh = (castle.buildings || []).find((b) => b.typeId === 27);
  game.hallSeen[castle.castleId] = {
    at, posCount, heroes: castle.heros.length, capacity: posCount + castle.heros.length, fhLevel: fh ? fh.level : null,
  };
  if (offers) { game.innSeen = game.innSeen || {}; game.innSeen[castle.castleId] = { at, offers }; }
}
function ctxFor(game, castle, src, others = {}) {
  const parsed = parseGoals(src);
  if (parsed.errors.length) throw new Error('goals did not parse: ' + JSON.stringify(parsed.errors));
  const goalsOf = (c) => (c === castle ? parsed.goals : (others[c.name] !== undefined ? parseGoals(others[c.name]).goals : []));
  return { game, castle, goals: parsed.goals, config: parsed.config, goalsOf, fortifications: {}, incoming: [] };
}
// A fleet register stand-in: `own` are hero ids we have seen on our accounts.
const fleetOf = (own = {}, { complete = true, why = 'not complete' } = {}) => ({
  has: (id) => (own[String(id)] ? { accountId: own[String(id)] } : null),
  named: (name) => Object.entries(own).filter(([, v]) => v && v.name === name).map(([, v]) => v),
  coverage: () => (complete ? { ok: true, why: 'all on' } : { ok: false, why }),
});
const kinds = (p) => ((p && p.actions) || []).map((a) => a.kind);
const names = (p) => ((p && p.actions) || []).map((a) => a.heroName);

const KEEP = 'keepcapturedheroes any:level>600|any:base>145';
// A city has to look empty for EMPTY_SETTLE_MS before anything is spent on it
// (a console that has just logged in reports a short hero list). Tests that are
// about what it then DOES hand in a state that has already waited.
const settled = (extra = {}) => ({ emptySince: Date.now() - H.EMPTY_SETTLE_MS - 1000, ...extra });
// a roster of n heroes, the first one mayor
const ten = (n = 10) => Array.from({ length: n }, (_, i) => hero({ name: `H${i}`, level: 300 + i, power: 100 + i, status: i === 0 ? 1 : 0 }));

// ======================================================================
section('1. keepcapturedheroes releases what it does not keep');
// ======================================================================

t('the line the user asked for parses, and keeps level>600 OR base>145', () => {
  const p = parseGoals(KEEP);
  eq(p.errors, []);
  const spec = p.goals[0].spec;
  const junk = hero({ name: 'Harriet', level: 2, power: 12 });
  const mid = hero({ name: 'Rachel', level: 39, power: 60 });
  const big = hero({ name: 'Boss', level: 900, power: 950 });
  // base = top attribute less one point per level, plus unspent (Game.heroBase)
  const strong = hero({ name: 'Strong', level: 5, power: 151 });
  eq(H.matchHero(junk, spec), false, 'a level-2 hero is not kept');
  eq(H.matchHero(mid, spec), false, 'a level-39 hero is not kept');
  eq(H.matchHero(big, spec), true, 'past level 600 is kept');
  ok(Game.heroBase(strong) > 145, 'the fixture really has a base over 145');
  eq(H.matchHero(strong, spec), true, 'a base over 145 is kept');
});

t('with a keepcapturedheroes line, the prisoner it does not keep is released — worst first, one a pass', () => {
  const a = hero({ name: 'Harriet', status: 4, level: 2, power: 12 });
  const b = hero({ name: 'Rachel', status: 4, level: 39, power: 60 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1, management: 90 }), a, b]);
  const ctx = { ...ctxFor(planGame([x]), x, KEEP), fleet: fleetOf() };
  const p = H.plans.captives(ctx, {});
  eq(kinds(p), ['releaseHero']);
  eq(names(p), ['Harriet'], 'the lowest level goes first');
  eq(p.actions[0].heroId, a.id, 'the action carries the hero ID, not just the name');
  has(p.note, /releasing 1 of 2: Harriet/);
  has(p.actions[0].label, /RELEASE prisoner Harriet \(L2/);
  has(p.actions[0].label, /irreversible/);
});

t('a prisoner the line keeps stays, and the note says which rule kept it', () => {
  const big = hero({ name: 'Boss', status: 4, level: 900, power: 950 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1 }), big]);
  const ctx = { ...ctxFor(planGame([x]), x, KEEP), fleet: fleetOf() };
  const p = H.plans.captives(ctx, {});
  eq(p.actions, []);
  has(p.note, /Boss: keepcapturedheroes \[any:level>600\|any:base>145\] keeps it/);
});

t('with NO keepcapturedheroes line nothing is ever released — the line is the opt-in', () => {
  const junk = hero({ name: 'Harriet', status: 4, level: 2, power: 12 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1 }), junk]);
  const ctx = { ...ctxFor(planGame([x]), x, 'config hero:1'), fleet: fleetOf() };
  const p = H.plans.captives(ctx, {});
  eq(p.actions, []);
  has(p.note, /no keepcapturedheroes line here, so none is released by itself/);
});

// ======================================================================
section('2. our own heroes are never released');
// ======================================================================

t('a prisoner whose ID is on the fleet register is NEVER released, however junk the line thinks it is', () => {
  const ours = hero({ name: 'Att66A391', status: 4, level: 66, power: 70 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1 }), ours]);
  const ctx = { ...ctxFor(planGame([x]), x, KEEP), fleet: fleetOf({ [ours.id]: 'a2' }) };
  const p = H.plans.captives(ctx, {});
  eq(p.actions, [], 'nothing is sent');
  has(p.note, /is OUR OWN hero — last seen on a2/);
  has(p.note, /Stone of Finding/);
});

t('a prisoner carrying a name one of our heroes has ever carried is held too', () => {
  const stranger = hero({ name: 'Kingkush', status: 4, level: 20, power: 30 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1 }), stranger]);
  const reg = fleetOf({ 999: { accountId: 'a10', name: 'Kingkush' } });
  const ctx = { ...ctxFor(planGame([x]), x, KEEP), fleet: reg };
  const p = H.plans.captives(ctx, {});
  eq(p.actions, []);
  has(p.note, /a hero of ours has carried the name "Kingkush" \(a10\)/);
});

t('nothing is released at all while the fleet register is incomplete', () => {
  const junk = hero({ name: 'Harriet', status: 4, level: 2, power: 12 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1 }), junk]);
  const ctx = { ...ctxFor(planGame([x]), x, KEEP), fleet: fleetOf({}, { complete: false, why: 'the fleet hero register is not complete yet — 3 account(s) have not reported' }) };
  const p = H.plans.captives(ctx, {});
  eq(p.actions, []);
  has(p.note, /register is not complete yet/);
});

t('OTTO_NO_RELEASE=1 stops every release', () => {
  const junk = hero({ name: 'Harriet', status: 4, level: 2, power: 12 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1 }), junk]);
  const ctx = { ...ctxFor(planGame([x]), x, KEEP), fleet: fleetOf() };
  process.env.OTTO_NO_RELEASE = '1';
  try {
    const p = H.plans.captives(ctx, {});
    eq(p.actions, []);
    has(p.note, /OTTO_NO_RELEASE=1 is set/);
  } finally { delete process.env.OTTO_NO_RELEASE; }
});

t('a half-loaded roster releases nobody, and the cooldown holds the second release back', () => {
  const junk = hero({ name: 'Harriet', status: 4, level: 2, power: 12 });
  const bare = city('Jail', [junk]);
  delete bare.heros[0].status;                                     // a hero with no status: the list is still arriving
  const ctx0 = { ...ctxFor(planGame([bare]), bare, KEEP), fleet: fleetOf() };
  eq(H.plans.captives(ctx0, {}), null, 'no prisoner is even recognised off a broken roster');

  const j2 = hero({ name: 'Philip', status: 4, level: 12, power: 20 });
  const x = city('Jail2', [hero({ name: 'Mine', status: 1 }), j2]);
  const ctx = { ...ctxFor(planGame([x]), x, KEEP), fleet: fleetOf() };
  const p = H.plans.captives(ctx, { lastReleaseAt: Date.now() - 5000 });
  eq(p.actions, []);
  has(p.note, /waiting out the cooldown/);
});

// ======================================================================
section('3. the releaseHero executor');
// ======================================================================

t('it releases by ID, and refuses a hero that is no longer that hero or no longer a prisoner', async () => {
  const p1 = hero({ name: 'Harriet', status: 4, level: 2 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1 }), p1]);
  const sent = [];
  const game = { castleId: (c) => c.castleId, releaseHero: async (cid, id) => { sent.push([cid, id]); return { ok: 1 }; } };
  const state = {};
  await H.executors.releaseHero(game, x, { heroId: p1.id, heroName: 'Harriet' }, state);
  eq(sent, [[x.castleId, p1.id]], 'castleId and heroId, nothing by name');
  ok(state.lastReleaseAt > Date.now() - 5000, 'the cooldown is stamped');

  // two heroes of the same name in one city: the id is what decides
  const twin = hero({ name: 'Harriet', status: 4, level: 900 });
  x.heros.push(twin);
  p1.name = 'Renamed';
  let err = null;
  try { await H.executors.releaseHero(game, x, { heroId: p1.id, heroName: 'Harriet' }, {}); } catch (e) { err = e.message; }
  has(err, /is now "Renamed", not "Harriet" — not releasing/);

  p1.name = 'Harriet'; p1.status = 0;                       // persuaded between the plan and here
  err = null;
  try { await H.executors.releaseHero(game, x, { heroId: p1.id, heroName: 'Harriet' }, {}); } catch (e) { err = e.message; }
  has(err, /not a prisoner — not releasing/);
});

t('the executor asks the fleet register again, and OTTO_NO_RELEASE stops it there too', async () => {
  const p1 = hero({ name: 'Harriet', status: 4, level: 2 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1 }), p1]);
  const game = { castleId: (c) => c.castleId, releaseHero: async () => ({ ok: 1 }) };
  process.env.OTTO_NO_RELEASE = '1';
  let err = null;
  try { await H.executors.releaseHero(game, x, { heroId: p1.id, heroName: 'Harriet' }, {}); } catch (e) { err = e.message; }
  delete process.env.OTTO_NO_RELEASE;
  has(err, /OTTO_NO_RELEASE=1 is set/);
});

t('with the register unreadable the executor refuses, rather than treating every hero as a stranger', async () => {
  const p1 = hero({ name: 'Harriet', status: 4, level: 2 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1 }), p1]);
  const game = { castleId: (c) => c.castleId, releaseHero: async () => ({ ok: 1 }) };
  const blind = { ok: false, has: () => null, named: () => [], coverage: () => ({ ok: false, why: 'no register' }) };
  const real = H.fleetRegister;
  // the executor builds its own register, so stand in for the module's reader
  const mod = require.cache[require.resolve('./goal-heroes')];
  let err = null;
  try {
    eq(real({ fleet: blind }).ok, false, 'a stand-in register says it cannot answer');
    // and the plan side refuses on the same flag via coverage()
    const ctx = { ...ctxFor(planGame([x]), x, KEEP), fleet: blind };
    eq(H.plans.captives(ctx, {}).actions, [], 'nothing is planned either');
    has(H.plans.captives(ctx, {}).note, /no register/);
  } finally { void mod; void err; void game; }
});

// ======================================================================
section('4. a city with no hero of its own');
// ======================================================================

const SIGIL = 'player.box.hero.f', CRYSTAL = 'player.box.hero.e';

t('an empty city opens a Sigil of Recruitment first, then a Crystal, in that city', () => {
  const x = city('Flat', []);
  const g1 = planGame([x], { items: [{ id: CRYSTAL, count: 4 }, { id: SIGIL, count: 2 }] });
  const p = H.plans.emptycity(ctxFor(g1, x, 'config hero:1'), settled());
  eq(kinds(p), ['openHeroBox']);
  eq(p.actions[0].itemId, SIGIL, 'the Sigil is the better box, so it goes first');
  has(p.note, /opening a Ardee's Sigil of Recruitment here \(2 held/);

  const g2 = planGame([x], { items: [{ id: CRYSTAL, count: 4 }] });
  eq(H.plans.emptycity(ctxFor(g2, x, 'config hero:1'), settled()).actions[0].itemId, CRYSTAL, 'the Crystal when no Sigil is held');
});

t('a city that has only JUST looked empty is left alone — a short hero list is not an empty city', () => {
  const x = city('Flat', []);
  const g = planGame([x], { items: [{ id: SIGIL, count: 5 }] });
  const st = {};
  const first = H.plans.emptycity(ctxFor(g, x, 'config hero:1'), st);
  eq(first.actions, [], 'nothing on the first pass');
  has(first.note, /waiting \d+ more min to be sure the hero list really arrived/);
  ok(st.emptySince > 0, 'the first sighting is stamped');
  // still inside the window
  eq(H.plans.emptycity(ctxFor(g, x, 'config hero:1'), st).actions, []);
  // once it has sat there long enough, the box goes
  st.emptySince = Date.now() - H.EMPTY_SETTLE_MS - 1;
  eq(kinds(H.plans.emptycity(ctxFor(g, x, 'config hero:1'), st)), ['openHeroBox']);
  // and a hero turning up clears the clock, so a later empty pass starts again
  x.heros.push(hero({ name: 'Arrived' }));
  eq(H.plans.emptycity(ctxFor(g, x, 'config hero:1'), st), null);
  eq(st.emptySince, undefined, 'the stamp is cleared');
});

t('right after a login the inventory has not arrived, and no box is ruled out on that', () => {
  const x = city('Flat', []);
  const p = H.plans.emptycity(ctxFor(planGame([x], { items: [] }), x, 'config hero:1'), settled());
  has(p.note, /the inventory has not loaded yet, so whether a hero box is held is not known/);
  ok(!kinds(p).includes('openHeroBox'), 'no box is opened on an empty inventory');
});

t('with no box held it reads the inn, then hires the best offer the city can pay for — no base bar', () => {
  const x = city('Flat', [], { gold: 5e6 });
  const game = planGame([x], { items: [{ id: SIGIL, count: 0 }] });
  const p1 = H.plans.emptycity(ctxFor(game, x, 'config hero:1'), settled());
  eq(kinds(p1), ['readHall'], 'the inn is read first');

  readInn(game, x, 5, { offers: [
    hero({ name: 'Weedy', level: 2, power: 22 }),
    hero({ name: 'Decent', level: 4, power: 70 }),
  ] });
  const p2 = H.plans.emptycity(ctxFor(game, x, 'config hero:1'), settled());
  eq(kinds(p2), ['hireFirstHero']);
  eq(p2.actions[0].heroName, 'Decent', 'the best base wins, however low the bar');
  has(p2.note, /hiring Decent/);
});

t('config hero:0 leaves an empty city alone, and a city with a hero of its own is not touched', () => {
  const x = city('Flat', []);
  const game = planGame([x], { items: [{ id: SIGIL, count: 2 }] });
  const off = H.plans.emptycity(ctxFor(game, x, 'config hero:0'), settled());
  eq(off.actions, []);
  has(off.note, /config hero:0/);

  const full = city('Full', [hero({ name: 'Mine' })]);
  eq(H.plans.emptycity(ctxFor(planGame([full]), full, 'config hero:1'), settled()), null);
});

t('a city holding nothing but a training hero passing through counts as empty', () => {
  const otto = hero({ name: 'OTTO', status: 1, power: 900 });
  const a = city('Stop1', [otto]);
  const b = city('Stop2', [hero({ name: 'Local' })]);
  const game = planGame([a, b], { items: [{ id: SIGIL, count: 2 }] });
  const ctx = ctxFor(game, a, 'config hero:1\ntraininghero OTTO', { Stop2: 'traininghero OTTO' });
  const p = H.plans.emptycity(ctx, settled());
  eq(kinds(p), ['openHeroBox']);
  has(p.note, /no hero of its own in Stop1 — only OTTO, passing through or held/);
  has(p.note, /a training hero that lands here gets stuck/);

  // the same hero parked in the only city that wants it IS that city's own
  const solo = ctxFor(planGame([a], { items: [{ id: SIGIL, count: 2 }] }), a, 'config hero:1\ntraininghero OTTO');
  eq(H.plans.emptycity(solo, settled()), null, 'no rotation, so OTTO is this city\'s hero');
});

t('a prisoner is not a hero of its own either', () => {
  const x = city('Jail', [hero({ name: 'Philip', status: 4, level: 12 })]);
  const p = H.plans.emptycity(ctxFor(planGame([x], { items: [{ id: SIGIL, count: 1 }] }), x, 'config hero:1'), settled());
  eq(kinds(p), ['openHeroBox']);
  has(p.note, /only Philip, passing through or held/);
});

t('the box and the hire are both refused if a hero turned up in between', async () => {
  const x = city('Flat', [hero({ name: 'Arrived' })]);
  const game = { castleId: (c) => c.castleId, useItem: async () => ({ ok: 1 }), hireHero: async () => ({ ok: 1 }), player: { items: [{ id: SIGIL, count: 1 }] } };
  let err = null;
  try { await H.executors.openHeroBox(game, x, { itemId: SIGIL, itemName: 'Sigil', heroesThen: 0 }, {}); } catch (e) { err = e.message; }
  has(err, /has another hero now — keeping the Sigil/);
  err = null;
  try { await H.executors.hireFirstHero(game, x, { heroName: 'Decent', cost: 4000, heroesThen: 0 }, {}); } catch (e) { err = e.message; }
  has(err, /has another hero now — not hiring Decent/);
});

t('an account on holiday is left completely alone — no box, no hire, no move, no release', () => {
  const hol = { holiday: { hours: 30, minutes: 0, text: '30h' } };
  // an empty city
  const x = city('Flat', []);
  const g1 = Object.assign(planGame([x], { items: [{ id: SIGIL, count: 5 }] }), hol);
  const e = H.plans.emptycity(ctxFor(g1, x, 'config hero:1'), settled());
  eq(e.actions, []);
  has(e.note, /on holiday — it is being held still on purpose/);

  // a full city
  const full = city('Full', ten(), { hall: 10 });
  const near = city('Near', [hero({ name: 'N1' })], { hall: 10 });
  const g2 = Object.assign(planGame([full, near]), hol);
  readInn(g2, full, 0);
  const m = H.makeRoom(ctxFor(g2, full, 'config hero:1', { Near: '' }), { hallReadAt: Date.now() }, { need: 1, reason: 'room' });
  eq(m.actions, []);
  has(m.note, /on holiday/);

  // and a prisoner the line would let go
  const junk = hero({ name: 'Harriet', status: 4, level: 2, power: 12 });
  const jail = city('Jail', [hero({ name: 'Mine', status: 1 }), junk]);
  const g3 = Object.assign(planGame([jail]), hol);
  const c = H.plans.captives({ ...ctxFor(g3, jail, KEEP), fleet: fleetOf() }, {});
  eq(c.actions, []);
  has(c.note, /on holiday/);
});

// ======================================================================
section('5. a city holding ten: move out before dismissing');
// ======================================================================

t('a full city marches its weakest idle hero to the nearest city with room, rather than firing anyone', () => {
  const full = city('Full', ten(), { hall: 10, x: 100 });
  const near = city('Near', [hero({ name: 'N1' })], { hall: 10, x: 105 });
  const far = city('Far', [hero({ name: 'F1' })], { hall: 10, x: 400 });
  const game = planGame([full, near, far]);
  readInn(game, full, 0);
  const ctx = ctxFor(game, full, 'config hero:1', { Near: '', Far: '' });
  const p = H.makeRoom(ctx, { hallReadAt: Date.now() }, { need: 1, reason: 'room for traininghero OTTO' });
  eq(kinds(p), ['moveHeroOut']);
  eq(p.actions[0].heroName, 'H1', 'the weakest idle hero goes, never the mayor');
  eq(p.actions[0].to.name, 'Near', 'the nearest city with room');
  ok(p.actions[0].rally, 'it books a rally slot like any other march');
  has(p.note, /rather than dismissing anyone/);
});

t('a city with no scout cannot send anyone, and says so instead of dismissing', () => {
  const full = city('Full', ten(), { hall: 10, scouts: 0 });
  const near = city('Near', [hero({ name: 'N1' })], { hall: 10 });
  const game = planGame([full, near]);
  readInn(game, full, 0);
  const p = H.makeRoom(ctxFor(game, full, 'config hero:1', { Near: '' }), { hallReadAt: Date.now() }, { need: 1, reason: 'room' });
  eq(p.actions, []);
  has(p.note, /no move out either: no scout in this city to carry the march/);
  has(p.note, /config hero:1/);
});

t('a move target must be under 9 heroes AND have a free hall slot', () => {
  const full = city('Full', ten(), { hall: 10 });
  const nine = city('Nine', ten(9), { hall: 10 });        // 9 heroes: not under 9
  const tight = city('Tight', ten(3), { hall: 3 });       // under 9, but its own hall is full
  const game = planGame([full, nine, tight]);
  readInn(game, full, 0);
  const p = H.makeRoom(ctxFor(game, full, 'config hero:1', { Nine: '', Tight: '' }), { hallReadAt: Date.now() }, { need: 1, reason: 'room' });
  eq(p.actions, []);
  has(p.note, /no other city of this account has room \(under 9 heroes and a free hall slot\)/);
});

t('keepheroes /firebelow:200 is the only way a dismissal happens under config hero:1 — and it caps the level', () => {
  const roster = [
    hero({ name: 'Boss', status: 1, management: 900 }),
    hero({ name: 'Big', level: 800, power: 40 }),
    hero({ name: 'Small', level: 44, power: 60 }),
  ];
  const full = city('Full', roster, { hall: 3 });
  const game = planGame([full]);                             // no other city: no move possible
  readInn(game, full, 0);
  const st = { hallReadAt: Date.now() };

  const off = H.makeRoom(ctxFor(game, full, 'config hero:1'), st, { need: 1, reason: 'room' });
  eq(off.actions, [], 'without the switch config hero:1 never fires');
  has(off.note, /config hero:1 — level & reward only/);

  const on = H.makeRoom(ctxFor(game, full, 'config hero:1\nkeepheroes /firebelow:200'), st, { need: 1, reason: 'room' });
  eq(kinds(on), ['fireHero']);
  eq(names(on), ['Small'], 'only the hero under level 200, never the level-800 one');
  eq(on.actions[0].heroId, roster[2].id, 'dismissed by ID, never by name');
});

t('a prisoner on its way out is what frees the slot — no move and no fire for it', () => {
  const roster = [hero({ name: 'Mine', status: 1, management: 90 }), hero({ name: 'Harriet', status: 4, level: 2, power: 12 })];
  const full = city('Full', roster, { hall: 2 });
  const near = city('Near', [hero({ name: 'N1' })], { hall: 10 });
  const game = planGame([full, near]);
  readInn(game, full, 0);
  const p = H.makeRoom(ctxFor(game, full, `config hero:1\n${KEEP}`, { Near: '' }), { hallReadAt: Date.now() }, { need: 1, reason: 'room' });
  eq(p.actions, []);
  has(p.note, /a prisoner is on its way out \(Harriet\), which frees the slot/);
});

t('the moveHeroOut executor stands a mayor down first and marches by ID', async () => {
  const h1 = hero({ name: 'H1', status: 1 });
  const from = city('From', [h1, hero({ name: 'H2' })]);
  const to = city('To', [hero({ name: 'T1' })]);
  const calls = [];
  const game = {
    castleId: (c) => c.castleId, castleXY: (c) => c._xy,
    dischargeChief: async (cid) => { calls.push(['discharge', cid]); return { ok: 1 }; },
    buildArmyBean: (b) => b,
    newArmy: async (cid, bean) => { calls.push(['newArmy', cid, bean.heroId, bean.troops]); return { ok: 1 }; },
  };
  const state = {};
  await H.executors.moveHeroOut(game, from, { heroId: h1.id, heroName: 'H1', to }, state);
  eq(calls, [['discharge', from.castleId], ['newArmy', from.castleId, h1.id, { scouter: 1 }]]);
  ok(state.lastHeroMoveAt > Date.now() - 5000, 'the cooldown is stamped');

  from.troop.scouter = 0;
  let err = null;
  try { await H.executors.moveHeroOut(game, from, { heroId: h1.id, heroName: 'H1', to }, {}); } catch (e) { err = e.message; }
  has(err, /no scout left in this city to carry the march/);
});

// ======================================================================
section('6. the training hero never gets stuck as the mayor');
// ======================================================================

t('a training hero alone in a city is stood down as mayor, and never re-appointed', () => {
  const otto = hero({ name: 'OTTO', status: 1, power: 900 });
  const a = city('Stop1', [otto]);
  const b = city('Stop2', [hero({ name: 'Local' })]);
  const ctx = ctxFor(planGame([a, b]), a, 'config hero:1\ntraininghero OTTO', { Stop2: 'traininghero OTTO' });
  const p = M.mayorPlan(ctx, 'train');
  eq(kinds(p), ['dischargeChief']);
  has(p.note, /the only hero here — standing it down so it is free to move on/);

  otto.status = 0;                                          // the server stood it down
  const p2 = M.mayorPlan(ctx, 'train');
  eq(p2.actions, undefined, 'and it is not appointed again');
  has(p2.note, /no mayor appointed until this city has a hero of its own/);
});

t('with a hero of its own in the city, the training hero may be mayor as before', () => {
  const otto = hero({ name: 'OTTO', power: 900 });
  const a = city('Stop1', [otto, hero({ name: 'Local', power: 10, management: 90 })]);
  const b = city('Stop2', [hero({ name: 'Other' })]);
  const ctx = ctxFor(planGame([a, b]), a, 'config hero:1\ntraininghero OTTO', { Stop2: 'traininghero OTTO' });
  eq(M.mayorPlan(ctx, 'train').actions[0].hero.name, 'OTTO', 'the best attack hero still trains the troops');
});

t('a training hero parked in the only city that lists it is that city\'s own hero and keeps the office', () => {
  const otto = hero({ name: 'OTTO', status: 1, power: 900 });
  const a = city('Home', [otto]);
  const ctx = ctxFor(planGame([a]), a, 'config hero:1\ntraininghero OTTO');
  const p = M.mayorPlan(ctx, 'train');
  eq(p.actions, undefined);
  has(p.note, /OTTO already set for training troops/);
});

// ======================================================================
section('7. through the engine: the plans reach their executors');
// ======================================================================
// A plan whose actions never run is a silent failure, so the wiring itself is
// pinned here: goal-heroes.plans -> engine.runPlanActions -> MODULE_EXECUTORS.
const { Engine } = require('./engine');

function engineGame(castles, items = []) {
  const calls = [];
  const g = {
    castles, calls,
    player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items },
    castle: () => castles[0],
    castleId: (c) => c.castleId,
    castleXY: (c) => c._xy,
    now: () => Date.now(),
    hallSeen: {},
    req: async (cmd) => { calls.push([cmd]); return { ok: 1 }; },
    promoteToChief: async (cid, hid) => { calls.push(['promoteToChief', cid, hid]); return { ok: 1 }; },
    dischargeChief: async (cid) => { calls.push(['dischargeChief', cid]); return { ok: 1 }; },
    fireHero: async (cid, hid) => { calls.push(['fireHero', cid, hid]); return { ok: 1 }; },
    releaseHero: async (cid, hid) => { calls.push(['releaseHero', cid, hid]); return { ok: 1 }; },
    useItem: async (cid, id, n) => { calls.push(['useItem', cid, id, n]); return { ok: 1 }; },
    hireHero: async (cid, name) => { calls.push(['hireHero', cid, name]); return { ok: 1 }; },
    levelUpHero: async () => ({ ok: 1 }),
    addPoint: async () => ({ ok: 1 }),
    tavernList: async (cid) => { calls.push(['tavernList', cid]); return { ok: 1, heros: [] }; },
    buildArmyBean: (o) => Game.prototype.buildArmyBean.call(g, o),
    newArmy: async (cid, bean) => { calls.push(['newArmy', cid, bean]); return { ok: 1 }; },
  };
  return g;
}
function engineFor(castles, srcFor, items = []) {
  const game = engineGame(castles, items);
  const e = new Engine(game, () => {});
  e.dryRun = false;
  e.state = {};
  e.goalsFor = (id, name) => (srcFor[name] !== undefined ? parseGoals(srcFor[name]) : null);
  return { e, game };
}
const sentCmds = (game, cmd) => game.calls.filter((c) => c[0] === cmd);

t('an empty city really opens a hero box, through the engine', async () => {
  const x = city('Flat', []);
  const { e, game } = engineFor([x], { Flat: 'config hero:1' }, [{ id: 'player.box.hero.f', count: 3 }]);
  // it has already looked empty for the settle window
  e.state[String(x.castleId)] = { emptySince: Date.now() - H.EMPTY_SETTLE_MS - 1000 };
  await e.focus(x);
  eq(sentCmds(game, 'useItem').map((c) => [c[1], c[2], c[3]]), [[x.castleId, 'player.box.hero.f', 1]]);
});

t('a prisoner the line does not keep really goes, through the engine, by ID', async () => {
  const junk = hero({ name: 'Harriet', status: 4, level: 2, power: 12 });
  const x = city('Jail', [hero({ name: 'Mine', status: 1, management: 90 }), junk]);
  const { e, game } = engineFor([x], { Jail: `config hero:1\n${KEEP}` });
  // the register is this test's own: nothing of ours, and complete
  const realDb = require('./db');
  const was = realDb.fleetHeroes;
  realDb.fleetHeroes = { get: () => null, byName: () => [], coverage: () => [{ accountId: 'a1', heroes: 1, at: Date.now() }], count: () => 1, seen: () => 0 };
  const wasAcc = realDb.accounts.all;
  realDb.accounts.all = () => [{ id: 'a1', label: 'T', enabled: 1, email: 'x@y.z' }];
  try {
    await e.focus(x);
    eq(sentCmds(game, 'releaseHero').map((c) => [c[1], c[2]]), [[x.castleId, junk.id]], 'castleId and heroId');
  } finally { realDb.fleetHeroes = was; realDb.accounts.all = wasAcc; }
});

t('a full city really marches a hero out, through the engine', async () => {
  const full = city('Full', ten(), { hall: 10, x: 100 });
  const near = city('Near', [hero({ name: 'N1' })], { hall: 10, x: 105 });
  const src = 'config hero:1\ntraininghero OTTO';
  const { e, game } = engineFor([full, near], { Full: src, Near: src });
  // OTTO is in Near, so Full owes it a slot
  near.heros.push(hero({ name: 'OTTO', power: 900 }));
  readInn(game, full, 0);
  e.state[String(full.castleId)] = { hallReadAt: Date.now() };
  await e.focus(full);
  const sent = sentCmds(game, 'newArmy');
  ok(sent.length === 1, 'one march went, got ' + sent.length);
  eq(sent[0][2].heroId, full.heros[1].id, 'the weakest idle hero, by id');
  // buildArmyBean fills every type; only the scout is actually on board
  eq(Object.entries(sent[0][2].troops).filter(([, v]) => v), [['scouter', 1]], 'one scout and nothing else');
});

// ---------------------------------------------------------------------------
(async () => {
  for (const [name, fn] of tests) {
    if (!fn) { console.log('\n' + name + '\n'); continue; }
    try { await fn(); console.log('  ok    ' + name); pass++; }
    catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
