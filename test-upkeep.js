'use strict';
// City upkeep goals, the NEAT way (goal-upkeep.js): config comfort,
// comfortpolicy, taxpolicy, production, warehousepolicy, and the medic camp
// (healing unless config nohealing:1). Offline: fake castles, a fake game that
// records every command, and the real Game class on a fake wire where a test
// needs its wrappers. Nothing here connects or logs in.
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Point db.js at a throwaway file BEFORE requiring anything that opens it.
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-upkeep-')), 't.db');

const C = require('./constants');
const { Game } = require('./game');
const { EvonyClient } = require('./evony');
const { Engine } = require('./engine');
const G = require('./goals');
const M = require('./goalmods');
const U = require('./goal-upkeep');

const { parseGoals, describe, NOT_IMPLEMENTED } = G;
const I = U._internals;

const tests = [];
const t = (name, fn) => tests.push({ name, fn });
const section = (s) => tests.push({ section: s });

// ================================================================== clocks
// The server clock (underAttack reads it through game.now) and this machine's
// (every stamp the goals keep): both fixed unless a test moves them.
const NOW0 = 1789000000000;
const clock = { server: NOW0 };
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const later = (ms) => { skew += ms; clock.server += ms; };
const resetClocks = () => { clock.server = NOW0; skew = 0; };

// ================================================================== fixtures
const XY = { home: { x: 200, y: 300 } };

function city(over = {}) {
  const { resource, ...rest } = over;
  return {
    id: 101, name: 'Home', fieldId: C.coordsToFieldId(XY.home.x, XY.home.y),
    usePACIFY_SUCCOUR_OR_PACIFY_PRAY: 1,
    heros: [], troop: { archer: 1000 }, fortification: {},
    buildings: [{ typeId: 3, positionId: 4, level: 5, status: 0 }],     // a Warehouse
    resource: {
      food: { amount: 50e6 }, wood: { amount: 5e6 }, stone: { amount: 5e6 }, iron: { amount: 5e6 },
      gold: 5e6, support: 100, complaint: 0, texRate: 0, taxIncome: 0, herosSalary: 10000,
      curPopulation: 50000, maxPopulation: 60000, workPeople: 1000, buildPeople: 0,
      ...(resource || {}),
    },
    ...rest,
  };
}

// A game that records every command and answers ok unless told otherwise.
function fakeGame(castles, { replies = {}, prestige = 1e6 } = {}) {
  const sent = [];
  const g = {
    castles, sent,
    player: { playerInfo: { userName: 'T', prestige, castleCount: castles.length }, selfArmys: [], enemyArmys: [], items: [] },
    now: () => clock.server,
    castleId: (c) => c.id,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    req: async (cmd, data) => {
      sent.push([cmd, data]);
      const r = replies[cmd];
      if (typeof r === 'function') return r(data);
      return r || { ok: 1 };
    },
  };
  // what the build, troop and wall goals of the live a1 text reach in the engine
  g.newBuilding = (castleId, positionId, buildingType) => g.req('castle.newBuilding', { castleId, positionId, buildingType });
  g.upgradeBuilding = (castleId, positionId) => g.req('castle.upgradeBuilding', { castleId, positionId });
  g.destructBuilding = (castleId, positionId) => g.req('castle.destructBuilding', { castleId, positionId });
  g.produceTroop = (castleId, troopType, num, positionId) => g.req('troop.produceTroop', { castleId, positionId, troopType, num });
  g.produceWall = (castleId, wallProtectType, num) => g.req('fortifications.produceWallProtect', { castleId, wallProtectType, num });
  g.promoteToChief = (castleId, heroId) => g.req('hero.promoteToChief', { castleId, heroId });
  return g;
}

function ctxFor(castle, src, { game = null, incoming = [] } = {}) {
  const p = parseGoals(src);
  const g = game || fakeGame([castle]);
  return { game: g, castle, goals: p.goals, config: p.config, incoming, parsed: p };
}

// An attack marching at the city, as the engine hands it to the plans.
const wave = (inMs, troops = 50000) => ({ troops, reachTime: clock.server + inMs, from: '150,250', armyId: 777 });

// Run one plan's actions through the module's executors, the way the engine does.
async function run(plan, game, castle, state) {
  const out = [];
  for (const a of (plan && plan.actions) || []) {
    try { out.push(await U.executors[a.kind](game, castle, a, state)); } catch (e) { out.push(e); }
  }
  return out;
}

// The real Game on a fake wire: every command is answered by `server`, and
// `pushes` go out after the reply, as the server's own pushes do.
class FakeClient extends EvonyClient {
  constructor(server) { super(); this.server = server; this.sock = { destroyed: false }; }
  send(cmd, data) { this.server.handle(this, cmd, data); }
}
class FakeServer {
  constructor() { this.sent = []; this.replies = {}; this.pushes = {}; }
  handle(client, cmd, data) {
    this.sent.push([cmd, data]);
    const reply = this.replies[cmd] || { ok: 1 };
    setImmediate(() => {
      client.emit('cmd', cmd, reply, { cmd, data: reply });
      for (const [pcmd, pdata] of this.pushes[cmd] || []) client.emit('cmd', pcmd, pdata, { cmd: pcmd, data: pdata });
    });
  }
}
function wiredGame(castles) {
  const server = new FakeServer();
  const g = new Game();
  g.c = new FakeClient(server);
  g.c.on('cmd', (cmd, data) => { if (cmd === 'server.InjuredTroopUpdate') g.applyInjuredUpdate(data); });   // as connect() does
  g.castles = castles;
  g.player = { playerInfo: { userName: 'T', prestige: 1e6, castleCount: castles.length }, selfArmys: [], enemyArmys: [], items: [] };
  return { g, server };
}

