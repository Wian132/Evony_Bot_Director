'use strict';
// War Town, WarTownPolicy, KeepAttHome, HomeHeroes, AttackGap and
// DefenseCooldown as the NEAT wiki describes them. Offline: fixture objects
// and a throwaway database — nothing here connects, logs in or sends a byte.
//
//   node test-wartown.js
const assert = require('assert');
const path = require('path'), os = require('os'), fs = require('fs');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-wartown-')), 't.db');

const C = require('./constants');
const W = require('./goal-war');
const NPC = require('./goal-npc');
const T = require('./goal-transfer');
const B = require('./goal-buildnpc');
const M = require('./goalmods');
const { parseGoals } = require('./goals');
const { Engine } = require('./engine');
const D = require('./db');
const { Game } = require('./game');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); fail++; }
}
const section = (s) => console.log(`\n${s}\n`);
const has = (s, sub) => assert.ok(String(s).includes(sub), `"${s}" does not contain "${sub}"`);
const hasNot = (s, sub) => assert.ok(!String(s).includes(sub), `"${s}" should not contain "${sub}"`);

// ------------------------------------------------------------------ fixtures
// The clock: wartownpolicy hours are read on this machine's clock, so the
// fixture times are local times.
const at = (h, m = 0) => new Date(2026, 8, 14, h, m, 0).getTime();
let NOW = at(8);

let nextId = 100;
function city(name, x, y, over = {}) {
  const id = over.castleId || nextId++;
  return {
    castleId: id, id, name, fieldId: C.coordsToFieldId(x, y),
    resource: { food: { amount: 1e9 }, wood: { amount: 50e6 }, stone: { amount: 50e6 }, iron: { amount: 50e6 }, gold: 1e6, support: 100 },
    troop: { carriage: 20000, ballista: 5000, archer: 100000, scouter: 1000 },
    buildings: [{ typeId: 29, level: 10, positionId: 5 }],
    heros: [], fortification: {}, goOutForBattle: false,
    ...over,
  };
}
const hero = (id, name, power, extra = {}) => ({ id, name, power, powerAdded: 0, management: 10, stratagem: 10, level: 20, status: 0, ...extra });

function fakeGame(castles, selfArmys = []) {
  const g = {
    castles, player: { playerInfo: { userName: 'T' }, selfArmys, enemyArmys: [], items: [] },
    sent: [], reqs: [], discharged: [], promoted: [],
    marchSkillParam: 100, loadSkillParam: 100,
    now: () => NOW,
    castleId: (c) => c.castleId,
    castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    buildArmyBean: (o) => Game.prototype.buildArmyBean.call(g, o),
    newArmy: async (castleId, bean) => { g.sent.push({ castleId, bean }); return { ok: 1 }; },
    req: async (cmd, data) => { g.reqs.push([cmd, data]); return { ok: 1 }; },
    dischargeChief: async (cid) => { g.discharged.push(cid); return { ok: 1 }; },
    promoteToChief: async (cid, heroId) => { g.promoted.push([cid, heroId]); return { ok: 1 }; },
  };
  return g;
}

// One of our marches as SelfArmysUpdate lists it (ArmyConstants.as: direction
// 1 going out, 2 coming home, 3 camped).
const march = (from, armyId, extra = {}) => ({
  armyId, startFieldId: from.fieldId, targetFieldId: C.coordsToFieldId(1, 1), missionType: C.MISSION.attack,
  direction: 1, startTime: NOW - 60000, troop: {}, resource: {}, ...extra,
});

// An inbound enemy wave as the server sends it: counts are strings under
// `troop`, reachTime is absolute server-epoch ms.
const wave = (inMs, armyId, troop = { archer: '200000' }) =>
  ({ armyId, king: 'Raider', startPosName: '150,250', missionType: C.MISSION.attack, reachTime: NOW + inMs, troop });

// A plan context the way engine.js builds one, from goal text.
function ctxFor(castle, src, over = {}) {
  const parsed = parseGoals(src);
  assert.deepStrictEqual(parsed.errors, [], 'the goals should parse');
  const game = over.game || fakeGame([castle, ...(over.others || [])], over.selfArmys || []);
  return {
    game, castle, goals: parsed.goals, config: parsed.config, controls: over.controls || {},
    incoming: over.incoming || [], selfArmies: over.selfArmys || [], fortifications: {}, ...(over.ctx || {}),
  };
}

// NPC camps around a city, all level 5, nearest first.
function npcCache(castle) {
  const home = C.fieldIdToCoords(castle.fieldId);
  const castles = {};
  for (const [dx, dy] of [[1, 0], [0, 2], [3, 0], [0, 4], [5, 0], [0, 6]]) {
    const x = home.x + dx, y = home.y + dy, id = C.coordsToFieldId(x, y);
    castles[id] = { id, x, y, level: 5, kind: 'npc', npc: true, name: "Barbarian's city", seen: NOW };
  }
  return { updatedAt: NOW, castles };
}
function npcPlan(castle, src, over = {}) {
  const ctx = ctxFor(castle, src, over);
  ctx.mapCache = npcCache(castle);
  ctx.now = NOW;
  // Step 15: levels 1-5 farm only with the research the wiki FAQ names
  // (Military Tradition 9, Horseback Riding 13, Archery 14)
  ctx.techs = ctx.techs || { levels: { 9: 10, 13: 10, 14: 10 } };
  return NPC.plans.npc(ctx, over.state || {}, ctx.game);
}
const npcHeroes = (p) => p.actions.map((a) => a.hero.name);

const farmers = () => [
  hero(1, 'Strong', 150), hero(2, 'Middling', 80), hero(3, 'Weakling', 20),
  hero(4, 'Mayor', 200, { status: 1 }), hero(5, 'Brawler', 140),
];

// The engine over fake cities, each with its own goal text.
function engineFor(castles, srcFor, { selfArmys = [], controls = {} } = {}) {
  const game = fakeGame(castles, selfArmys);
  const lines = [];
  const e = new Engine(game, (m) => lines.push(String(m)));
  e.dryRun = false;
  e.state = {};
  e.goalsFor = (id, name) => parseGoals(`config hero:0\n${srcFor[name] || ''}`);
  e.controlsFor = (c) => controls[c.name] || { gate: 'auto', wartown: 'auto' };
  return { e, game, lines };
}
const recalls = (game) => game.reqs.filter(([cmd]) => cmd === 'army.callBackArmy').map(([, d]) => d);

