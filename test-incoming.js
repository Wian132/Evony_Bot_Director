'use strict';
// Goal defence sees incoming attacks — offline, through the real code path.
//
// A fake game emits server.EnemyArmysUpdate the way the server does: the WHOLE
// account's hostile list and nothing else, no castle id (EnemyArmysUpdate.as).
// The engine has to file each army under the city it marches on, hand the
// per-type troop counts to the war goals, run hiding and the gate first and
// outside the action budget, and say when it next needs to look. Nothing here
// connects or logs in.
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');

// Point db.js at a throwaway file BEFORE requiring anything that opens it.
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-incoming-')), 't.db');

const C = require('./constants');
const D = require('./db');
const { Game } = require('./game');
const { Engine, inboundArmy, incomingByCity, WAKE_SLACK_MS } = require('./engine');
const W = require('./goal-war');
const NPC = require('./goal-npc');
const { parseGoals } = require('./goals');
const { Session } = require('./session');

const tests = [];
const t = (name, fn) => tests.push({ name, fn });
const section = (s) => tests.push({ section: s });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 3000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(10); }
};

// ================================================================== fixtures
// The server clock. Fixed unless a test lets it run (clock.fn), and never the
// same as Date.now(), so every wake time below also proves the conversion
// from server time to local time.
const NOW0 = 1789000000000;
const clock = { t: NOW0, fn: null };
const serverNow = () => (clock.fn ? clock.fn() : clock.t);
const resetClock = () => { clock.t = NOW0; clock.fn = null; };

const XY = { home: { x: 200, y: 300 }, refuge: { x: 210, y: 305 }, near: { x: 204, y: 302 }, far: { x: 215, y: 311 } };

function city(id, name, xy, over = {}) {
  return {
    id, name, fieldId: C.coordsToFieldId(xy.x, xy.y), goOutForBattle: false,
    heros: [{ id: id * 10 + 1, name: `${name}Hider`, status: 0, power: 120, management: 40 }],
    troop: { archer: 50000, pikemen: 10000, scouter: 500, lightCavalry: 2000 },
    resource: {
      food: { amount: 20e6 }, wood: { amount: 4e6 }, stone: { amount: 3e6 }, iron: { amount: 2e6 },
      gold: 500000, support: 100, curPopulation: 50000, maxPopulation: 60000, workPeople: 1000, buildPeople: 0,
    },
    fortification: {}, buildings: [],
    ...over,
  };
}

// A Game stand-in: the castles, a clock, and every command recorded instead of
// sent. `push` is the server pushing the hostile army list.
function world({ cities, enemyAtLogin = [] } = {}) {
  const c = new EventEmitter();
  c.sock = { destroyed: false };
  const sent = [];
  const game = {
    c, castles: cities, sent,
    player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: enemyAtLogin, items: [] },
    now: serverNow,
    castleId: (x) => x.id,
    castleXY: (x) => (x.fieldId !== undefined ? C.fieldIdToCoords(x.fieldId) : null),
    marchSkillParam: 100,
    buildArmyBean: Game.prototype.buildArmyBean,
    newArmy: async (castleId, bean) => { sent.push(['army.newArmy', { castleId, newArmyBean: bean }]); return { ok: 1 }; },
    req: async (cmd, data) => { sent.push([cmd, data]); return { ok: 1 }; },
    // defence items take the real routing (game.js useDefenceItem) down to req,
    // so `sent` shows the command each one goes out as
    useDefenceItem: Game.prototype.useDefenceItem, useTruce: Game.prototype.useTruce,
    useItem: Game.prototype.useItem, useCastleItem: Game.prototype.useCastleItem,
    dischargeChief: async (cid) => { sent.push(['dischargeChief', { cid }]); return { ok: 1 }; },
    promoteToChief: async (cid, heroId) => { sent.push(['promoteToChief', { cid, heroId }]); return { ok: 1 }; },
  };
  const push = (armys) => c.emit('cmd', 'server.EnemyArmysUpdate', { armys });
  return { game, push, sent };
}

// An ArmyBean as the server sends it: troop counts are STRINGS under `troop`
// (TroopStrBean), reachTime is absolute server-epoch ms, and nothing names the
// city except targetFieldId.
let seq = 900;
function army(to, { inMs = 90000, troop = { archer: '200000' }, direction = 1, missionType = C.MISSION.attack,
  king = 'Raider', armyId, targetFieldId } = {}) {
  return {
    armyId: armyId ?? seq++, missionType, direction, king, alliance: 'Foes', hero: 'Brute', heroLevel: 40,
    startPosName: 'Raider City', startFieldId: C.coordsToFieldId(150, 250),
    targetFieldId: targetFieldId ?? to.fieldId, targetPosName: to && to.name,
    startTime: serverNow() - 600000, reachTime: serverNow() + inMs, restTime: 0,
    resource: { food: 0, wood: 0, stone: 0, iron: 0, gold: 0 },
    troop,
  };
}