const LIVE_A1 = [
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
const LIVE_A2_HEAD = 'config comfort:1,hero:1,troopsusepopmax:1,npc:5\ncomfortpolicy 15 16 popraise';

// ================================================================== 1. the lines
section('the goal lines read the way the wiki writes them');

t('taxpolicy min_rate max_rate [war_rate]', () => {
  const [a] = parseGoals('taxpolicy 20 100').goals;
  assert.deepStrictEqual([a.min, a.max, a.war, a.valid], [20, 100, null, true]);
  const [b] = parseGoals('taxpolicy 20 100 30').goals;
  assert.deepStrictEqual([b.min, b.max, b.war, b.valid], [20, 100, 30, true]);
  assert.strictEqual(parseGoals('taxpolicy 0 100').lines[0].status, 'ok');
});

t('taxpolicy: an unreadable, out-of-range or upside-down line is an error and changes no tax', () => {
  for (const [src, re] of [['taxpolicy 20', /expected: taxpolicy/], ['taxpolicy 120 100', /min_rate "120" is not a whole percentage/],
    ['taxpolicy x 100', /min_rate "x"/], ['taxpolicy 50 20', /min_rate 50 is above max_rate 20/], ['taxpolicy 10 20 30 40', /expected/],
    ['taxpolicy 1.5 20', /min_rate "1.5"/]]) {
    const p = parseGoals(src);
    assert.strictEqual(p.lines[0].status, 'error', src);
    assert.match(p.lines[0].msg, re, src);
    assert.strictEqual(p.goals[0].valid, false, src);
  }
});

t('comfortpolicy min_time max_time [options]: every option word and short form', () => {
  const [g] = parseGoals('comfortpolicy 15 20 popraise wood pray').goals;
  assert.deepStrictEqual(g.options.map((o) => [o.type, o.kind, o.typeId]), [['popraise', 'comfort', 4], ['wood', 'levy', 3], ['pray', 'comfort', 2]]);
  const [s] = parseGoals('comfortpolicy 5 10 po bl pr dr go fo wo st ir').goals;
  assert.deepStrictEqual(s.options.map((o) => o.type), ['popraise', 'bless', 'pray', 'relief', 'gold', 'food', 'wood', 'stone', 'iron']);
  assert.deepStrictEqual(s.options.map((o) => o.typeId), [4, 3, 2, 1, 1, 2, 3, 4, 5]);
  assert.deepStrictEqual(parseGoals('comfortpolicy 5 10 lumber lu').goals[0].options.map((o) => o.type), ['wood'], 'lumber, lu and wood are one levy');
  assert.deepStrictEqual(parseGoals('comfortpolicy 5 10 sacrifice').goals[0].options.map((o) => o.type), ['bless'], 'the old word for typeId 3');
  assert.deepStrictEqual(parseGoals('comfortpolicy 15 20').goals[0].options, [], 'no options: nothing extra');
  assert.strictEqual(parseGoals('comfortpolicy 15 20').lines[0].status, 'ok');
});

t('comfortpolicy: bad times and unknown options are errors', () => {
  assert.match(parseGoals('comfortpolicy 20 15 pray').lines[0].msg, /max_time 15 is shorter than min_time 20/);
  assert.match(parseGoals('comfortpolicy x 15 pray').lines[0].msg, /min_time "x"/);
  assert.match(parseGoals('comfortpolicy 0 15 pray').lines[0].msg, /1 or more/);
  const p = parseGoals('comfortpolicy 15 20 popraise dance');
  assert.match(p.lines[0].msg, /unknown option "dance"/);
  assert.deepStrictEqual(p.goals[0].options.map((o) => o.type), ['popraise'], 'the rest of the line still reads');
});

t('comfortpolicy is one per city: the later line wins, as before', () => {
  const p = parseGoals('comfortpolicy 15 16 popraise\ncomfortpolicy 10 20 pray');
  assert.deepStrictEqual(p.goals.map((g) => g.options.map((o) => o.type)), [['pray']]);
  assert.strictEqual(p.lines[0].status, 'error');
});

t('production food% wood% stone% iron%, 0-100 each', () => {
  assert.deepStrictEqual(parseGoals('production 100 100 100 100').goals[0].rates, { food: 100, wood: 100, stone: 100, iron: 100 });
  assert.deepStrictEqual(parseGoals('production 50 0 25 100').goals[0].rates, { food: 50, wood: 0, stone: 25, iron: 100 });
  for (const src of ['production 101 0 0 0', 'production 50 50 50', 'production a 0 0 0', 'production 50 50 50 50 50']) {
    const p = parseGoals(src);
    assert.strictEqual(p.lines[0].status, 'error', src);
    assert.strictEqual(p.goals[0].valid, false, src);
  }
});

t('warehousepolicy food% lumber% stone% iron%: the four add up to 100 at most', () => {
  assert.deepStrictEqual(parseGoals('warehousepolicy 34 33 0 33').goals[0].rates, { food: 34, wood: 33, stone: 0, iron: 33 });
  const p = parseGoals('warehousepolicy 50 50 50 0');
  assert.match(p.lines[0].msg, /add up to 150%/);
  assert.strictEqual(p.goals[0].valid, false);
});

t('config nohealing is off the not-built list: config nohealing:1 comes out blue', () => {
  assert.ok(!('nohealing' in NOT_IMPLEMENTED.config));
  assert.deepStrictEqual(parseGoals('config nohealing:1').lines[0], { n: 1, status: 'ok', msg: null });
  assert.deepStrictEqual(parseGoals('config comfort:1,nohealing:0').lines[0], { n: 1, status: 'ok', msg: null });
});

t('the console describes each line', () => {
  const d = describe(parseGoals('comfortpolicy 15 20 popraise wood pray\ntaxpolicy 20 100 30\nproduction 100 50 0 100\nwarehousepolicy 34 33 0 33'));
  assert.ok(d.includes('comfortpolicy: every 15-20 min: popraise if needed, levy wood when no popraise is needed, pray (needs config comfort on)'), d.join('\n'));
  assert.ok(d.includes("taxpolicy: tax held at 20%, raised up to 100% when the heroes' gold runs short, 30% while under attack"), d.join('\n'));
  assert.ok(d.includes('production: labour held at food 100% wood 50% stone 0% iron 100%'), d.join('\n'));
  assert.ok(d.includes('warehousepolicy: protection held at food 34% lumber 33% stone 0% iron 33%'), d.join('\n'));
});

t('the live lines still read without an error', () => {
  const p = parseGoals(LIVE_A1);
  assert.deepStrictEqual(p.errors, []);
  const cp = p.goals.find((g) => g.name === 'comfortpolicy');
  assert.deepStrictEqual([cp.everyMinMin, cp.everyMaxMin, cp.options.map((o) => o.type)], [15, 16, ['popraise']]);
  assert.deepStrictEqual(parseGoals(LIVE_A2_HEAD).errors, []);
});

t('the words the comfort and levy script commands take (1-4 / 1-5 or names)', () => {
  assert.deepStrictEqual(U.comfortTypeOf('1'), { type: 'relief', typeId: 1 });
  assert.deepStrictEqual(U.comfortTypeOf('bless'), { type: 'bless', typeId: 3 });
  assert.deepStrictEqual(U.comfortTypeOf(4), { type: 'popraise', typeId: 4 });
  assert.deepStrictEqual(U.levyTypeOf('1'), { type: 'gold', typeId: 1 });
  assert.deepStrictEqual(U.levyTypeOf('lumber'), { type: 'wood', typeId: 3 });
  assert.deepStrictEqual(U.levyTypeOf(5), { type: 'iron', typeId: 5 });
  assert.strictEqual(U.levyTypeOf('pray'), null);
  assert.strictEqual(U.comfortTypeOf('wood'), null);
});

// ================================================================== 2. comfort
section('comfort: loyalty and grievance (config comfort, on by default)');

const comfort = (castle, src, opts) => { const ctx = ctxFor(castle, src, opts); return { ctx, p: M.comfortPlan(ctx, opts && opts.state || {}) }; };

t('loyalty 100, grievance 0: nothing to do', () => {
  const { p } = comfort(city(), 'config comfort:1');
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /^comfort: loyalty 100, grievance 0$/);
});