(async () => {
  // ============================================================ the switch
  section('config wartown and the console override');

  await t('wartown 0 / 1 / 2: off, on with a moving traininghero, on with a staying one', () => {
    const c = city('A', 100, 100);
    assert.strictEqual(W.lockdown(ctxFor(c, 'config wartown:0')).on, false);
    const one = W.lockdown(ctxFor(c, 'config wartown:1'));
    assert.deepStrictEqual([one.on, one.mode, one.heroMayMove], [true, 1, true]);
    const two = W.lockdown(ctxFor(c, 'config wartown:2'));
    assert.deepStrictEqual([two.on, two.mode, two.heroMayMove], [true, 2, false]);
    assert.strictEqual(W.lockdown(ctxFor(c, 'config comfort:1')).on, false, 'unset is off');
  });

  await t('a value that is not 0, 1 or 2 is reported, and a bigger number still locks down', () => {
    const five = W.parsers.wartown.parse(5);
    assert.ok(five.errors.length);
    assert.strictEqual(five.mode, 2);
    const junk = W.parsers.wartown.parse('yes');
    assert.ok(junk.errors.length);
    assert.strictEqual(junk.enabled, false);
    // Step 9: goals.js runs the key's own parser too, so the editor shows it red
    const bad = parseGoals('config wartown:5');
    has(bad.errors[0].error, 'wartown must be 0');
    const p = W.plans.wartown({ ...ctxFor(city('A', 100, 100), ''), goals: bad.goals, config: bad.config }, {});
    has(p.note, 'wartown must be 0');
  });

  await t("the console's War Town Mode counts the same as the config key, and Auto hands back", () => {
    const c = city('A', 100, 100);
    assert.strictEqual(W.isWarTown(ctxFor(c, 'config wartown:0', { controls: { wartown: 2 } })), 2);
    assert.strictEqual(W.isWarTown(ctxFor(c, 'config wartown:2', { controls: { wartown: 0 } })), 0);
    assert.strictEqual(W.isWarTown(ctxFor(c, 'config wartown:1', { controls: { wartown: 'auto' } })), 1);
    assert.strictEqual(W.isWarTown(ctxFor(c, '', { controls: { wartown: 1 } })), 1, 'no goal line needed');
    const p = W.plans.wartown(ctxFor(c, '', { controls: { wartown: 2 } }), {});
    has(p.note, 'wartown 2 (console): locked down');
  });

  // ======================================================= wartownpolicy
  section('wartownpolicy');

  await t('start/end pairs, several windows, one past midnight', () => {
    const p = W.parsers.wartownpolicy.parse(['06:00', '12:00', '5:00', '23:00', '22:30', '02:00']);
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.windows.map((w) => w.text), ['06:00-12:00', '05:00-23:00', '22:30-02:00']);
    assert.deepStrictEqual(parseGoals('wartownpolicy 06:00 12:00').errors, [], 'goals.js knows the goal');
  });

  await t('mistakes are reported, not guessed at', () => {
    assert.match(W.parsers.wartownpolicy.parse(['06:00']).errors[0], /pairs/);
    assert.match(W.parsers.wartownpolicy.parse(['6', '12:00']).errors[0], /not a time/);
    assert.match(W.parsers.wartownpolicy.parse(['06:00', '25:00']).errors[0], /not a time/);
    assert.match(W.parsers.wartownpolicy.parse(['06:00', '06:00']).errors[0], /same time/);
    assert.match(W.parsers.wartownpolicy.parse([]).errors[0], /expected/);
    assert.deepStrictEqual(W.parsers.wartownpolicy.parse(['00:00', '24:00']).errors, [], '24:00 is the end of the day');
  });

  await t('the lockdown holds inside the hours and lifts outside them', () => {
    const c = city('A', 100, 100);
    const src = 'config wartown:1\nwartownpolicy 06:00 12:00';
    NOW = at(8);
    assert.strictEqual(W.isWarTown(ctxFor(c, src)), 1);
    NOW = at(12);
    assert.strictEqual(W.isWarTown(ctxFor(c, src)), 0, '12:00 is the end');
    NOW = at(14);
    const l = W.lockdown(ctxFor(c, src));
    assert.strictEqual(l.on, false);
    has(l.why, 'next 06:00-12:00');
    NOW = at(8);
  });

  await t('a window past midnight holds at 23:30 and 01:00, not at 03:00', () => {
    const c = city('A', 100, 100);
    const src = 'config wartown:2\nwartownpolicy 22:00 02:00';
    NOW = at(23, 30); assert.strictEqual(W.isWarTown(ctxFor(c, src)), 2);
    NOW = at(1); assert.strictEqual(W.isWarTown(ctxFor(c, src)), 2);
    NOW = at(3); assert.strictEqual(W.isWarTown(ctxFor(c, src)), 0);
    NOW = at(8);
  });

  await t('no effect without config wartown:1 or 2 (wiki), and the plan says so', () => {
    const c = city('A', 100, 100);
    assert.strictEqual(W.isWarTown(ctxFor(c, 'wartownpolicy 06:00 12:00')), 0);
    assert.strictEqual(W.isWarTown(ctxFor(c, 'config wartown:0\nwartownpolicy 06:00 12:00')), 0);
    has(W.plans.wartown(ctxFor(c, 'wartownpolicy 06:00 12:00'), {}).note, 'needs config wartown:1 or 2');
  });

  await t('outside the hours the plan says when the lockdown starts', () => {
    NOW = at(14);
    const p = W.plans.wartown(ctxFor(city('A', 100, 100), 'config wartown:1\nwartownpolicy 06:00 12:00'), {});
    NOW = at(8);
    assert.strictEqual(p.lockdown, false);
    has(p.note, 'normal troop movement until 06:00');
  });

  // ============================================================ the recall
  section('switching war town on recalls this city\'s marches, once');

  await t("only armies that left THIS city, each with this city's castle id", () => {
    const a = city('A', 100, 100), b = city('B', 120, 100);
    const ctx = ctxFor(a, 'config wartown:1', { others: [b], selfArmys: [march(a, 11), march(b, 12), march(a, 13)] });
    const p = W.plans.wartown(ctx, {});
    assert.deepStrictEqual(p.actions.map((x) => [x.armyId, x.castleId]), [[11, a.castleId], [13, a.castleId]]);
    assert.ok(p.actions.every((x) => x.kind === 'recallArmy' && x.wartown));
  });

  await t('marches already coming home are left to arrive; camped armies stay where they are', () => {
    const a = city('A', 100, 100);
    const ctx = ctxFor(a, 'config wartown:1', { selfArmys: [
      march(a, 11, { direction: 2 }),
      march(a, 12, { direction: 3, missionType: C.MISSION.reinforce, targetPosName: "an ally's city" }),
      march(a, 13, { direction: 3 }),
    ] });
    const p = W.plans.wartown(ctx, {});
    assert.deepStrictEqual(p.actions, []);
    has(p.note, '2 camped elsewhere stay where they are');
  });

  await t('a reinforcement still on its way out is a march from the city and is recalled', () => {
    const a = city('A', 100, 100);
    const p = W.plans.wartown(ctxFor(a, 'config wartown:1', { selfArmys: [march(a, 21, { missionType: C.MISSION.reinforce })] }), {});
    assert.deepStrictEqual(p.actions.map((x) => x.armyId), [21]);
    has(p.actions[0].label, 'reinforce to 1,1');
  });

  await t('the hide march is never recalled', () => {
    const a = city('A', 100, 100);
    const hideTo = C.coordsToFieldId(110, 105);
    const state = { war: { hide: { armyId: null, targetFieldId: hideTo, missionType: C.MISSION.transport } } };
    const ctx = ctxFor(a, 'config wartown:2', { selfArmys: [march(a, 31, { targetFieldId: hideTo, missionType: C.MISSION.transport })] });
    const p = W.plans.wartown(ctx, state);
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'the hide march is not recalled');
  });

  await t("wartown:1 leaves the traininghero's own move alone; wartown:2 brings it back like any march", () => {
    const a = city('A', 100, 100);
    const armies = [march(a, 41, { hero: 'Otto', missionType: C.MISSION.reinforce }), march(a, 42)];
    const one = W.plans.wartown(ctxFor(a, 'config wartown:1\ntraininghero Otto 30 60', { selfArmys: armies }), {});
    assert.deepStrictEqual(one.actions.map((x) => x.armyId), [42]);
    has(one.note, 'the traininghero on its way (war town 1) is not recalled');
    const two = W.plans.wartown(ctxFor(a, 'config wartown:2\ntraininghero Otto 30 60', { selfArmys: armies }), {});
    assert.deepStrictEqual(two.actions.map((x) => x.armyId), [41, 42]);
  });

  await t('no storm: once per army, again only if it is still heading out two minutes after the recall', () => {
    const a = city('A', 100, 100);
    const armies = [march(a, 11)];
    const ctx = ctxFor(a, 'config wartown:1', { selfArmys: armies });
    const state = {};
    assert.strictEqual(W.plans.wartown(ctx, state).actions.length, 1);
    state.war.wartown.recall[11] = { ...state.war.wartown.recall[11], sentAt: NOW, tries: 1 };   // what the executor records
    NOW += 60000;
    assert.strictEqual(W.plans.wartown(ctx, state).actions.length, 0, 'a minute later it is still turning round');
    NOW += 60000;
    assert.strictEqual(W.plans.wartown(ctx, state).actions.length, 1, 'two minutes on and still heading out: once more');
    armies[0].direction = 2;                       // it turned round
    NOW += 180000;
    const p = W.plans.wartown(ctx, state);
    assert.strictEqual(p.actions.length, 0);
    assert.deepStrictEqual(state.war.wartown.targets, [], 'done with it for good');
    NOW = at(8);
  });

  await t('a recall that was planned but never sent (a dry run) is planned again next tick', () => {
    const a = city('A', 100, 100);
    const ctx = ctxFor(a, 'config wartown:1', { selfArmys: [march(a, 11)] });
    const state = {};
    W.plans.wartown(ctx, state);
    NOW += 60000;
    assert.strictEqual(W.plans.wartown(ctx, state).actions.length, 1);
    NOW = at(8);
  });

  await t('three recalls that do not turn it round, then it says so and stops', () => {
    const a = city('A', 100, 100);
    const ctx = ctxFor(a, 'config wartown:1', { selfArmys: [march(a, 11)] });
    const state = {};
    W.plans.wartown(ctx, state);
    state.war.wartown.recall[11] = { plannedAt: NOW, sentAt: NOW, tries: 3, error: 'army can not be recalled' };
    NOW += 180000;
    const p = W.plans.wartown(ctx, state);
    NOW = at(8);
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'would not turn back after 3 recalls (army can not be recalled) — recall it by hand');
  });

  await t('marches sent after war town went on are left alone', () => {
    const a = city('A', 100, 100);
    const armies = [march(a, 11)];
    const ctx = ctxFor(a, 'config wartown:1', { selfArmys: armies });
    const state = {};
    W.plans.wartown(ctx, state);
    armies.push(march(a, 12));                     // sent by hand, or by a script
    const p = W.plans.wartown(ctx, state);
    assert.deepStrictEqual(p.actions, []);
    has(p.note, '1 other march(es) heading out are left alone');
  });

  await t('a wartownpolicy window opening later recalls nothing — the runs finish and come home', () => {
    const a = city('A', 100, 100);
    const ctx = ctxFor(a, 'config wartown:1\nwartownpolicy 06:00 12:00', { selfArmys: [march(a, 11)] });
    const state = {};
    NOW = at(5, 30);
    assert.deepStrictEqual(W.plans.wartown(ctx, state).actions, [], 'switched on outside the hours');
    NOW = at(6, 1);
    const p = W.plans.wartown(ctx, state);
    NOW = at(8);
    assert.strictEqual(p.lockdown, true);
    assert.deepStrictEqual(p.actions, []);
  });

  await t('lifting war town clears the record; switching it on again recalls afresh', () => {
    const a = city('A', 100, 100);
    const state = {};
    const on = ctxFor(a, 'config wartown:1', { selfArmys: [march(a, 11)] });
    W.plans.wartown(on, state);
    const off = W.plans.wartown(ctxFor(a, 'config wartown:0', { selfArmys: [march(a, 11)] }), state);
    has(off.note, 'lifted');
    assert.strictEqual(state.war.wartown.targets, undefined);
    assert.strictEqual(W.plans.wartown(on, state).actions.length, 1);
  });

  await t('the executor recalls with the castle id on the action and counts the attempt', async () => {
    const a = city('A', 100, 100);
    const game = fakeGame([a]);
    const state = { war: { hide: { armyId: null, targetFieldId: 5, missionType: 1 } } };
    await W.executors.recallArmy(game, a, { kind: 'recallArmy', wartown: true, armyId: 77, castleId: 555 }, state);
    assert.deepStrictEqual(game.reqs[0], ['army.callBackArmy', { castleId: 555, armyId: 77 }]);
    assert.ok(state.war.hide, 'a war town recall does not wipe the hide record');
    assert.deepStrictEqual([state.war.wartown.recall[77].tries, state.war.wartown.recall[77].sentAt], [1, NOW]);
    game.req = async () => ({ ok: -1, errorMsg: 'nope' });
    await W.executors.recallArmy(game, a, { kind: 'recallArmy', wartown: true, armyId: 77, castleId: 555 }, state);
    assert.deepStrictEqual([state.war.wartown.recall[77].tries, state.war.wartown.recall[77].error], [2, 'nope']);
  });

  await t("engine: a war town recalls its own march once, never another city's, and not again next tick", async () => {
    const a = city('A', 100, 100), b = city('B', 120, 100);
    const armies = [march(a, 501), march(b, 502), march(a, 503, { direction: 2 })];
    const { e, game } = engineFor([a, b], { A: 'config wartown:1' }, { selfArmys: armies });
    await e.tick();
    assert.deepStrictEqual(recalls(game), [{ castleId: a.castleId, armyId: 501 }]);
    await e.tick();
    assert.strictEqual(recalls(game).length, 1, 'the next tick sent nothing more');
    NOW += 3 * 60000;
    await e.tick();
    assert.strictEqual(recalls(game).length, 2, 'still heading out three minutes later: one retry');
    armies[0].direction = 2;
    NOW += 3 * 60000;
    await e.tick();
    NOW = at(8);
    assert.strictEqual(recalls(game).length, 2);
  });

  await t("engine: the console's War Town Mode recalls just as the config key does", async () => {
    const a = city('A', 100, 100);
    const { e, game } = engineFor([a], { A: 'config comfort:0' }, { selfArmys: [march(a, 601)], controls: { A: { wartown: 1 } } });
    await e.tick();
    assert.deepStrictEqual(recalls(game), [{ castleId: a.castleId, armyId: 601 }]);
  });

  // ===================================================== the lockdown holds
  section('the lockdown holds npc farming, transfers, buildnpc and the traininghero');

  await t('npc: no farming runs from a war town', () => {
    const c = city('A', 100, 100, { heros: farmers() });
    assert.ok(npcPlan(c, 'config npc:5').actions.length > 0, 'farms when not at war');
    const p = npcPlan(c, 'config npc:5,wartown:1');
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'held: war town 1 (config)');
    assert.deepStrictEqual(npcPlan(c, 'config npc:5,wartown:2').actions, []);
  });

  await t("npc: the console's mode holds farming too, and wartownpolicy only inside its hours", () => {
    const c = city('A', 100, 100, { heros: farmers() });
    assert.deepStrictEqual(npcPlan(c, 'config npc:5', { controls: { wartown: 2 } }).actions, []);
    NOW = at(8);
    assert.deepStrictEqual(npcPlan(c, 'config npc:5,wartown:1\nwartownpolicy 06:00 12:00').actions, []);
    NOW = at(14);
    assert.ok(npcPlan(c, 'config npc:5,wartown:1\nwartownpolicy 06:00 12:00').actions.length > 0, 'farms outside the hours');
    NOW = at(8);
  });

  await t('transfers: a war town sends nothing, the next city sends instead', () => {
    const here = city('Here', 100, 100, { resource: { food: { amount: 1e6 } } });
    const near = city('Near', 102, 100), far = city('Far', 130, 100);
    const game = fakeGame([here, near, far]);
    const parsed = parseGoals('requestresources any food 5b 100m * 50m /below:500m');
    const ctx = { game, castle: here, goals: parsed.goals, config: parsed.config, goalsOf: () => [], selfArmies: [] };
    const free = T.plans.transfer(ctx, {}, game);
    assert.strictEqual(free.actions[0].from.name, 'Near');
    const war = T.plans.transfer({ ...ctx, warTownOf: (c) => (c.name === 'Near' ? 1 : 0) }, {}, game);
    assert.deepStrictEqual(war.actions.map((a) => a.from.name), ['Far']);
    const all = T.plans.transfer({ ...ctx, warTownOf: (c) => (c.name === 'Here' ? 0 : 2) }, {}, game);
    assert.deepStrictEqual(all.actions, []);
    has(all.note, 'no sender — Near is a war town (2)');
  });

  await t('transfers: a war town still receives — supplies coming in move nothing out of it', () => {
    const here = city('Here', 100, 100, { resource: { food: { amount: 1e6 } } });
    const near = city('Near', 102, 100);
    const game = fakeGame([here, near]);
    const parsed = parseGoals('config wartown:2\nrequestresources any food 5b 100m * 50m /below:500m');
    const ctx = { game, castle: here, goals: parsed.goals, config: parsed.config, goalsOf: () => [], selfArmies: [],
      warTownOf: (c) => (c.name === 'Here' ? 2 : 0) };
    assert.strictEqual(T.plans.transfer(ctx, {}, game).actions.length, 1);
  });

  await t('engine: a sending city at war (config or console) sends no transport', async () => {
    const mk = () => [city('Fla', 100, 100, { resource: { food: { amount: 1e6 } } }), city('5', 102, 100)];
    let [fla, five] = mk();
    let r = engineFor([fla, five], { Fla: 'requestresources 5 food 5b 100m * 50m /below:500m', 5: 'config wartown:1' });
    await r.e.tick();
    assert.strictEqual(r.game.sent.length, 0, 'the war town sent a transport');
    has(r.e.lastReport[fla.castleId].transfer.note, '5 is a war town (1)');
    [fla, five] = mk();
    r = engineFor([fla, five], { Fla: 'requestresources 5 food 5b 100m * 50m /below:500m' }, { controls: { 5: { wartown: 2 } } });
    await r.e.tick();
    assert.strictEqual(r.game.sent.length, 0, 'the console war town sent a transport');
    [fla, five] = mk();
    r = engineFor([fla, five], { Fla: 'requestresources 5 food 5b 100m * 50m /below:500m' });
    await r.e.tick();
    assert.strictEqual(r.game.sent.length, 1, 'and without war town it does send');
  });

  await t('buildnpc stands down in a war town', () => {
    const c = city('A', 100, 100);
    const p = B.plans.buildnpc(ctxFor(c, 'config buildnpc:5,wartown:1', { ctx: { accountId: 'acct' } }), {}, fakeGame([c]));
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'standing down: war town 1');
    const free = B.plans.buildnpc(ctxFor(c, 'config buildnpc:5'), {}, fakeGame([c]));
    hasNot(free.note, 'war town');                 // on to its own checks (here: no account id)
  });

  await t('traininghero: wartown:2 keeps it in the war town, wartown:1 lets it go', async () => {
    const mk = () => {
      const a = city('A', 100, 100, { heros: [hero(9, 'Otto', 50)] });
      return [a, city('B', 110, 100)];
    };
    let [a, b] = mk();
    let r = engineFor([a, b], { A: 'config wartown:2\ntraininghero otto 0', B: 'traininghero otto 0' });
    await r.e.tick();
    assert.strictEqual(r.game.sent.length, 0, 'it left a wartown:2 city');
    assert.ok(r.lines.some((l) => /held: A is a war town \(2\), the traininghero stays there/.test(l)), r.lines.join('\n'));
    [a, b] = mk();
    r = engineFor([a, b], { A: 'config wartown:1\ntraininghero otto 0', B: 'traininghero otto 0' });
    await r.e.tick();
    assert.strictEqual(r.game.sent.length, 1, 'wartown:1 should let it move');
    assert.strictEqual(r.game.sent[0].bean.missionType, C.MISSION.reinforce);
  });

  await t('traininghero: it may move INTO a wartown:2 city, and the console mode 2 holds it too', async () => {
    let a = city('A', 100, 100, { heros: [hero(9, 'Otto', 50)] }), b = city('B', 110, 100);
    let r = engineFor([a, b], { A: 'traininghero otto 0', B: 'config wartown:2\ntraininghero otto 0' });
    await r.e.tick();
    assert.strictEqual(r.game.sent.length, 1, 'moving into a war town is allowed');
    a = city('A', 100, 100, { heros: [hero(9, 'Otto', 50)] }); b = city('B', 110, 100);
    r = engineFor([a, b], { A: 'traininghero otto 0', B: 'traininghero otto 0' }, { controls: { A: { wartown: 2 } } });
    await r.e.tick();
    assert.strictEqual(r.game.sent.length, 0, 'the console override is the same as the config key');
  });

  await t('hiding is NOT held: a war town under attack still evades', () => {
    const home = city('Home', 200, 300, { heros: [hero(1, 'Hider', 100)] });
    const ctx = ctxFor(home, 'config hiding:2,wartown:2', { others: [city('Refuge', 210, 305)], incoming: [wave(90000, 1)] });
    assert.strictEqual(W.plans.hiding(ctx, {}).actions[0].kind, 'hideTroops');
  });

  // ============================================== keepatthome / homeheroes
  section('keepatthome and homeheroes');

  await t('keepatthome is on/off: 1 on, 0 off, 2 reported and read as on, junk reported and off', () => {
    assert.strictEqual(W.parsers.keepatthome.parse(1).on, true);
    assert.strictEqual(W.parsers.keepatthome.parse(0).on, false);
    assert.strictEqual(W.parsers.keepatthome.parse(undefined).on, false, 'the wiki default is 0');
    const two = W.parsers.keepatthome.parse(2);
    assert.deepStrictEqual([two.on, two.errors.length > 0], [true, true]);
    const junk = W.parsers.keepatthome.parse('lots');
    assert.deepStrictEqual([junk.on, junk.errors.length > 0], [false, true]);
  });

  await t('the kept hero: the best attack hero, never the traininghero, the second best while training', () => {
    const c = city('A', 100, 100, { heros: farmers() });
    assert.strictEqual(W.keepAttHome(ctxFor(c, 'config keepatthome:1')).hero.name, 'Strong');
    assert.strictEqual(W.keepAttHome(ctxFor(c, 'config keepatthome:1\ntraininghero Strong')).hero.name, 'Brawler');
    assert.strictEqual(W.keepAttHome(ctxFor(c, 'config keepatthome:1,training:1')).hero.name, 'Brawler');
    assert.strictEqual(W.keepAttHome(ctxFor(c, 'config keepatthome:1,training10:1')).hero.name, 'Brawler');
    assert.strictEqual(W.keepAttHome(ctxFor(c, 'config keepatthome:0')).hero, null);
  });

  await t('the mayor and captives are never the kept hero', () => {
    const heros = [hero(1, 'Mayor', 400, { status: 1 }), hero(2, 'Prisoner', 300, { status: 4 }), hero(3, 'Guard', 100)];
    assert.strictEqual(W.keepAttHome(ctxFor(city('A', 100, 100, { heros }), 'config keepatthome:1')).hero.name, 'Guard');
  });

  await t('npc farming never sends the keepatthome hero', () => {
    const c = city('A', 100, 100, { heros: farmers() });
    const p = npcPlan(c, 'config npc:5,keepatthome:1');
    assert.ok(p.actions.length >= 3, p.note);
    assert.ok(!npcHeroes(p).includes('Strong'), npcHeroes(p).join(','));
    assert.ok(npcHeroes(npcPlan(c, 'config npc:5')).includes('Strong'), 'without it Strong farms first');
    const training = npcPlan(c, 'config npc:5,keepatthome:1,training:1');
    assert.ok(npcHeroes(training).includes('Strong') && !npcHeroes(training).includes('Brawler'),
      'with training on the best trains and the second best stays');
  });

  await t('npc: when the kept hero is the only one home, the note says why nothing goes', () => {
    const c = city('A', 100, 100, { heros: [hero(1, 'Strong', 150)] });
    const p = npcPlan(c, 'config npc:5,keepatthome:1');
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'Strong is the only idle hero for "any" and keepatthome keeps it home');
  });

  await t('homeheroes N leaves N heroes home while farming; the mayor does not count', () => {
    const c = city('A', 100, 100, { heros: farmers() });
    const p = npcPlan(c, 'config npc:5\nhomeheroes 2');
    assert.deepStrictEqual(npcHeroes(p), ['Strong', 'Brawler'], 'the two strongest farm, two stay (the mayor is extra)');
    has(p.note, 'homeheroes 2: Middling, Weakling stay home');
    assert.strictEqual(npcHeroes(npcPlan(c, 'config npc:5\nhomeheroes 4')).length, 0);
    assert.strictEqual(npcHeroes(npcPlan(c, 'config npc:5')).length, 4, 'without it every free hero farms');
  });

  await t('homeheroes with a custom npcheroes list keeps N of the LISTED heroes home', () => {
    const c = city('A', 100, 100, { heros: farmers() });
    const p = npcPlan(c, 'config npc:5\nnpcheroes Strong,Brawler,Middling\nhomeheroes 1');
    assert.deepStrictEqual(npcHeroes(p), ['Strong', 'Brawler'], 'Weakling is not on the list, so it is not one of the N');
  });

  await t('keepatthome + homeheroes: the kept hero is one of the heroes at home', () => {
    const c = city('A', 100, 100, { heros: farmers() });
    const p = npcPlan(c, 'config npc:5,keepatthome:1\nhomeheroes 1');
    assert.deepStrictEqual(npcHeroes(p).sort(), ['Brawler', 'Middling', 'Weakling']);
  });

  await t("hiding takes a hero no rule holds before keepatthome's defender", () => {
    const home = city('Home', 200, 300, { heros: [hero(1, 'Strong', 150), hero(2, 'Middling', 80)] });
    const ctx = ctxFor(home, 'config hiding:2,keepatthome:1', { others: [city('Refuge', 210, 305)], incoming: [wave(90000, 1)] });
    const a = W.plans.hiding(ctx, {}).actions[0];
    assert.strictEqual(a.heroId, 2, 'Strong stays home to defend');
  });

  await t('hiding uses the keepatthome hero when it is the only one home — that is what it is for (wiki Hiding)', () => {
    const home = city('Home', 200, 300, { heros: [hero(1, 'Strong', 150), hero(2, 'Out', 80, { status: 8 })] });
    const ctx = ctxFor(home, 'config hiding:2,keepatthome:1', { others: [city('Refuge', 210, 305)], incoming: [wave(90000, 1)] });
    const p = W.plans.hiding(ctx, {});
    assert.strictEqual(p.actions[0].heroId, 1);
    has(p.note, 'led by Strong, the keepatthome hero, as nobody else is home');
  });

  await t('hiding takes the traininghero only when nobody else is home; homeheroes does not stop it', () => {
    const refuge = city('Refuge', 210, 305);
    let home = city('Home', 200, 300, { heros: [hero(1, 'Otto', 300), hero(2, 'Middling', 80)] });
    let ctx = ctxFor(home, 'config hiding:2\ntraininghero Otto 30 60', { others: [refuge], incoming: [wave(90000, 1)] });
    assert.strictEqual(W.plans.hiding(ctx, {}).actions[0].heroId, 2);
    home = city('Home', 200, 300, { heros: [hero(1, 'Otto', 300)] });
    ctx = ctxFor(home, 'config hiding:2\ntraininghero Otto 30 60', { others: [refuge], incoming: [wave(90000, 1)] });
    const p = W.plans.hiding(ctx, {});
    assert.strictEqual(p.actions[0].heroId, 1);
    has(p.note, 'the traininghero, as nobody else is home');
    home = city('Home', 200, 300, { heros: [hero(2, 'Middling', 80)] });
    ctx = ctxFor(home, 'config hiding:2\nhomeheroes 1', { others: [refuge], incoming: [wave(90000, 1)] });
    assert.strictEqual(W.plans.hiding(ctx, {}).actions[0].heroId, 2, 'homeheroes holds heroes back from farming, not from evading');
  });

  // Step 2 sends the hide march first in the slice and holds the mayor swap in
  // the slice it took a hero. The keep-home pick goes through the same path.
  await t("engine: the hide march takes keepatthome's hero when nobody else is in, and the mayor swap waits", async () => {
    const home = city('Home', 200, 300, { heros: [hero(1, 'Strong', 150, { management: 300 }), hero(2, 'OldMayor', 40, { status: 1, management: 50 })] });
    const refuge = city('Refuge', 210, 305);
    const game = fakeGame([home, refuge]);
    game.player.enemyArmys = [{ ...wave(90000, 1), direction: 1, targetFieldId: home.fieldId }];
    const e = new Engine(game, () => {});
    e.dryRun = false;
    e.state = {};
    e.goalsFor = (id, name) => parseGoals(name === 'Home' ? 'config hiding:2,keepatthome:1' : 'config hero:0');
    const r = await e.focus(home);
    assert.strictEqual(game.sent.length, 1, r.acted.join(' | '));
    assert.strictEqual(game.sent[0].bean.heroId, 1, 'Strong led the hide march');
    has(r.hiding.note, 'led by Strong, the keepatthome hero, as nobody else is home');
    assert.deepStrictEqual([game.discharged, game.promoted], [[], []], 'the mayor was swapped for the hero that just marched out');
    has(r.mayor.note, 'held this slice');
  });

  await t('the constraints note names the kept hero, and a stand-in while it is out', () => {
    const heros = [hero(1, 'Strong', 150, { status: 3 }), hero(2, 'Middling', 80)];
    const p = W.plans.constraints(ctxFor(city('A', 100, 100, { heros }), 'config keepatthome:1'), {});
    has(p.note, 'keepatthome: Strong, the best attack hero, is out — Middling stays home until it is back');
  });

  // ===================================================== attackgap (NEAT)
  section('attackgap groups incoming waves into attacks');

  await t('the NEAT default is 6 s: 3 s apart is one attack, 7 s apart two', () => {
    const c = city('A', 100, 100);
    const g = W.attackGroups(ctxFor(c, '', { incoming: [wave(60000, 1), wave(63000, 2), wave(70000, 3)] }));
    assert.strictEqual(g.gapMs, 6000);
    assert.deepStrictEqual(g.groups.map((x) => x.waves.length), [2, 1]);
  });

  await t('waves exactly attackgap apart are separate attacks (wiki: "at least")', () => {
    const c = city('A', 100, 100);
    const g = W.attackGroups(ctxFor(c, 'config attackgap:3', { incoming: [wave(60000, 1), wave(63000, 2), wave(70000, 3)] }));
    assert.strictEqual(g.groups.length, 3);
  });

  await t('a chain of close waves is one attack, however long the chain', () => {
    const c = city('A', 100, 100);
    const g = W.attackGroups(ctxFor(c, '', { incoming: [0, 5, 10, 15, 20].map((s, i) => wave(60000 + s * 1000, i + 1)) }));
    assert.strictEqual(g.groups.length, 1);
  });

  await t('junk waves (defensepolicy /junktroop) and waves with no arrival time are not attacks', () => {
    const c = city('A', 100, 100);
    const incoming = [wave(60000, 1), wave(90000, 2, { archer: '400' }), { armyId: 3, troop: { archer: '9000' } }];
    const g = W.attackGroups(ctxFor(c, 'defensepolicy /junktroop:500', { incoming }));
    assert.deepStrictEqual([g.waves, g.groups.length, g.untimed], [1, 1, 1]);
  });

  await t('the constraints note counts separate attacks', () => {
    const c = city('A', 100, 100);
    const p = W.plans.constraints(ctxFor(c, 'config attackgap:10', { incoming: [wave(60000, 1), wave(65000, 2), wave(300000, 3)] }), {});
    has(p.note, 'attackgap 10s: 3 wave(s) inbound = 2 separate attack(s)');
  });

  // =============================================== defensecooldown (NEAT)
  section('defensecooldown is the under-attack window');

  await t('under attack while a real wave is inbound, and for defensecooldown after it lands', () => {
    const c = city('A', 100, 100);
    const state = {};
    const ctx = ctxFor(c, 'config defensecooldown:10', { incoming: [wave(60000, 1)] });
    let u = W.underAttack(ctx, state);
    assert.deepStrictEqual([u.on, u.inbound], [true, 1]);
    NOW += 120000; ctx.incoming = [];               // it landed a minute ago and has gone from the list
    u = W.underAttack(ctx, state);
    assert.deepStrictEqual([u.on, u.inbound, u.leftMs], [true, 0, 9 * 60000]);
    NOW += 9 * 60000;
    assert.strictEqual(W.underAttack(ctx, state).on, false, 'ten minutes after the hit it is over');
    NOW = at(8);
  });

  await t('a recalled attack starts the cooldown when it disappears', () => {
    const c = city('A', 100, 100);
    const state = {};
    const ctx = ctxFor(c, 'config defensecooldown:5', { incoming: [wave(20 * 60000, 1)] });
    W.underAttack(ctx, state);
    NOW += 60000; ctx.incoming = [];                // gone 19 minutes early: recalled
    const u = W.underAttack(ctx, state);
    NOW = at(8);
    assert.deepStrictEqual([u.on, u.leftMs], [true, 5 * 60000]);
  });

  await t('junk never starts it; /junktroop:0 makes everything count', () => {
    const c = city('A', 100, 100);
    const poke = [wave(60000, 1, { militia: '3' })];
    const state = {};
    const ctx = ctxFor(c, '', { incoming: poke });
    assert.strictEqual(W.underAttack(ctx, state).on, false);
    NOW += 120000; ctx.incoming = [];
    assert.strictEqual(W.underAttack(ctx, state).on, false, 'a junk hit starts no cooldown');
    NOW = at(8);
    assert.strictEqual(W.underAttack(ctxFor(c, 'defensepolicy /junktroop:0', { incoming: poke }), {}).on, true);
  });

  await t('the NEAT default is 30 minutes; defensecooldown:0 ends it at the hit', () => {
    assert.strictEqual(W.parsers.defensecooldown.parse(undefined).cooldownMs, 30 * 60000);
    assert.ok(W.parsers.defensecooldown.parse('soon').errors.length, 'junk is reported');
    assert.strictEqual(W.parsers.defensecooldown.parse('soon').cooldownMs, 30 * 60000, 'and falls back to the default, not 0');
    const c = city('A', 100, 100);
    const state = {};
    const ctx = ctxFor(c, 'config defensecooldown:0', { incoming: [wave(30000, 1)] });
    W.underAttack(ctx, state);
    NOW += 60000; ctx.incoming = [];
    const u = W.underAttack(ctx, state);
    NOW = at(8);
    assert.strictEqual(u.on, false);
  });

  await t('the window shows in the tick note even with nothing configured', () => {
    const c = city('A', 100, 100);
    const state = {};
    const ctx = ctxFor(c, 'config comfort:1', { incoming: [wave(60000, 1)] });
    has(W.plans.constraints(ctx, state).note, 'defensecooldown 30 min: under attack — 1 real wave(s) inbound');
    NOW += 120000; ctx.incoming = [];
    has(W.plans.constraints(ctx, state).note, 'under attack for another 29:00');
    NOW = at(8);
    const quiet = {};
    assert.strictEqual(W.plans.constraints(ctxFor(c, 'config comfort:1'), quiet), null, 'quiet and unset: no note');
    assert.strictEqual(quiet.war, undefined, 'and nothing written into a quiet city\'s state');
  });

  await t("one window: defensepolicy's items and the defensecooldown note read the same record", () => {
    const c = city('A', 100, 100);
    const state = {};
    const ctx = ctxFor(c, 'config defensecooldown:10\ndefensepolicy /usewarhorn:1', { incoming: [wave(60000, 1)] });
    M.defensePlan(ctx, state);                     // sees the wave coming
    NOW += 120000; ctx.incoming = [];              // it landed a minute ago
    const p = M.defensePlan(ctx, state);
    const note = W.plans.constraints(ctx, state).note;
    NOW = at(8);
    has(p.note, 'under attack for another 9 min (defensecooldown)');
    has(note, 'under attack for another 09:00');
    assert.strictEqual(state.defence.attackSeen, undefined, 'no second, private window');
  });

  await t('defensecooldown no longer holds the gate (gatepolicy /mintoggle paces it)', () => {
    const c = city('A', 100, 100);
    const ctx = ctxFor(c, 'config gate:1,defensecooldown:30\ngatepolicy 1 1 2 0 1');
    const state = { war: { gate: { lastAt: NOW - 60000 } } };
    assert.strictEqual(W.plans.gate(ctx, state).actions.length, 1);
    const held = W.plans.gate(ctxFor(c, 'config gate:1\ngatepolicy 1 1 2 0 1 /mintoggle:120'), state);
    assert.deepStrictEqual(held.actions, []);
  });

  // ================================================== the live goal files
  section('the saved goals behave as before');

  // Lord02's city goals (live-goals.txt, comments dropped): no war goal, so
  // nothing may change for them. The requestresources lines are in NEAT's order,
  // as migrate-goals-transfer.js rewrites them (Step 9).
  const LORD02 = `config comfort:1,hero:1,troopsusepopmax:1,npc:5
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
build fh:1
build th:10,w:10,c:10:1,b:10:1,a:10:1,r:10:1,be:10:1,rs:10:1
build f:10:37
troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k
fortification ab:5000
distancepolicy 15
npcteams 3
requestresources any gold 2000000 200000 * 500000 /below:1000000
requestresources any wood 2000000 200000 * 500000 /below:100000
requestresources any stone 50000000 10000000 * 5000000 /below:5000000
requestresources any iron 500000000 100000000 * 20000000 /below:50000000
requestresources any food 5000000000 1000000000 * 50000000 /below:500000000
traininghero OTTO 30 60
npcheroes !OTTO,any
farmingpolicy 10 /distance:5
farmingpolicy 5 /distance:10`;

  await t('Lord02: parses clean, is no war town, keeps nobody home, and still farms without OTTO', () => {
    const heros = [hero(1, 'OTTO', 300), ...farmers()];
    const c = city('F', 100, 100, { heros });
    const ctx = ctxFor(c, LORD02);
    assert.strictEqual(W.isWarTown(ctx), 0);
    assert.strictEqual(W.keepAttHome(ctx).hero, null);
    assert.strictEqual(W.plans.wartown(ctx, {}), null);
    const p = npcPlan(c, LORD02);
    assert.strictEqual(p.actions.length, 3, p.note);
    assert.ok(!npcHeroes(p).includes('OTTO'));
  });

  await t("Lord22: parses clean; its defensepolicy /junktroop:5000 is the junk line for the under-attack window", () => {
    const LORD22 = `config comfort:1,hero:1,troopsusepopmax:1
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
build f:10:37,s:0:0,i:0:0,q:0:0
troop b:5k,t:5k
troop a:100k,s:100k
fortification ab:5000`;
    const c = city('E', 100, 100);
    assert.strictEqual(W.underAttack(ctxFor(c, LORD22, { incoming: [wave(60000, 1, { archer: '4000' })] }), {}).on, false);
    assert.strictEqual(W.underAttack(ctxFor(c, LORD22, { incoming: [wave(60000, 1, { archer: '6000' })] }), {}).on, true);
    assert.strictEqual(W.plans.constraints(ctxFor(c, LORD22), {}), null, 'quiet: no new note on a quiet city');
  });

  await t('describe: one plain line per rule', () => {
    const lines = W.describe(parseGoals('config wartown:2,keepatthome:1,attackgap:3,defensecooldown:10\nwartownpolicy 06:00 12:00'));
    has(lines.join('\n'), 'wartown 2: no npc farming, buildnpc or transfers out of this city during 06:00-12:00, traininghero stays once it lands here');
    has(lines.join('\n'), 'wartownpolicy: war town only during 06:00-12:00');
    has(lines.join('\n'), 'keepatthome: the best attack hero');
    has(lines.join('\n'), 'attackgap: incoming waves 3s or more apart are separate attacks');
    has(lines.join('\n'), 'defensecooldown: still under attack 10 min after the last real wave lands or is recalled');
  });

  // ============================ the console's manual War Town Mode switch
  // The user, 2026-09-24: "does the manual switch at the top of the page work for wartown
  // 0/1/2?" The whole chain, offline: the page posts to /api/wartown, which calls
  // Session.setWarTown -> setControls (settings key cityControls:<account>), and the engine
  // reads it back per city through controlsFor. Auto hands the city back to its goals; 0
  // BEATS a config wartown: line in the goals rather than deferring to it.
  section("the console manual switch (War Town Mode)");

  await t('setWarTown takes auto, 0, 1 and 2 and refuses anything else', () => {
    const org = D.org(D.orgs.create("WT").id);
    const acc = org.accounts.upsert({ label: "WT1", email: "wt1@x.com", password: "x" });
    const { Session } = require("./session");
    const S = new Session(acc.id);
    const a = city("A", 100, 100);
    S.game = fakeGame([a]);
    for (const [mode, want] of [["auto", "auto"], [0, 0], [1, 1], [2, 2], ["2", 2]]) {
      const r = S.setWarTown(a.castleId, mode);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.controls.wartown, want, `mode ${JSON.stringify(mode)}`);
      assert.strictEqual(S.controls(a.castleId).wartown, want, "and it reads back");
    }
    for (const bad of [3, -1, "on", "", null]) {
      assert.throws(() => S.setWarTown(a.castleId, bad), /war town mode must be auto, 0, 1 or 2/, String(bad));
    }
    // it is kept per city, in the account's own settings, so a restart does not lose it
    const b = city("B", 101, 100);
    S.game = fakeGame([a, b]);
    S.setWarTown(a.castleId, 2);
    assert.strictEqual(S.controls(b.castleId).wartown, "auto", "another city is untouched");
    const saved = org.settings.get("cityControls:" + acc.id, null);
    assert.strictEqual(saved[String(a.castleId)].wartown, 2, "written to the settings");
  });

  await t('the switch drives the engine: 1 and 2 lock down, 0 beats the goals, auto defers', async () => {
    const org = D.org(D.orgs.create("WT2").id);
    const acc = org.accounts.upsert({ label: "WT2", email: "wt2@x.com", password: "x" });
    const { Session } = require("./session");
    const S = new Session(acc.id);
    // the city carries config wartown:2 in its goals, so "Off" has something to beat
    const src = ["config wartown:2", "keeptroops Main cp:100k"].join(String.fromCharCode(10));
    const mk = () => [
      city("War", 100, 100, { troop: { catapult: 500000, carriage: 20000, scouter: 1000 } }),
      city("Main", 102, 100, { troop: { catapult: 0, carriage: 0, scouter: 1000 } }),
    ];
    for (const [mode, sends, why] of [["auto", 0, "the goals still say wartown:2"],
      [2, 0, "on"], [1, 0, "on"], [0, 1, "off beats config wartown:2"]]) {
      const [war, main] = mk();
      S.game = fakeGame([war, main]);
      S.setWarTown(war.castleId, mode);
      const r = engineFor([war, main], { War: src, Main: "" });
      r.e.controlsFor = (c) => S.controls(r.game.castleId(c));
      await r.e.tick();
      assert.strictEqual(r.game.sent.length, sends, `mode ${mode}: ${why}`);
    }
  });

  // The bug this was written for (a7 Lord07 city 5, 2026-09-24): every trading account
  // carries "config wartown:1 + wartownpolicy 05:00 10:00" in its ACCOUNT APPEND goals, and
  // that policy line was also scheduling the mode set BY HAND from the console. Outside the
  // hours the switch read as Off and the city shipped 100,000 catapults to main.
  await t('the switch is not scheduled: wartownpolicy hours do not lift a hand-set mode', async () => {
    const org = D.org(D.orgs.create("WT3").id);
    const acc = org.accounts.upsert({ label: "WT3", email: "wt3@x.com", password: "x" });
    const { Session } = require("./session");
    const S = new Session(acc.id);
    const src = ["config wartown:1", "wartownpolicy 05:00 10:00", "keeptroops Main cp:100k"].join(String.fromCharCode(10));
    const mk = () => [
      city("War", 100, 100, { troop: { catapult: 500000, carriage: 20000, scouter: 1000 } }),
      city("Main", 102, 100, { troop: { catapult: 0, carriage: 0, scouter: 1000 } }),
    ];
    NOW = at(13);                                   // outside 05:00-10:00
    {                                               // the goals own line stays scheduled
      const [war, main] = mk();
      const r = engineFor([war, main], { War: src, Main: "" });
      await r.e.tick();
      assert.strictEqual(r.game.sent.length, 1, "config wartown: alone still follows wartownpolicy");
    }
    for (const mode of [1, 2]) {                    // the console switch is not
      const [war, main] = mk();
      S.game = fakeGame([war, main]);
      S.setWarTown(war.castleId, mode);
      const r = engineFor([war, main], { War: src, Main: "" });
      r.e.controlsFor = (c) => S.controls(r.game.castleId(c));
      await r.e.tick();
      assert.strictEqual(r.game.sent.length, 0,
        `War Town Mode ${mode} set by hand must hold outside the wartownpolicy hours`);
      assert.strictEqual(W.isWarTown(ctxFor(war, src, { controls: { wartown: mode } })), mode);
    }
    NOW = at(8);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(path.dirname(process.env.EVONY_DB), { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