// An engine over the world, with goals per castle id instead of the database.
function engineFor(w, goalsById, { live = false } = {}) {
  const lines = [];
  const e = new Engine(w.game, (m, meta) => lines.push({ m: String(m), ...(meta || {}) }), 'test');
  e.dryRun = !live;
  e.state = {};
  e.goalsFor = (id) => (goalsById[id] !== undefined ? parseGoals(goalsById[id]) : null);
  return { e, lines };
}

// Catch the ctx the engine builds for a city, as every plan sees it.
async function ctxOf(e, castle) {
  const seen = [];
  W.plans.__spy = (ctx) => { seen.push(ctx); return null; };
  try { await e.focus(castle); } finally { delete W.plans.__spy; }
  return seen[0];
}

const names = (sent) => sent.map(([cmd]) => cmd);
const wakeIn = (e) => { const at = e.nextWakeAt(); return at === null ? null : at - Date.now(); };
const near = (got, want, slack = 120) => assert.ok(got !== null && Math.abs(got - want) <= slack, `expected about ${want} ms, got ${got}`);

// ================================================================== 1. the push
section('the push as the server sends it');

t('server.EnemyArmysUpdate carries no castle id: each army is filed under the city it marches on', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, {});
  w.push([army(home), army(home, { troop: { scouter: '5000' } }), army(refuge)]);
  const inc = e.incomingFor();
  assert.deepStrictEqual(Object.keys(inc).sort(), ['101', '202']);
  assert.strictEqual(inc[101].length, 2);
  assert.strictEqual(inc[202].length, 1);
  assert.ok(!('undefined' in inc), 'nothing may be filed under "undefined" any more');
});

t('an attack on one of our valleys, or on somebody else, is no city\'s', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, {});
  w.push([army(null, { targetFieldId: C.coordsToFieldId(201, 301) }), army(null, { targetFieldId: C.coordsToFieldId(5, 5) })]);
  assert.deepStrictEqual(e.incomingFor(), { 101: [] });
});

t('armies heading home (direction 2) or encamped (3) are not inbound', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, {});
  const noDir = army(home, { armyId: 4 });
  delete noDir.direction;
  w.push([army(home, { direction: 2, armyId: 1 }), army(home, { direction: 3, armyId: 2 }), army(home, { direction: 1, armyId: 3 }), noDir]);
  assert.deepStrictEqual(e.incomingFor()[101].map((a) => a.armyId).sort(), [3, 4]);
});

t('the per-type TroopStrBean is kept as sent, beside its total', async () => {
  const a = inboundArmy({ armyId: 1, reachTime: 5, troop: { scouter: '400000', militia: '10' }, king: 'K', alliance: 'A' });
  assert.deepStrictEqual(a.troop, { scouter: '400000', militia: '10' });
  assert.strictEqual(a.troops, 400010);
  assert.strictEqual(a.known, true);
  assert.strictEqual(a.king, 'K');
  const unscouted = inboundArmy({ troop: { archer: '?', ballista: '?' } });
  assert.strictEqual(unscouted.troops, null, 'unscouted is unknown, never 0');
  assert.strictEqual(unscouted.known, false);
});

t('each push replaces the whole list, as the client does (Context.as:403)', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, {});
  w.push([army(home)]);
  assert.strictEqual(e.incomingFor()[101].length, 1);
  w.push([]);
  assert.strictEqual(e.incomingFor()[101].length, 0);
});

t('a changed list is logged once per city, not once per push', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e, lines } = engineFor(w, {});
  const a = army(home, { inMs: 240000 });
  w.push([a]);
  w.push([a]);            // another army elsewhere changed: same picture here
  const said = lines.filter((l) => /incoming:/.test(l.m));
  assert.strictEqual(said.length, 1, said.map((l) => l.m).join(' | '));
  assert.strictEqual(said[0].city, 'Home');
  assert.match(said[0].m, /1 hostile army\(ies\), the first lands in 4m/);
});

// ================================================================ 2. ctx per city
section('each city\'s goals see its own attackers');

t('focus hands a city only the armies marching on it; incomingByCastle is keyed by castle id', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: 'config hero:0', 202: 'config hero:0' });
  w.push([army(home), army(home), army(refuge)]);
  const ctx = await ctxOf(e, home);
  assert.strictEqual(ctx.incoming.length, 2);
  assert.deepStrictEqual(ctx.incomingByCastle, { 101: 2, 202: 1 });
  assert.ok(ctx.incoming[0].troop && ctx.incoming[0].troop.archer === '200000', 'the per-type counts reach the plans');
  assert.strictEqual((await ctxOf(e, refuge)).incoming.length, 1);
});

t('an attack already on its way at login counts before any push arrives', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home], enemyAtLogin: [army(home)] });
  const { e } = engineFor(w, { 101: 'config hero:0' });
  assert.strictEqual((await ctxOf(e, home)).incoming.length, 1, 'the login list was ignored');
  w.push([]);             // the first push is the whole truth from then on
  assert.strictEqual((await ctxOf(e, home)).incoming.length, 0);
});