t('comfort is on by default (wiki Comfort: "Default: config comfort:1")', () => {
  const { p } = comfort(city({ resource: { support: 60 } }), 'troop a:1k');
  assert.deepStrictEqual(p.actions.map((a) => [a.kind, a.type, a.typeId]), [['upkeepComfort', 'pray', 2]]);
  assert.strictEqual(comfort(city(), 'troop a:1k').p, null, 'on by default with nothing to do: no line every slice');
});

t('low loyalty: praying (+25) beats disaster relief (+5)', () => {
  const { p } = comfort(city({ resource: { support: 70 } }), 'config comfort:1');
  assert.deepStrictEqual(p.actions.map((a) => a.type), ['pray']);
  assert.match(p.note, /loyalty 70, grievance 0: praying \(\+25 loyalty, -5 grievance, costs 100,000 food\)/);
});

t('grievance: disaster relief (-15) beats praying (-5)', () => {
  const { p } = comfort(city({ resource: { complaint: 30 } }), 'config comfort:1');
  assert.deepStrictEqual(p.actions.map((a) => a.type), ['relief']);
});

t('a little of both: whichever does more good (loyalty 96, grievance 10 -> relief)', () => {
  const { p } = comfort(city({ resource: { support: 96, complaint: 10 } }), 'config comfort:1');
  assert.deepStrictEqual(p.actions.map((a) => a.type), ['relief']);
});

t('loyalty where the tax holds it is left alone: no food on prayers the tax undoes', () => {
  const { p } = comfort(city({ resource: { support: 80, texRate: 20 } }), 'config comfort:1');
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /a 20% tax holds loyalty at 80/);
  const low = comfort(city({ resource: { support: 60, texRate: 20 } }), 'config comfort:1').p;
  assert.deepStrictEqual(low.actions.map((a) => a.type), ['pray'], 'under what the tax holds: pray');
});

t('with no tax rate on the bean there is no prayer for loyalty, but grievance is still relieved', () => {
  const noTax = (res) => { const c = city({ resource: res }); delete c.resource.texRate; return c; };
  const { p } = comfort(noTax({ support: 60 }), 'config comfort:1');
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /tax rate unknown, so no prayer for loyalty/);
  assert.deepStrictEqual(comfort(noTax({ support: 60, complaint: 20 }), 'config comfort:1').p.actions.map((a) => a.type), ['relief']);
});

t('config comfort:0 does nothing; comfortpolicy then says it needs comfort', () => {
  assert.strictEqual(comfort(city({ resource: { support: 10 } }), 'config comfort:0').p, null);
  const { p } = comfort(city(), 'config comfort:0\ncomfortpolicy 15 16 popraise');
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /comfortpolicy does nothing while config comfort:0/);
});

t('config comfort:2 is not understood: comfort stays off and says so', () => {
  const { p } = comfort(city({ resource: { support: 10 } }), 'config comfort:2');
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /comfort:2 is not 0 or 1/);
});

t('the cost is the client\'s: prestige / 10 x cities x the city\'s multiplier, at most 10m food', () => {
  const c = city({ usePACIFY_SUCCOUR_OR_PACIFY_PRAY: 3 });
  const game = fakeGame([c, city({ id: 102 })], { prestige: 2e6 });
  assert.deepStrictEqual(I.comfortCost({ game, castle: c }, 'pray', I.cityFacts({ castle: c })), { food: 1200000 });
  const big = fakeGame([c], { prestige: 1e9 });
  assert.deepStrictEqual(I.comfortCost({ game: big, castle: c }, 'relief', I.cityFacts({ castle: c })), { food: 10e6 });
  assert.deepStrictEqual(I.comfortCost({ game, castle: c }, 'popraise', I.cityFacts({ castle: c })), { food: 300000 });
  assert.deepStrictEqual(I.comfortCost({ game, castle: c }, 'bless', I.cityFacts({ castle: c })), { food: 60000, gold: 6000 });
});

t('not enough food: the comfort waits and the note says what it costs', () => {
  const { p } = comfort(city({ resource: { support: 50, food: { amount: 50000 } } }), 'config comfort:1');
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /praying needs 100,000 food \(has 50,000\)/);
});

t('one comfort, then a two-minute wait for the city to show it; a refusal waits on the ladder', async () => {
  resetClocks();
  const c = city({ resource: { support: 40 } });
  const state = {};
  const ctx = ctxFor(c, 'config comfort:1');
  const first = M.comfortPlan(ctx, state);
  await run(first, ctx.game, c, state);
  assert.deepStrictEqual(ctx.game.sent, [['interior.pacifyPeople', { castleId: 101, typeId: 2 }]]);
  const soon = M.comfortPlan(ctx, state);
  assert.deepStrictEqual(soon.actions, []);
  assert.match(soon.note, /praying 1 s ago, waiting for the city to show it/);
  later(I.UPKEEP_GAP_MS);
  assert.strictEqual(M.comfortPlan(ctx, state).actions.length, 1, 'still low after the gap: again');
  // refused
  const refusing = fakeGame([c], { replies: { 'interior.pacifyPeople': { ok: -1, errorMsg: 'Not enough food' } } });
  const st2 = {};
  const ctx2 = { ...ctx, game: refusing };
  await run(M.comfortPlan(ctx2, st2), refusing, c, st2);
  const held = M.comfortPlan(ctx2, st2);
  assert.deepStrictEqual(held.actions, []);
  assert.match(held.note, /praying refused \(Not enough food\), asking again in 5 min/);
  later(I.LADDER[0]);
  assert.strictEqual(M.comfortPlan(ctx2, st2).actions.length, 1);
});

// ================================================================== 3. comfortpolicy rounds
section('comfortpolicy: a round every min-max minutes');

t('the live line (15 16 popraise), population under its limit: one popraise, then 15-16 minutes', async () => {
  resetClocks();
  const c = city();
  const state = {};
  const ctx = ctxFor(c, LIVE_A2_HEAD);
  const p = M.comfortPlan(ctx, state);
  assert.deepStrictEqual(p.actions.map((a) => [a.kind, a.typeId]), [['upkeepComfort', 4]]);
  assert.match(p.actions[0].label, /population raising \(50,000 of 60,000, \+3,000 for 300,000 food\)/);
  await run(p, ctx.game, c, state);
  assert.deepStrictEqual(ctx.game.sent, [['interior.pacifyPeople', { castleId: 101, typeId: 4 }]]);
  const next = state.upkeep.comfort.next - Date.now();
  assert.ok(next >= 15 * 60000 - 50 && next <= 16 * 60000, `next round in ${next} ms`);
  later(10 * 60000);
  const waiting = M.comfortPlan(ctx, state);
  assert.deepStrictEqual(waiting.actions, []);
  assert.match(waiting.note, /comfortpolicy 15-16 min popraise: next round in [56] min/);
  later(6 * 60000);
  assert.strictEqual(M.comfortPlan(ctx, state).actions.length, 1, 'the next round');
});

t('the live line at the population limit: no popraise (NEAT: "if needed"), and no food spent', async () => {
  resetClocks();
  const c = city({ resource: { curPopulation: 60000, maxPopulation: 60000 } });
  const state = {};
  const ctx = ctxFor(c, LIVE_A2_HEAD);
  const p = M.comfortPlan(ctx, state);
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /round done, next in 1[56] min; popraise: not needed, population 60,000 is at its limit/);
  later(16 * 60000);
  c.resource.curPopulation = 40000;                          // troops were trained from it
  assert.strictEqual(M.comfortPlan(ctx, state).actions.length, 1, 'the next round raises it');
});

t('the old comfortpolicy\'s last popraise carries over: no popraise straight after the upgrade', () => {
  resetClocks();
  const state = { lastComfort: Date.now() - 5 * 60000 };
  const p = M.comfortPlan(ctxFor(city(), LIVE_A2_HEAD), state);
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /next round in 1[01] min/);
});

t('"popraise wood pray": popraise when needed and no levy; at the limit the levy instead; pray every round', () => {
  resetClocks();
  const src = 'config comfort:1\ncomfortpolicy 15 20 popraise wood pray';
  const below = M.comfortPlan(ctxFor(city(), src), {});
  assert.deepStrictEqual(below.actions.map((a) => [a.kind, a.type]), [['upkeepComfort', 'popraise'], ['upkeepComfort', 'pray']]);
  assert.match(below.note, /wood: popraise was needed this round, and a levy only comes when it is not/);
  const full = M.comfortPlan(ctxFor(city({ resource: { curPopulation: 60000 } }), src), {});
  assert.deepStrictEqual(full.actions.map((a) => [a.kind, a.type, a.typeId]), [['upkeepLevy', 'wood', 3], ['upkeepComfort', 'pray', 2]]);
  assert.match(full.actions[0].label, /levy wood for about 60,000 wood \(-20 loyalty\)/);
});

t('a levy on its own comes every round, and goes out as interior.taxation {castleId, typeId}', async () => {
  resetClocks();
  const c = city();
  const state = {};
  const ctx = ctxFor(c, 'comfortpolicy 15 20 gold iron');
  const p = M.comfortPlan(ctx, state);
  await run(p, ctx.game, c, state);
  assert.deepStrictEqual(ctx.game.sent, [['interior.taxation', { castleId: 101, typeId: 1 }], ['interior.taxation', { castleId: 101, typeId: 5 }]]);
});

t('no levy while under attack, or when it would take loyalty under 50, or with loyalty unknown', () => {
  resetClocks();
  const src = 'comfortpolicy 15 20 food';
  const war = M.comfortPlan(ctxFor(city(), src, { incoming: [wave(60000)] }), {});
  assert.deepStrictEqual(war.actions, []);
  assert.match(war.note, /food: not while under attack: a levy costs 20 loyalty/);
  const low = M.comfortPlan(ctxFor(city({ resource: { support: 65, texRate: 35 } }), src), {});
  assert.deepStrictEqual(low.actions, []);
  assert.match(low.note, /loyalty 65: a levy costs 20 and may not take it under 50/);
  const c = city();
  delete c.resource.support;
  assert.match(M.comfortPlan(ctxFor(c, src), {}).note, /food: loyalty unknown/);
  assert.strictEqual(M.comfortPlan(ctxFor(city({ resource: { support: 70, texRate: 30 } }), src), {}).actions.length, 1, '70 - 20 = 50 is allowed');
});

t('bless and relief every round, needed or not; blessing needs its gold too', () => {
  resetClocks();
  const p = M.comfortPlan(ctxFor(city(), 'comfortpolicy 15 20 bless relief'), {});
  assert.deepStrictEqual(p.actions.map((a) => [a.type, a.typeId]), [['bless', 3], ['relief', 1]]);
  const poor = M.comfortPlan(ctxFor(city({ resource: { gold: 1000 } }), 'comfortpolicy 15 20 bless'), {});
  assert.deepStrictEqual(poor.actions, []);
  assert.match(poor.note, /bless: it costs 6,000 gold \(has 1,000\)/);
});

t('a round that prays covers the loyalty comfort: one prayer, not two', () => {
  resetClocks();
  const p = M.comfortPlan(ctxFor(city({ resource: { support: 50 } }), 'comfortpolicy 15 20 pray'), {});
  assert.deepStrictEqual(p.actions.map((a) => [a.type, !!a.upkeep]), [['pray', false]]);
  assert.match(p.note, /the comfortpolicy round comforts this slice/);
});

t('a refusal settles the option: the round closes and the next note names it', async () => {
  resetClocks();
  const c = city();
  const game = fakeGame([c], { replies: { 'interior.pacifyPeople': { ok: -1, errorMsg: 'Insufficient food' } } });
  const state = {};
  const ctx = ctxFor(c, LIVE_A2_HEAD, { game });
  await run(M.comfortPlan(ctx, state), game, c, state);
  assert.strictEqual(state.upkeep.comfort.round, undefined, 'the round closed');
  assert.match(M.comfortPlan(ctx, state).note, /next round in 1[56] min; last round: popraise refused \(Insufficient food\)/);
});