t('the console path: a push that came before the engine existed is seen through the player bean', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const s = new Session();
  s.note = () => {};
  s.wire(w.game);                                   // the console's own push handling
  w.push([army(home, { armyId: 77 })]);            // before any engine is built
  const { e } = engineFor(w, { 101: 'config hero:0' });
  assert.deepStrictEqual((await ctxOf(e, home)).incoming.map((a) => a.armyId), [77]);
});

// ===================================================================== 3. hiding
section('hiding on a real inbound wave');

t('hiding launches on a wave the server pushed, to the other city', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: 'config hiding:2,hero:0', 202: 'config hero:0' }, { live: true });
  w.push([army(home, { inMs: 90000 })]);
  const r = await e.focus(home);
  const march = w.sent.find(([cmd]) => cmd === 'army.newArmy');
  assert.ok(march, `no hide march: ${r.hiding && r.hiding.note}`);
  assert.strictEqual(march[1].castleId, 101);
  assert.strictEqual(march[1].newArmyBean.targetPoint, refuge.fieldId);
  assert.ok(e.state[101].war.hide, 'the hide march was not recorded');
  assert.match(r.hiding.note, /launching/);
});

t('hiding runs to the city that is NOT under attack, even when it is further', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), nearC = city(202, 'Near', XY.near), farC = city(303, 'Far', XY.far);
  const w = world({ cities: [home, nearC, farC] });
  const { e } = engineFor(w, { 101: 'config hiding:2,hero:0' }, { live: true });
  w.push([army(home, { inMs: 90000 }), army(nearC, { inMs: 600000 })]);
  await e.focus(home);
  const march = w.sent.find(([cmd]) => cmd === 'army.newArmy');
  assert.strictEqual(march[1].newArmyBean.targetPoint, farC.fieldId);
});

t('a wave under defensepolicy /junktroop is junk to hiding too; the default line is 1000', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const small = [army(home, { inMs: 90000, troop: { archer: '3000' } })];
  const { e } = engineFor(w, { 101: 'config hiding:2,hero:0\ndefensepolicy /junktroop:5000' }, { live: true });
  w.push(small);
  const r = await e.focus(home);
  assert.ok(!names(w.sent).includes('army.newArmy'), 'hid from a junk wave');
  assert.match(r.hiding.note, /1 junk ignored/);
  const w2 = world({ cities: [city(101, 'Home', XY.home), city(202, 'Refuge', XY.refuge)] });
  const { e: e2 } = engineFor(w2, { 101: 'config hiding:2,hero:0' }, { live: true });
  w2.push([army(w2.game.castles[0], { inMs: 90000, troop: { archer: '3000' } })]);
  await e2.focus(w2.game.castles[0]);
  assert.ok(names(w2.sent).includes('army.newArmy'), '3,000 is over the default 1,000');
});

t('an unscouted wave ("?") is a real threat, never junk', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: 'config hiding:2,hero:0\ndefensepolicy /junktroop:5000' }, { live: true });
  w.push([army(home, { inMs: 90000, troop: { archer: '?', lightCavalry: '?' } })]);
  await e.focus(home);
  assert.ok(names(w.sent).includes('army.newArmy'));
});

// ======================================================================= 4. gate
section('gatepolicy tells a scout bomb from a regular wave');

const gateGoals = (policy) => `config gate:1,hero:0\ngatepolicy ${policy}`;
const gateSent = (w) => w.sent.filter(([cmd]) => cmd === 'army.setArmyGoOut').map(([, d]) => d.isArmyGoOut);

t('a scout bomb opens the gate under gatepolicy 0 2 1 2 0', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: gateGoals('0 2 1 2 0') }, { live: true });
  w.push([army(home, { inMs: 30000, troop: { scouter: '400000', militia: '10' } })]);
  const r = await e.focus(home);
  assert.deepStrictEqual(gateSent(w), [true]);
  assert.match(r.gate.note, /gate: scoutbomb/);
});

t('a regular wave closes it', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home, { goOutForBattle: true });
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: gateGoals('0 2 1 2 0') }, { live: true });
  w.push([army(home, { inMs: 30000, troop: { archer: '100000', ballista: '2000' } })]);
  const r = await e.focus(home);
  assert.deepStrictEqual(gateSent(w), [false]);
  assert.match(r.gate.note, /gate: regular/);
});

t('a scout bomb and a regular wave in the same window are "mixed"', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home, { goOutForBattle: true });
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: gateGoals('0 1 1 2 0') }, { live: true });
  w.push([army(home, { inMs: 30000, troop: { scouter: '400000' } }), army(home, { inMs: 40000, troop: { archer: '90000' } })]);
  const r = await e.focus(home);
  assert.deepStrictEqual(gateSent(w), [false]);
  assert.match(r.gate.note, /gate: mixed \(2 wave/);
});