t('a lost reply is asked again two minutes on, once; a second loss settles it', async () => {
  resetClocks();
  const c = city();
  const game = fakeGame([c], { replies: { 'interior.pacifyPeople': () => { throw new Error('no reply to interior.pacifyPeople'); } } });
  const state = {};
  const ctx = ctxFor(c, LIVE_A2_HEAD, { game });
  await run(M.comfortPlan(ctx, state), game, c, state);
  const wait = M.comfortPlan(ctx, state);
  assert.deepStrictEqual(wait.actions, []);
  assert.match(wait.note, /popraise: no reply, asking again in 2 min/);
  later(I.RETRY_MS);
  const again = M.comfortPlan(ctx, state);
  assert.strictEqual(again.actions.length, 1);
  await run(again, game, c, state);
  assert.strictEqual(game.sent.length, 2);
  assert.strictEqual(state.upkeep.comfort.round, undefined, 'settled after the second loss');
});

t('a round whose actions did not get a slot stays open and is asked again next slice', () => {
  resetClocks();
  const state = {};
  const ctx = ctxFor(city(), LIVE_A2_HEAD);
  assert.strictEqual(M.comfortPlan(ctx, state).actions.length, 1);
  // the engine's budget ran out: nothing executed
  const again = M.comfortPlan(ctx, state);
  assert.strictEqual(again.actions.length, 1);
  assert.strictEqual(again.actions[0].round, state.upkeep.comfort.round.id);
});

t('an edited line mid-round starts a fresh round', () => {
  resetClocks();
  const state = {};
  M.comfortPlan(ctxFor(city(), 'comfortpolicy 15 20 popraise'), state);
  const p = M.comfortPlan(ctxFor(city(), 'comfortpolicy 15 20 relief'), state);
  assert.deepStrictEqual(p.actions.map((a) => a.type), ['relief']);
  assert.strictEqual(state.upkeep.comfort.round.what, 'relief');
});

// ================================================================== 4. tax
section('taxpolicy: the tax the gold allows');

const T = (over) => I.taxTarget({ cur: 0, min: 0, max: 100, war: null, underAttack: false, manual: null, raised: false,
  gold: 5e6, salary: 10000, income: 0, population: 100000, ...over });

t('gold is fine: the minimum (NEAT default 0 keeps the population at its maximum)', () => {
  assert.strictEqual(T({ cur: 20, income: 20000 }).rate, 0);
  assert.strictEqual(T({ min: 20 }).rate, 20);
});

t('under a day of salary: raised to pay the heroes and refill the day within a day, up to max', () => {
  // 100,000 people: 1,000 gold per point. 12 h banked: 10,000 + (240,000 - 120,000) / 24 = 15,000/h -> 15%
  const r = T({ gold: 120000 });
  assert.deepStrictEqual([r.rate, r.raised], [15, true]);
  assert.match(r.why, /under a day of hero salary/);
  assert.strictEqual(T({ gold: 0 }).rate, 20, 'an empty bank: twice the salary');
  assert.strictEqual(T({ gold: 120000, max: 12 }).rate, 12, 'never past max');
});

t('once raised it pays the salary until two days are banked, then comes back down', () => {
  assert.strictEqual(T({ gold: 300000, raised: true }).rate, 10, '30 h banked: holds the paying rate');
  assert.strictEqual(T({ gold: 300000, raised: false }).rate, 0, 'not raised: 30 h is plenty');
  const back = T({ gold: 500000, raised: true });
  assert.deepStrictEqual([back.rate, back.raised], [0, false]);
});

t('a minimum that pays the heroes holds even with an empty bank', () => {
  assert.strictEqual(T({ min: 20, cur: 20, income: 20000, gold: 0 }).rate, 20);
});

t('the war rate while under attack', () => {
  assert.strictEqual(T({ war: 30, underAttack: true }).rate, 30);
  assert.strictEqual(T({ war: 30, underAttack: false }).rate, 0);
});

t('a rate set by hand is kept (inside the range)', () => {
  assert.strictEqual(T({ manual: 25 }).rate, 25);
  assert.strictEqual(T({ manual: 5, min: 20 }).rate, 20);
  assert.strictEqual(T({ manual: 25, gold: 60000 }).rate, 25, 'a hand-set 25% pays the heroes on its own');
});

t('gold per point comes from the city\'s own income when it has one', () => {
  // 10% brings 5,000: 500 a point, so 10,000 salary + refill from 120,000 needs 30%
  assert.strictEqual(T({ cur: 10, income: 5000, gold: 120000 }).rate, 30);
});

t('without the gold figures it never lowers a rate it cannot judge', () => {
  assert.strictEqual(T({ cur: 20, salary: null }).rate, 20);
  assert.strictEqual(T({ cur: 20, gold: null, max: 15 }).rate, 15, 'but keeps it inside the range');
});

const tax = (castle, src, state, opts) => U.plans.tax(ctxFor(castle, src, opts), state);

t('config comfort:1 alone runs NEAT\'s default taxpolicy 0 100: a 20% tax goes to 0 while gold is fine', async () => {
  resetClocks();
  const c = city({ resource: { texRate: 20, taxIncome: 10000 } });
  const state = {};
  const ctx = ctxFor(c, 'config comfort:1');
  const p = U.plans.tax(ctx, state);
  assert.deepStrictEqual(p.actions.map((a) => [a.kind, a.rate]), [['upkeepTax', 0]]);
  assert.match(p.note, /tax 20% \(comfort, taxpolicy default 0-100\): to 0%/);
  await run(p, ctx.game, c, state);
  assert.deepStrictEqual(ctx.game.sent, [['interior.modifyTaxRate', { castleId: 101, tax: 0 }]]);
  // the bean has not caught up yet: no second send
  const wait = U.plans.tax(ctx, state);
  assert.deepStrictEqual(wait.actions, []);
  assert.match(wait.note, /0% sent 1 s ago, waiting for the city to show it/);
  c.resource.texRate = 0;                                    // the push
  const held = U.plans.tax(ctx, state);
  assert.deepStrictEqual(held.actions, []);
  assert.match(held.note, /tax 0% \(comfort, taxpolicy default 0-100\): holds/);
  assert.strictEqual(state.upkeep.tax.manual, null, 'its own change is not taken for one made by hand');
});

t('no taxpolicy and comfort off: the tax is never touched', () => {
  assert.strictEqual(tax(city({ resource: { texRate: 50 } }), 'config comfort:0', {}), null);
});

t('a taxpolicy line works with comfort off too', () => {
  const p = tax(city({ resource: { texRate: 50 } }), 'config comfort:0\ntaxpolicy 20 100', {});
  assert.deepStrictEqual(p.actions.map((a) => a.rate), [20]);
});

t('a taxpolicy line with an error leaves the tax alone', () => {
  const p = tax(city({ resource: { texRate: 50 } }), 'taxpolicy 50 20', {});
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /the taxpolicy line has an error, so the tax is left alone/);
});

t('no tax rate on the bean: nothing to judge by, nothing said', () => {
  const c = city();
  delete c.resource.texRate;
  assert.strictEqual(tax(c, 'taxpolicy 20 100', {}), null);
});

t('a rate changed by hand after the goal looked is kept ("don\'t fight a manual tax") until the tax settings change', async () => {
  resetClocks();
  const c = city({ resource: { texRate: 0 } });
  const state = {};
  const ctx = ctxFor(c, 'config comfort:1');
  assert.deepStrictEqual(U.plans.tax(ctx, state).actions, []);   // looks: 0% is right
  c.resource.texRate = 25;                                        // a script's `tax 25`
  const kept = U.plans.tax(ctx, state);
  assert.deepStrictEqual(kept.actions, []);
  assert.match(kept.note, /25% was set by hand and is kept/);
  // writing a taxpolicy line is a change of settings: it applies at once (wiki SetTaxRate's example)
  const p = U.plans.tax(ctxFor(c, 'config comfort:1\ntaxpolicy 20 100'), state);
  assert.deepStrictEqual(p.actions.map((a) => a.rate), [20]);
});

t('the war rate while under attack (defense mode), and back once the defensecooldown window closes', async () => {
  resetClocks();
  const c = city({ resource: { texRate: 0 } });
  const state = {};
  const src = 'taxpolicy 0 100 30\nconfig defensecooldown:10';
  const game = fakeGame([c]);
  const war = U.plans.tax(ctxFor(c, src, { game, incoming: [wave(60000)] }), state);
  assert.deepStrictEqual(war.actions.map((a) => a.rate), [30]);
  assert.match(war.note, /the war rate while under attack/);
  await run(war, game, c, state);
  c.resource.texRate = 30;
  later(90000);                                              // the wave lands: still under attack for 10 min
  assert.deepStrictEqual(U.plans.tax(ctxFor(c, src, { game }), state).actions, []);
  later(10 * 60000);
  const back = U.plans.tax(ctxFor(c, src, { game }), state);
  assert.deepStrictEqual(back.actions.map((a) => a.rate), [0]);
  assert.strictEqual(state.upkeep.tax.manual, null, 'its own war rate is not taken for a hand-set one');
});

t('a refused change waits on the ladder', async () => {
  resetClocks();
  const c = city({ resource: { texRate: 20 } });
  const game = fakeGame([c], { replies: { 'interior.modifyTaxRate': { ok: -1, errorMsg: 'no' } } });
  const state = {};
  const ctx = ctxFor(c, 'taxpolicy 0 100', { game });
  await run(U.plans.tax(ctx, state), game, c, state);
  const held = U.plans.tax(ctx, state);
  assert.deepStrictEqual(held.actions, []);
  assert.match(held.note, /0% refused \(no\), asking again in 5 min/);
  assert.strictEqual(state.upkeep.tax.manual, null);
});

t('short of gold under the default policy: the tax rises, and the note says why', () => {
  const p = tax(city({ resource: { texRate: 0, gold: 50000, curPopulation: 100000 } }), 'config comfort:1', {});
  assert.deepStrictEqual(p.actions.map((a) => a.rate), [18]);
  assert.match(p.note, /gold 50,000 is under a day of hero salary \(10,000\/h\)/);
});

// ================================================================== 5. healing
section('the medic camp: healed unless config nohealing:1');

const heal = (castle, src, state, opts) => U.plans.heal(ctxFor(castle, src, opts), state);
const campGame = (c, camp, opts) => { const g = fakeGame([c], opts); g.injured = camp ? { [c.id]: { at: Date.now(), goldNeed: 0, troop: {}, total: 0, ...camp } } : {}; return g; };

t('wounded and the gold to cure them: army.cureInjuredTroop {castleId}, and the camp is empty after', async () => {
  resetClocks();
  const c = city();
  const game = campGame(c, { goldNeed: 40000, total: 1200, troop: { archer: 1200 } });
  const state = {};
  const ctx = ctxFor(c, 'troop a:1k', { game });
  const p = U.plans.heal(ctx, state);
  assert.deepStrictEqual(p.actions.map((a) => [a.kind, a.goldNeed, a.wounded]), [['upkeepHeal', 40000, 1200]]);
  assert.match(p.note, /heal: 1,200 wounded in the medic camp, 40,000 gold to cure/);
  await run(p, game, c, state);
  assert.deepStrictEqual(game.sent, [['army.cureInjuredTroop', { castleId: 101 }]]);
  assert.strictEqual(game.injured[101].total, 0);
  const after = U.plans.heal(ctx, state);
  assert.deepStrictEqual(after.actions, []);
  assert.match(after.note, /heal: cured 1 s ago/);
});

t('the cure checks the city\'s gold again as it sends, as the client does', async () => {
  const c = city({ resource: { gold: 1000 } });
  const game = campGame(c, { goldNeed: 40000, total: 1200 });
  const r = await U.executors.upkeepHeal(game, c, { goldNeed: 40000 }, {});
  assert.deepStrictEqual([r.ok, game.sent], [0, []]);
  assert.match(r.errorMsg, /curing needs 40,000 gold and the city has 1,000/);
});

t('config nohealing:1: nothing is cured, and the note counts what waits', () => {
  const c = city();
  const game = campGame(c, { goldNeed: 40000, total: 1200 });
  const p = heal(c, 'config nohealing:1', {}, { game });
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /1,200 wounded left in the medic camp \(config nohealing:1\)/);
  assert.strictEqual(heal(c, 'config nohealing:1', {}, { game: campGame(c, null) }), null);
});