t('an unscouted wave is regular, never a scout bomb', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: gateGoals('0 1 2 2 0') }, { live: true });
  w.push([army(home, { inMs: 30000, troop: { scouter: '?', archer: '?' } })]);
  const r = await e.focus(home);
  assert.deepStrictEqual(gateSent(w), [true], 'regular -> open under this policy');
  assert.match(r.gate.note, /gate: regular/);
});

t('/scoutratio sets where a scout-heavy wave becomes a scout bomb', async () => {
  resetClock();
  const wave = { scouter: '60000', archer: '40000' };
  const w1 = world({ cities: [city(101, 'Home', XY.home)] });
  const { e: e1 } = engineFor(w1, { 101: gateGoals('0 2 1 2 0') });
  w1.push([army(w1.game.castles[0], { inMs: 30000, troop: wave })]);
  assert.match((await e1.focus(w1.game.castles[0])).gate.note, /gate: regular/, '60% scouts is under the 0.9 default');
  const w2 = world({ cities: [city(101, 'Home', XY.home)] });
  const { e: e2 } = engineFor(w2, { 101: gateGoals('0 2 1 2 0 /scoutratio:0.5') });
  w2.push([army(w2.game.castles[0], { inMs: 30000, troop: wave })]);
  assert.match((await e2.focus(w2.game.castles[0])).gate.note, /gate: scoutbomb/);
});

t('a junk poke never reaches the gate', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: gateGoals('0 1 1 1 0') });
  w.push([army(home, { inMs: 30000, troop: { scouter: '500' } })]);
  assert.match((await e.focus(home)).gate.note, /gate: noattack/);
});

// ============================================================ 5. order and budget
section('hiding and the gate go first, outside the budget');

const BUSY = [
  'config hiding:2,gate:1,comfort:1',
  'comfortpolicy 15 16 popraise',
  'defensepolicy /usewarhorn:1 /usecorselet:1 /usepenicillin:1',
  'gatepolicy 0 1 1 1 0',
].join('\n');

// defensepolicy uses only what the account holds (Step 3)
const DEFENCE_STOCK = () => ['warhorn', 'corselet', 'penicillin'].map((k) => ({ id: C.DEFENSE_ITEMS[k], count: 1 }));

t('comfort and three defence items cannot crowd out the hide march or the gate', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  w.game.player.items = DEFENCE_STOCK();
  const { e } = engineFor(w, { 101: BUSY, 202: 'config hero:0' }, { live: true });
  w.push([army(home, { inMs: 50000 })]);
  const r = await e.focus(home);
  assert.deepStrictEqual(names(w.sent), [
    'army.newArmy', 'army.setArmyGoOut',                   // first, and free
    'interior.pacifyPeople', 'shop.useGoods', 'shop.useGoods', // the 3-action budget, unchanged
  ], r.acted.join(' | '));
  assert.strictEqual(w.sent[1][1].isArmyGoOut, true);
  assert.match(r.acted[0], /^hide .* -> ok$/);
  assert.match(r.acted[1], /^open the gate \(regular\) -> ok$/);
});

t('the mayor is left alone in the slice the hide march took its hero', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: BUSY, 202: 'config hero:0' }, { live: true });
  w.push([army(home, { inMs: 50000 })]);
  const r = await e.focus(home);
  assert.ok(!names(w.sent).includes('promoteToChief'), 'appointed the hero that just marched out');
  assert.match(r.mayor.note, /held this slice/);
});

t('a dry run lists them first too', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: BUSY, 202: 'config hero:0' });
  w.push([army(home, { inMs: 50000 })]);
  const r = await e.focus(home);
  assert.match(r.acted[0], /^\[plan\] hide /);
  assert.match(r.acted[1], /^\[plan\] open the gate/);
  assert.strictEqual(w.sent.length, 0);
});

// ============================================================ 6. the war clock
section('nextWakeAt: when the war goals next need a look');

t('config hiding:0.5 wakes 30 s before the wave lands', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: 'config hiding:0.5,hero:0' });
  await e.focus(home);
  assert.strictEqual(e.nextWakeAt(), null, 'nothing inbound, nothing to wake for');
  w.push([army(home, { inMs: 100000 })]);
  near(wakeIn(e), 70000 + WAKE_SLACK_MS);
});

t('config gate:0.1 wakes 6 s before, and again safely after the wave has landed', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: gateGoals('0 1 1 1 0').replace('gate:1', 'gate:0.1') }, { live: true });
  await e.focus(home);
  w.push([army(home, { inMs: 20000 })]);
  near(wakeIn(e), 14000 + WAKE_SLACK_MS);
  clock.t += 14000 + WAKE_SLACK_MS;                      // the timer fires
  await e.tick({ urgent: true });
  assert.deepStrictEqual(gateSent(w), [true], 'the gate did not open inside its 6 s window');
  // the landing is 5.75 s away; the next look is 3 s after it, never at impact
  near(wakeIn(e), 5750 + 3000 + WAKE_SLACK_MS);
});