t('not enough gold, or a cure that would leave under a day of hero salary: it waits', () => {
  const c = city({ resource: { gold: 30000 } });
  const short = heal(c, 'troop a:1k', {}, { game: campGame(c, { goldNeed: 40000, total: 1200 }) });
  assert.deepStrictEqual(short.actions, []);
  assert.match(short.note, /the city has 30,000/);
  const c2 = city({ resource: { gold: 250000 } });              // 240,000 is a day of 10,000/h
  const thin = heal(c2, 'troop a:1k', {}, { game: campGame(c2, { goldNeed: 40000, total: 1200 }) });
  assert.deepStrictEqual(thin.actions, []);
  assert.match(thin.note, /would leave the city under a day of hero salary \(240,000 gold\)/);
});

t('held while a real attack marches in; cured once it has landed', () => {
  resetClocks();
  const c = city();
  const game = campGame(c, { goldNeed: 40000, total: 1200 });
  const state = {};
  const p = heal(c, 'troop a:1k', state, { game, incoming: [wave(60000)] });
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /held while 1 real attack\(s\) march in/);
  later(90000);                                              // it lands, and the list no longer has it
  assert.strictEqual(heal(c, 'troop a:1k', state, { game }).actions.length, 1);
});

t('nothing known: the first look comes an hour after the city is first seen, then hourly', () => {
  resetClocks();
  const c = city();
  const state = {};
  const game = campGame(c, null);
  assert.strictEqual(heal(c, 'troop a:1k', state, { game }), null, 'no read in a start-up slice');
  later(I.CAMP_READ_MS);
  const p = heal(c, 'troop a:1k', state, { game });
  assert.deepStrictEqual(p.actions.map((a) => a.kind), ['upkeepCamp']);
  assert.match(p.note, /the medic camp has not been looked at yet/);
});

t('a minute after an attack on the city lands, the camp is looked at', () => {
  resetClocks();
  const c = city();
  const state = {};
  const game = campGame(c, { total: 0 });                    // looked at just now: empty
  assert.deepStrictEqual(heal(c, 'troop a:1k', state, { game, incoming: [wave(30000)] }).actions, []);
  later(40000);                                              // landed 10 s ago
  assert.deepStrictEqual(heal(c, 'troop a:1k', state, { game }).actions, []);
  later(I.CAMP_AFTER_LANDING_MS);
  const p = heal(c, 'troop a:1k', state, { game });
  assert.deepStrictEqual(p.actions.map((a) => a.kind), ['upkeepCamp']);
  assert.match(p.note, /an attack has landed since/);
});

t('the read on the real Game: army.getInjuredTroop, and the push fills the camp', async () => {
  resetClocks();
  const c = city();
  const { g, server } = wiredGame([c]);
  server.pushes['army.getInjuredTroop'] = [['server.InjuredTroopUpdate', { castleId: 101, goldNeed: 9000, troop: { archer: '300', pikemen: 200, scouter: '?' } }]];
  const state = {};
  const r = await U.executors.upkeepCamp(g, c, {}, state);
  assert.strictEqual(r.ok, 1);
  assert.deepStrictEqual(server.sent, [['army.getInjuredTroop', { castleId: 101 }]]);
  assert.deepStrictEqual([g.injured[101].total, g.injured[101].goldNeed], [500, 9000]);
  const p = U.plans.heal({ game: g, castle: c, goals: [], config: {}, incoming: [] }, state);
  assert.deepStrictEqual(p.actions.map((a) => a.kind), ['upkeepHeal']);
});

t('...and a read with no push is an empty camp, until a push says otherwise', async () => {
  resetClocks();
  const c = city();
  const { g } = wiredGame([c]);
  g.injured = { 101: { at: Date.now() - 1, goldNeed: 5, troop: { archer: 5 }, total: 5 } };   // an old push
  const r = await U.executors.upkeepCamp(g, c, {}, {});
  assert.strictEqual(r.ok, 1);
  assert.strictEqual(g.injured[101].total, 0);
  g.c.emit('cmd', 'server.InjuredTroopUpdate', { castleId: 101, goldNeed: 70, troop: { militia: 7 } });
  assert.strictEqual(g.injured[101].total, 7);
});

t('goal-war\'s constraints note no longer says the bot cannot heal', () => {
  const W = require('./goal-war');
  const c = city();
  const p = W.plans.constraints({ game: fakeGame([c]), castle: c, goals: [], config: { nohealing: 1 }, incoming: [] }, {});
  assert.match(p.note, /nohealing: wounded troops are left in the medic camp$/);
});

t('Game.cureInjured and the other wrappers send what the client sends', async () => {
  const c = city();
  const { g, server } = wiredGame([c]);
  await g.cureInjured(101);
  await g.pacify(101, 4);
  await g.levy(101, 3);
  await g.storeList(101);
  await g.setStorePercent(101, { food: 34, wood: 33, stone: 0, iron: 33 });
  assert.deepStrictEqual(server.sent, [
    ['army.cureInjuredTroop', { castleId: 101 }],
    ['interior.pacifyPeople', { castleId: 101, typeId: 4 }],
    ['interior.taxation', { castleId: 101, typeId: 3 }],
    ['city.getStoreList', { castleId: 101 }],
    ['city.modifyStorePercent', { castleId: 101, foodrate: 34, woodrate: 33, stonerate: 0, ironrate: 33 }],
  ]);
});

// ================================================================== 6. production and warehouse
section('production and warehousepolicy: held, read every half hour');

const PROD_REPLY = (rates) => ({ ok: 1, resourceProduceDataBean: rates.map((r, i) => ({ typeid: i + 1, commenceRate: r, maxLabour: 1000 })) });

t('production: read the Town Hall, and set only what differs', async () => {
  resetClocks();
  const c = city();
  const game = fakeGame([c], { replies: { 'interior.getResourceProduceData': PROD_REPLY([100, 50, 100, 100]) } });
  const state = {};
  const ctx = ctxFor(c, 'production 100 100 100 100', { game });
  const p = U.plans.production(ctx, state);
  assert.match(p.note, /production food 100% wood 100% stone 100% iron 100%: not checked yet/);
  await run(p, game, c, state);
  assert.deepStrictEqual(game.sent, [
    ['interior.getResourceProduceData', { castleId: 101 }],
    ['interior.modifyCommenceRate', { castleId: 101, foodrate: 100, woodrate: 100, stonerate: 100, ironrate: 100 }],
  ]);
  const after = U.plans.production(ctx, state);
  assert.deepStrictEqual(after.actions, []);
  assert.match(after.note, /set 1 s ago, was food 100% wood 50% stone 100% iron 100%, next look in 30 min/);
});