t('the push that follows the battle brings the gate back without waiting', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: gateGoals('2 1 1 1 0 /mintoggle:0').replace('gate:1', 'gate:0.1') }, { live: true });
  await e.focus(home);
  const wave = army(home, { inMs: 5000 });
  w.push([wave]);
  await e.tick({ urgent: true });                        // inside the window: open
  assert.deepStrictEqual(gateSent(w), [true]);
  clock.t += 1500;                                       // the wave lands and turns for home
  w.push([{ ...wave, direction: 2 }]);
  const d = wakeIn(e);
  assert.ok(d !== null && d <= 50, `the post-battle push should wake at once, got ${d}`);
  await e.tick({ urgent: true });
  assert.deepStrictEqual(gateSent(w), [true, false], 'the gate stayed open after the wave');
});

t('with the default /mintoggle the gate comes back as soon as its 10 s hold ends', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: gateGoals('2 1 1 1 0').replace('gate:1', 'gate:0.1') }, { live: true });
  await e.focus(home);
  const wave = army(home, { inMs: 5000 });
  w.push([wave]);
  await e.tick({ urgent: true });
  clock.t += 5500;
  w.push([{ ...wave, direction: 2 }]);
  near(wakeIn(e), 10000 - 5500 + WAKE_SLACK_MS);
});

t('the earliest moment across cities wins', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: 'config hiding:2,hero:0', 202: gateGoals('0 1 1 1 0') });
  await e.tick();
  w.push([army(home, { inMs: 600000 }), army(refuge, { inMs: 300000 })]);
  near(wakeIn(e), 240000 + WAKE_SLACK_MS);               // Refuge's gate, 1 min before its wave
});

t('a wave already inside its lead window wakes at once', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: 'config hiding:0.5,hero:0' });
  await e.focus(home);                                   // looked at a moment ago...
  w.push([army(home, { inMs: 20000 })]);                 // ...then fast cavalry shows up
  const d = wakeIn(e);
  assert.ok(d !== null && d <= 50, `expected now, got ${d}`);
});

t('once the hide march is out, the next wake is its early recall', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: 'config hiding:2,hero:0' }, { live: true });
  w.push([army(home, { inMs: 90000 })]);
  await e.focus(home);
  const hide = e.state[101].war.hide;
  assert.ok(hide, 'no hide march');
  near(wakeIn(e), hide.forImpactAt + 5 * 60000 + WAKE_SLACK_MS - serverNow());
});

t('a moment already looked at is spent: a launch that cannot happen does not spin', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home, { heros: [{ id: 9, name: 'Mayor', status: 1 }] });   // no idle hero
  const w = world({ cities: [home, city(202, 'Refuge', XY.refuge)] });
  const { e } = engineFor(w, { 101: 'config hiding:2,hero:0' }, { live: true });
  w.push([army(home, { inMs: 90000 })]);
  assert.ok(wakeIn(e) === null, 'no goals read yet: nothing to wake for');
  await e.tick({ urgent: true });
  assert.ok(!names(w.sent).includes('army.newArmy'));
  assert.strictEqual(e.nextWakeAt(), null, 'the refused launch would wake the engine again and again');
});

t('junk, a city without goals and hiding switched off give no moments', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: 'config hiding:2,hero:0\ndefensepolicy /junktroop:5000', 202: 'config hiding:0' });
  await e.tick();
  w.push([army(home, { inMs: 600000, troop: { archer: '4000' } }), army(refuge, { inMs: 600000 })]);
  assert.strictEqual(e.nextWakeAt(), null);
});

t('a manual gate on the console needs no wake', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: gateGoals('0 1 1 1 0') });
  e.controlsFor = () => ({ gate: 'closed', wartown: 'auto' });
  await e.focus(home);
  w.push([army(home, { inMs: 600000 })]);
  assert.strictEqual(e.nextWakeAt(), null);
});

// ============================================================ 7. the war pass
section('the war pass between ticks');

t('tick({ urgent: true }) runs hiding and the gate and nothing else', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home, { buildings: [{ typeId: 2, positionId: 4, level: 10, status: 0 }] });
  const refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const goals = [BUSY, 'troop a:100k', 'build f:10:37'].join('\n');
  const { e, lines } = engineFor(w, { 101: goals, 202: 'config hero:0' }, { live: true });
  w.push([army(home, { inMs: 50000 })]);
  await e.tick({ urgent: true });
  assert.deepStrictEqual(names(w.sent), ['army.newArmy', 'army.setArmyGoOut'], 'the war pass did more than defend');
  assert.ok(lines.some((l) => l.city === 'Home' && l.kind === 'act' && /^hide .* -> ok$/.test(l.m)), 'the hide march was not logged');
});

t('the console\'s engine view shows the war pass\'s latest word', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: 'config hiding:2,hero:0', 202: 'config hero:0' }, { live: true });
  await e.tick();
  assert.match(e.lastReport[101].hiding.note, /nothing inbound/);
  w.push([army(home, { inMs: 90000 })]);
  await e.tick({ urgent: true });
  assert.match(e.lastReport[101].hiding.note, /launching/);
  assert.ok(e.lastReport[101].acted.some((a) => /^hide .* -> ok$/.test(a)));
});

// ========================================================= 8. the console's timer
section('the console arms one timer for the next war moment');

function consoleWith(wake, { tickMs = 0, warMs = 0 } = {}) {
  const c = new EventEmitter();
  c.sock = { destroyed: false };
  const s = new Session();
  s.account = { id: 'test', label: 'T' };
  s.game = { c, castles: [], player: {}, castleId: (x) => x.id, now: () => Date.now() };
  s.note = () => {};
  const calls = [];
  s.engine = {
    game: s.game, accountId: 'test', state: {},
    async tick(opts = {}) {
      const call = { urgent: !!opts.urgent, start: Date.now() };
      calls.push(call);
      await sleep(opts.urgent ? warMs : tickMs);
      call.end = Date.now();
    },
    nextWakeAt: () => wake(calls),
  };
  return { s, calls };
}

t('a tick arms a one-shot war pass at the moment nextWakeAt names', async () => {
  const at = Date.now() + 150;
  const { s, calls } = consoleWith((cs) => (cs.some((c) => c.urgent) ? null : at));
  s.startEngine({ tickMs: 3600000 });
  try {
    assert.strictEqual(await s.engineTick(), true);
    await sleep(450);
    assert.deepStrictEqual(calls.map((c) => c.urgent), [false, true]);
    assert.ok(calls[1].start >= at - 5, `the war pass ran ${at - calls[1].start} ms early`);
    assert.strictEqual(s._wakeTimer, null, 'a timer was left armed with nothing to wake for');
  } finally { s.stopEngine(); }
});

t('never two war passes within a second, however often the engine asks', async () => {
  const { s, calls } = consoleWith(() => Date.now());          // always due
  s.startEngine({ tickMs: 3600000 });
  try {
    await s.engineTick();
    await sleep(2400);
    const war = calls.filter((c) => c.urgent);
    assert.ok(war.length >= 2 && war.length <= 3, `${war.length} war passes in 2.4 s`);
    for (let i = 1; i < war.length; i++) assert.ok(war[i].start - war[i - 1].end >= 950, 'two war passes less than a second apart');
  } finally { s.stopEngine(); }
});

t('a wake that finds the engine paused is dropped; the next tick re-arms', async () => {
  let at = Date.now() + 100;
  const { s, calls } = consoleWith((cs) => (cs.some((c) => c.urgent) ? null : at));
  s.startEngine({ tickMs: 3600000 });
  try {
    await s.engineTick();
    s.userPaused = true;
    await sleep(250);
    assert.ok(!calls.some((c) => c.urgent), 'a war pass ran while paused');
    assert.strictEqual(s._wakeTimer, null, 're-armed while paused');
    s.userPaused = false;
    at = Date.now() + 100;
    await s.engineTick();
    await sleep(250);
    assert.ok(calls.some((c) => c.urgent), 'the next tick did not re-arm');
  } finally { s.stopEngine(); }
});

t('a wake that finds a tick running goes as soon as the tick ends', async () => {
  const at = Date.now() + 50;
  const { s, calls } = consoleWith((cs) => (cs.some((c) => c.urgent) ? null : at), { tickMs: 300 });
  s.startEngine({ tickMs: 3600000 });
  try {
    const running = s.engineTick();
    s.armWake();                                         // a hostile push mid-tick
    await running;
    await sleep(100);
    assert.deepStrictEqual(calls.map((c) => c.urgent), [false, true]);
    assert.ok(calls[1].start >= calls[0].end, 'overlapping passes');
    assert.ok(calls[1].start - calls[0].end < 60, 'the war pass waited for something else');
  } finally { s.stopEngine(); }
});

t('a regular tick held up by a war pass runs straight after it', async () => {
  const { s, calls } = consoleWith(() => null, { warMs: 200 });
  s.startEngine({ tickMs: 3600000 });
  try {
    const war = s.engineTick({ urgent: true });
    assert.strictEqual(await s.engineTick(), false, 'two passes at once');
    await war;
    await sleep(100);
    assert.deepStrictEqual(calls.map((c) => c.urgent), [true, false]);
    assert.ok(calls[1].start >= calls[0].end);
  } finally { s.stopEngine(); }
});

t('nothing is armed further out than the next regular tick', async () => {
  const { s } = consoleWith(() => Date.now() + 2 * 3600000);
  s.startEngine({ tickMs: 60000 });
  try {
    assert.strictEqual(s.armWake(), null);
    assert.ok(!s._wakeTimer, 'a two-hour timer was armed');
  } finally { s.stopEngine(); }
});