t('production: already as wanted, nothing is set; the next look is half an hour on; an edit looks at once', async () => {
  resetClocks();
  const c = city();
  const game = fakeGame([c], { replies: { 'interior.getResourceProduceData': PROD_REPLY([100, 100, 100, 100]) } });
  const state = {};
  const ctx = ctxFor(c, 'production 100 100 100 100', { game });
  await run(U.plans.production(ctx, state), game, c, state);
  assert.deepStrictEqual(game.sent.map(([cmd]) => cmd), ['interior.getResourceProduceData']);
  assert.match(U.plans.production(ctx, state).note, /as wanted 1 s ago, next look in 30 min/);
  later(I.CHECK_MS);
  assert.strictEqual(U.plans.production(ctx, state).actions.length, 1);
  resetClocks();
  assert.strictEqual(U.plans.production(ctxFor(c, 'production 0 100 100 100', { game }), state).actions.length, 1);
});

t('production: a line with an error changes nothing', () => {
  const p = U.plans.production(ctxFor(city(), 'production 100 100 100'), {});
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /the production line has an error/);
});

t('warehousepolicy: city.getStoreList, then city.modifyStorePercent when it differs', async () => {
  resetClocks();
  const c = city();
  const store = { ok: 1, totalCap: 1e6, storeBeans: [1, 2, 3, 4].map((id) => ({ storeTypeId: id, storePercent: 25, resLimt: 0 })) };
  const game = fakeGame([c], { replies: { 'city.getStoreList': store } });
  const state = {};
  const ctx = ctxFor(c, 'warehousepolicy 34 33 0 33', { game });
  await run(U.plans.warehouse(ctx, state), game, c, state);
  assert.deepStrictEqual(game.sent, [
    ['city.getStoreList', { castleId: 101 }],
    ['city.modifyStorePercent', { castleId: 101, foodrate: 34, woodrate: 33, stonerate: 0, ironrate: 33 }],
  ]);
  assert.match(U.plans.warehouse(ctx, state).note, /warehouse food 34% lumber 33% stone 0% iron 33%: set 1 s ago, was food 25% lumber 25% stone 25% iron 25%/);
});

t('warehousepolicy: a city with no Warehouse has nothing to set', () => {
  const p = U.plans.warehouse(ctxFor(city({ buildings: [] }), 'warehousepolicy 34 33 0 33'), {});
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /no Warehouse in this city/);
});

t('a refused read waits on the ladder', async () => {
  resetClocks();
  const c = city();
  const game = fakeGame([c], { replies: { 'city.getStoreList': { ok: -1, errorMsg: 'busy' } } });
  const state = {};
  const ctx = ctxFor(c, 'warehousepolicy 25 25 25 25', { game });
  await run(U.plans.warehouse(ctx, state), game, c, state);
  const p = U.plans.warehouse(ctx, state);
  assert.deepStrictEqual(p.actions, []);
  assert.match(p.note, /refused \(busy\), asking again in 5 min/);
});

// ================================================================== 7. the engine
section('through the engine: the budget, the order, the live goals');

function engineFor(castles, src, { live = true, replies = {} } = {}) {
  const game = fakeGame(castles, { replies });
  const e = new Engine(game, () => {}, 'test');
  e.dryRun = !live;
  e.state = {};
  e.goalsFor = () => parseGoals(src);
  return { e, game };
}
const upkeepCmds = (sent) => sent.filter(([cmd]) => /^interior\.|^army\.(cure|getInjured)|^city\.(getStore|modifyStore)/.test(cmd));

t('the live a1 goals: popraise (population under its limit) and the tax to NEAT\'s default 0%, each once', async () => {
  resetClocks();
  const c = city({ resource: { texRate: 20, taxIncome: 10000 } });
  const { e, game } = engineFor([c], LIVE_A1);
  const r = await e.focus(c);
  assert.deepStrictEqual(upkeepCmds(game.sent), [
    ['interior.pacifyPeople', { castleId: 101, typeId: 4 }],
    ['interior.modifyTaxRate', { castleId: 101, tax: 0 }],
  ], r.acted.join(' | '));
  const keys = Object.keys(r);
  assert.ok(keys.indexOf('comfort') < keys.indexOf('defense') && keys.indexOf('defense') < keys.indexOf('tax'), keys.join(','));
  c.resource.texRate = 0;
  game.sent.length = 0;
  await e.focus(c);
  assert.deepStrictEqual(upkeepCmds(game.sent), [], 'nothing again the next slice');
});

t('config comfort:1 without comfortpolicy never popraises (popraise is a comfortpolicy option)', async () => {
  resetClocks();
  const c = city();
  const { e, game } = engineFor([c], 'config comfort:1,hero:0');
  await e.focus(c);
  assert.deepStrictEqual(upkeepCmds(game.sent), []);
});

t('upkeep actions spend the slice\'s budget like any other', async () => {
  resetClocks();
  const c = city({ resource: { support: 40, texRate: 20 } });
  const { e, game } = engineFor([c], `${LIVE_A2_HEAD}\nconfig hero:0`);
  e.maxActionsPerSlice = 1;
  await e.focus(c);
  // the loyalty prayer comes first; the round's popraise and the tax wait for a slot
  assert.deepStrictEqual(upkeepCmds(game.sent).map(([cmd, d]) => [cmd, d.typeId ?? d.tax]), [['interior.pacifyPeople', 2]]);
  game.sent.length = 0;
  later(I.UPKEEP_GAP_MS);
  c.resource.support = 90;
  await e.focus(c);
  assert.deepStrictEqual(upkeepCmds(game.sent).map(([cmd, d]) => [cmd, d.typeId ?? d.tax]), [['interior.pacifyPeople', 4]], 'then the popraise');
});

t('a dry run plans them and sends nothing', async () => {
  resetClocks();
  const c = city({ resource: { texRate: 20 } });
  const { e, game } = engineFor([c], LIVE_A1, { live: false });
  const r = await e.focus(c);
  assert.deepStrictEqual(upkeepCmds(game.sent), []);
  assert.ok(r.acted.some((a) => /^\[plan\] comfortpolicy: population raising/.test(a)), r.acted.join(' | '));
  assert.ok(r.acted.some((a) => /^\[plan\] tax 20% -> 0%/.test(a)), r.acted.join(' | '));
});

// ================================================================== run
(async () => {
  let pass = 0, fail = 0;
  for (const x of tests) {
    if (x.section) { console.log(`\n--- ${x.section} ---`); continue; }
    try { await x.fn(); console.log('  ok    ' + x.name); pass++; }
    catch (e) { console.log('  FAIL  ' + x.name + '\n        ' + (e && e.message)); fail++; }
  }
  Date.now = realNow;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