t('end to end: a hostile push re-arms the console and the hide march leaves in time', async () => {
  resetClock();
  clock.fn = () => Date.now() + 7777;                    // a running server clock, 7.8 s ahead
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  D.goals.set('test', '101', 'goal', 'config hiding:0.5,hero:0');
  D.goals.set('test', '202', 'goal', 'config hero:0');
  const s = new Session();
  s.account = { id: 'test', label: 'T' };
  const lines = [];
  s.note = (m, meta) => lines.push(String(m));
  s.wire(w.game);
  s.game = w.game;
  s.startEngine({ tickMs: 3600000 });
  try {
    assert.strictEqual(await s.engineTick(), true, 'the first tick did not run');
    assert.ok(s.engine && s.engine.game === w.game, 'no real engine');
    const wave = army(home, { inMs: 30000 + 400 });     // its 30 s window opens in 0.4 s
    w.push([wave]);
    assert.ok(s._wakeTimer, 'the push did not arm a war pass');
    await until(() => names(w.sent).includes('army.newArmy'), 3000, 'the hide march');
    const left = wave.reachTime - serverNow();
    assert.ok(left > 28000 && left <= 30000, `the march left ${left} ms before impact`);
    assert.ok(lines.some((l) => /^hide .* -> ok$/.test(l)), lines.join(' | '));
  } finally { s.stopEngine(); resetClock(); }
});

// ================================================================ 9. hiding food
section('hiding food is charged twice, as the client charges it');

t('C.marchFood charges each troop twice its upkeep per hour, march and camp alike', async () => {
  assert.strictEqual(C.marchFoodPerHour({ archer: 1000, scouter: 10 }), 9 * 2 * 1000 + 5 * 2 * 10);
  assert.strictEqual(C.marchFood({ archer: 1000, scouter: 10 }, 30 * 60000, 60 * 60000), 18100 * 1.5);
  assert.strictEqual(C.marchFoodPerHour({ archer: '?', bogus: 5 }), 0, 'junk is not food');
});

t('npc farming and hiding charge through the same helper', async () => {
  assert.strictEqual(NPC._internals.marchFoodOf({ ballista: 550 }, 3600000), 55000);
  assert.strictEqual(NPC._internals.marchFoodOf({ ballista: 550 }, 3600000), C.marchFood({ ballista: 550 }, 3600000));
});

// A pure hiding plan for Home -> Refuge: a wave now and a wave 55 min out, so
// the march has a long camp to feed.
function hidePlan(food) {
  resetClock();
  const home = city(101, 'Home', XY.home, { resource: { ...city(1, 'x', XY.home).resource, food: { amount: food } } });
  const refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const inc = incomingByCity(w.game, [army(home, { inMs: 90000, armyId: 1 }), army(home, { inMs: 55 * 60000, armyId: 2 })]);
  const parsed = parseGoals('config hiding:2');
  const ctx = { game: w.game, castle: home, goals: parsed.goals, config: parsed.config, incoming: inc[101], incomingByCastle: { 101: 2, 202: 0 } };
  const p = W.plans.hiding(ctx, {});
  const a = p.actions[0];
  const oneWay = a && C.marchTimeMs(C.fieldIdToCoords(home.fieldId), C.fieldIdToCoords(refuge.fieldId), Object.keys(a.troops), 100);
  return { p, a, oneWay, budget: Math.floor(food * 0.9) };
}

t('the hide march reserves twice the upkeep for the march and the camp', async () => {
  const { a, oneWay, budget } = hidePlan(20e6);
  assert.ok(a && a.restSec > 600, 'the fixture should camp for a while');
  const need = C.marchFood(a.troops, oneWay, a.restSec * 1000);
  assert.ok(need <= budget);
  const carried = Object.values(a.resources).reduce((s, v) => s + v, 0);
  const loads = Object.entries(a.troops).reduce((s, [k, v]) => s + v * C.BY_KEY[k].load, 0);
  assert.ok(carried + need <= loads + 1, 'the cargo does not leave room for the food the client loads');
});

t('a city that could feed the camp at 1x but not at 2x gets its camp cut to fit', async () => {
  const full = hidePlan(20e6);
  const need2 = C.marchFood(full.a.troops, full.oneWay, full.a.restSec * 1000);
  const food = Math.ceil((need2 * 0.75) / 0.9);            // 1.5x the old 1x figure
  const cut = hidePlan(food);
  assert.ok(cut.a, cut.p.note);
  assert.ok(cut.a.restSec < full.a.restSec, `camp not cut: ${cut.a.restSec}s`);
  assert.ok(C.marchFood(cut.a.troops, cut.oneWay, cut.a.restSec * 1000) <= cut.budget);
  assert.match(cut.p.note, /encamp time cut/);
});

// ============================================== 10. defensepolicy and warrules
section('defensepolicy and warrules see real attacks');

const A1 = [
  '// Lord22 build-up',
  'config comfort:1,hero:1,troopsusepopmax:1',
  'comfortpolicy 15 16 popraise',
  'defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1',
  'build f:10:37,s:0:0,i:0:0,q:0:0',
  'troop b:5k,t:5k',
  'troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k',
  'troop a:100k,s:100k',
  'fortification ab:5000',
].join('\n');

t('the live defensepolicy line: a real attack now brings out the horn, corselet and penicillin', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  w.game.player.items = DEFENCE_STOCK();
  const { e } = engineFor(w, { 101: A1 });
  w.push([army(home, { inMs: 600000, troop: { archer: '6000' } })]);
  const r = await e.focus(home);
  assert.match(r.defense.note, /loyalty 100, 1 real attack\(s\) inbound/);
  assert.deepStrictEqual(r.defense.actions.map((a) => a.itemId),
    [C.DEFENSE_ITEMS.warhorn, C.DEFENSE_ITEMS.corselet, C.DEFENSE_ITEMS.penicillin]);
  assert.ok(r.acted.includes('[plan] War Horn (under attack)'), r.acted.join(' | '));
});

// NEAT: a junk attack sets off no defensive measure, defensepolicy included, so
// even at a loyalty under /usetruce it brings out nothing (Step 3).
t('...but a wave under its /junktroop:5000 is junk: nothing is used, even at low loyalty', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  w.game.player.items = [...DEFENCE_STOCK(), { id: C.DEFENSE_ITEMS.truce, count: 1 }];
  const { e } = engineFor(w, { 101: A1 });
  w.push([army(home, { inMs: 600000, troop: { archer: '4000' } })]);
  const r = await e.focus(home);
  assert.match(r.defense.note, /0 real attack\(s\) inbound \(1 junk under 5000 ignored\)/);
  assert.deepStrictEqual(r.defense.actions, []);
  home.resource.support = 50;
  const low = await e.focus(home);
  assert.deepStrictEqual(low.defense.actions, []);
  assert.match(low.defense.note, /truce: loyalty 50 <= 79, but not under attack/);
});

t('defensepolicy counts only the attacks on its own city', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home), refuge = city(202, 'Refuge', XY.refuge);
  const w = world({ cities: [home, refuge] });
  const { e } = engineFor(w, { 101: A1, 202: A1 });
  w.push([army(refuge, { inMs: 600000, troop: { archer: '60000' } })]);
  assert.match((await e.focus(home)).defense.note, /0 real attack/);
  assert.match((await e.focus(refuge)).defense.note, /1 real attack/);
});

t('warrules tells the alliance on the first real attack, naming the attacker', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: 'config warrules:1,hero:0' });
  w.push([army(home, { inMs: 90000, king: 'Vandal' })]);
  const r = await e.focus(home);
  assert.ok(r.acted.includes('[plan] alliance chat: [war] Home (200,300): 1 incoming, first in 01:30 from Vandal'), r.acted.join(' | '));
});

t('warrules pacing: a quiet attack gets a reminder every 5X, a change an update after X', async () => {
  resetClock();
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: 'config warrules:1,hero:0' }, { live: true });
  const chats = () => w.sent.filter(([cmd]) => cmd === 'common.allianceChat').length;
  const first = army(home, { inMs: 30 * 60000 });
  w.push([first]);
  await e.focus(home);
  assert.strictEqual(chats(), 1, 'no first alert');
  clock.t += 2 * 60000;                                  // same picture, two minutes on
  const quiet = await e.focus(home);
  assert.strictEqual(chats(), 1, 'posted an "update" about nothing new');
  assert.match(quiet.warrules.note, /next reminder in/);
  clock.t += 3 * 60000 + 1000;                           // past 5X since the alert
  await e.focus(home);
  assert.strictEqual(chats(), 2, 'no reminder at 5X');
  clock.t += 61000;                                      // a second wave appears
  w.push([first, army(home, { inMs: 20 * 60000 })]);
  await e.focus(home);
  assert.strictEqual(chats(), 3, 'a real change was not posted after X');
});

// ================================================================= 11. live goals
section('the live goals');

t('the live a1/a2 lines still parse, and none of them wakes the engine early', async () => {
  resetClock();
  assert.deepStrictEqual(parseGoals(A1).errors, []);
  const home = city(101, 'Home', XY.home);
  const w = world({ cities: [home] });
  const { e } = engineFor(w, { 101: A1 });
  await e.focus(home);
  w.push([army(home, { inMs: 60000, troop: { archer: '90000' } })]);
  assert.strictEqual(e.nextWakeAt(), null, 'no hiding or gate goal is set on the live cities');
  const r = await e.focus(home);
  assert.ok(!r.hiding && !r.gate && !r.warrules, 'a war goal appeared that the live goals do not ask for');
});

// ==================================================================== runner
(async () => {
  let pass = 0, fail = 0;
  for (const x of tests) {
    if (x.section) { console.log(`\n--- ${x.section} ---`); continue; }
    try { await x.fn(); pass++; console.log('  ok    ' + x.name); }
    catch (e) { fail++; console.log('  FAIL  ' + x.name + '\n        ' + (e && e.message)); }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
