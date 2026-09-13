'use strict';
// Offline tests for goal-war.js. Fixture objects only — nothing here connects,
// logs in, or sends a byte. Run with:  node test-war.js
const assert = require('assert');
const C = require('./constants');
const W = require('./goal-war');

const { durationMs, count, normalizeArmy, classify, threatsOf, hhmmss } = W._internals;

let pass = 0, fail = 0;
const results = [];
const queue = [];              // async tests are run in order after the sync pass
function record(slot, name, err) {
  if (err) { fail++; results[slot] = ['FAIL', `${name}\n        ${err.message}`]; }
  else { pass++; results[slot] = ['ok  ', name]; }
}
function test(name, fn) {
  const slot = results.push(['....', name]) - 1;
  let out;
  try { out = fn(); } catch (e) { record(slot, name, e); return; }
  if (out && typeof out.then === 'function') {
    queue.push(out.then(() => record(slot, name, null), (e) => record(slot, name, e)));
    return;
  }
  record(slot, name, null);
}
const section = (s) => results.push(['', `\n--- ${s} ---`]);

// ============================================================ fixture factory
const NOW = 1789000000000;          // fixed fake server clock

function fakeGame(opts = {}) {
  const castles = opts.castles || [];
  return {
    now: () => NOW,
    marchSkillParam: opts.marchSkillParam ?? 100,
    castles,
    castleId: (c) => c.castleId ?? c.id,
    castleXY: (c) => (c.fieldId !== undefined ? C.fieldIdToCoords(c.fieldId) : null),
    buildArmyBean: require('./game').Game.prototype.buildArmyBean,
    // every executor call is recorded instead of sent
    sent: [],
    async newArmy(castleId, bean) { this.sent.push(['army.newArmy', { castleId, newArmyBean: bean }]); return { ok: 1 }; },
    async req(cmd, data) { this.sent.push([cmd, data]); return { ok: 1 }; },
  };
}

function fakeCastle(over = {}) {
  return {
    castleId: 101,
    name: 'Home',
    fieldId: C.coordsToFieldId(200, 300),
    goOutForBattle: false,
    heros: [{ id: 7, name: 'Hider', status: 0, power: 120, management: 40 }],
    troop: { archer: 50000, pikemen: 10000, scouter: 500, lightCavalry: 2000 },
    resource: {
      food: { amount: 20000000 }, wood: { amount: 4000000 },
      stone: { amount: 3000000 }, iron: { amount: 2000000 },
      gold: 500000, support: 100, curPopulation: 50000, maxPopulation: 60000,
      workPeople: 1000, buildPeople: 0,
    },
    fortification: {},
    buildings: [],
    ...over,
  };
}

// An inbound army in the shape the SERVER sends it (ArmyBean): counts are
// strings under `troop`, reachTime is an absolute server-epoch millisecond.
function wireArmy({ inMs, troop, king = 'Raider', from = '150,250', armyId = 900 }) {
  return { armyId, king, startPosName: from, missionType: C.MISSION.attack, reachTime: NOW + inMs, troop };
}

// The shape engine.js currently hands to plans: the breakdown is already gone.
function flatArmy({ inMs, troops, from = '150,250' }) {
  return { troops, reachTime: NOW + inMs, from };
}

function makeCtx(over = {}) {
  const castle = over.castle || fakeCastle();
  const others = over.otherCastles || [];
  const game = over.game || fakeGame({ castles: [castle, ...others] });
  return {
    game, castle,
    goals: over.goals || [],
    config: over.config || {},
    fortifications: {},
    incoming: over.incoming || [],
    ...(over.selfArmies ? { selfArmies: over.selfArmies } : {}),
    ...(over.maintenance ? { maintenance: true } : {}),
  };
}

const secondCity = () => fakeCastle({ castleId: 202, name: 'Refuge', fieldId: C.coordsToFieldId(210, 305), heros: [], troop: {} });

// ============================================================== 1. helpers
section('helpers');

test('durationMs: plain numbers are minutes', () => {
  assert.strictEqual(durationMs(2), 120000);
  assert.strictEqual(durationMs(0), 0);
});
test('durationMs: "30s" survives goals.js NUM() and means 30 seconds', () => {
  assert.strictEqual(durationMs('30s'), 30000);
  assert.strictEqual(durationMs('90sec'), 90000);
  assert.strictEqual(durationMs('2h'), 7200000);
  assert.strictEqual(durationMs('1.5min'), 90000);
});
test('durationMs: junk is 0, not NaN', () => {
  assert.strictEqual(durationMs('banana'), 0);
  assert.strictEqual(durationMs(undefined), 0);
  assert.strictEqual(durationMs(null), 0);
});

test('count: TroopStrBean strings parse, "?" stays unknown', () => {
  assert.strictEqual(count('12000'), 12000);
  assert.strictEqual(count('12,000'), 12000);
  assert.strictEqual(count(3400), 3400);
  assert.strictEqual(count('?'), null);
  assert.strictEqual(count('??'), null);
  assert.strictEqual(count(undefined), null);
});

test('normalizeArmy: reachTime is absolute server-epoch ms', () => {
  const a = normalizeArmy(wireArmy({ inMs: 300000, troop: { archer: '5000' } }), NOW);
  assert.strictEqual(a.msUntil, 300000);
  assert.strictEqual(a.total, 5000);
  assert.strictEqual(a.known, true);
});
test('normalizeArmy: reads `troop` (the real wire field) not just `troops`', () => {
  const a = normalizeArmy({ reachTime: NOW + 1000, troop: { militia: '700', archer: '300' } }, NOW);
  assert.strictEqual(a.total, 1000);
});
test('normalizeArmy: an unscouted "?" army has an unknown total, never 0', () => {
  const a = normalizeArmy({ reachTime: NOW + 1000, troop: { archer: '?', scouter: '?' } }, NOW);
  assert.strictEqual(a.total, null);
  assert.strictEqual(a.known, false);
});
test('normalizeArmy: engine.js flattened {troops:<number>} still works', () => {
  const a = normalizeArmy(flatArmy({ inMs: 60000, troops: 250000 }), NOW);
  assert.strictEqual(a.total, 250000);
  assert.strictEqual(a.msUntil, 60000);
});

test('classify: an all-scout wave is a scout bomb', () => {
  const a = classify(normalizeArmy(wireArmy({ inMs: 1e5, troop: { scouter: '400000', militia: '10' } }), NOW), {});
  assert.strictEqual(a.kind, 'scoutbomb');
});
test('classify: a mech wave is regular', () => {
  const a = classify(normalizeArmy(wireArmy({ inMs: 1e5, troop: { ballista: '5000', archer: '100000' } }), NOW), {});
  assert.strictEqual(a.kind, 'regular');
});
test('classify: no breakdown means the kind is unknown, not scoutbomb', () => {
  const a = classify(normalizeArmy(flatArmy({ inMs: 1e5, troops: 90000 }), NOW), {});
  assert.notStrictEqual(a.kind, 'scoutbomb');
});

test('threatsOf: junk waves are filtered out and counted', () => {
  const ctx = makeCtx({ incoming: [
    wireArmy({ inMs: 60000, troop: { militia: '5' }, armyId: 1 }),
    wireArmy({ inMs: 30000, troop: { archer: '80000' }, armyId: 2 }),
  ] });
  const t = threatsOf(ctx, {});
  assert.strictEqual(t.real.length, 1);
  assert.strictEqual(t.junk, 1);
  assert.strictEqual(t.real[0].armyId, 2);
});
test('threatsOf: soonest first', () => {
  const ctx = makeCtx({ incoming: [
    wireArmy({ inMs: 600000, troop: { archer: '80000' }, armyId: 1 }),
    wireArmy({ inMs: 30000, troop: { archer: '80000' }, armyId: 2 }),
  ] });
  assert.deepStrictEqual(threatsOf(ctx, {}).real.map((a) => a.armyId), [2, 1]);
});

// ============================================================== 2. parsers
section('parsers');

test('config hiding:2 -> two minutes of lead', () => {
  const r = W.parsers.hiding.parse(2);
  assert.strictEqual(r.leadMs, 120000);
  assert.strictEqual(r.enabled, true);
  assert.deepStrictEqual(r.errors, []);
});
test('config hiding:30s -> thirty seconds of lead', () => {
  assert.strictEqual(W.parsers.hiding.parse('30s').leadMs, 30000);
});
test('config hiding:0 -> off, no error', () => {
  const r = W.parsers.hiding.parse(0);
  assert.strictEqual(r.enabled, false);
  assert.deepStrictEqual(r.errors, []);
});
test('config hiding:<junk> -> error', () => {
  assert.ok(W.parsers.hiding.parse('soon').errors.length);
});
test('config hiding:120 -> flags an implausible two-hour lead', () => {
  assert.ok(W.parsers.hiding.parse(120).errors.some((e) => /typo/.test(e)));
});

test('config gate:6s -> six seconds', () => {
  assert.strictEqual(W.parsers.gate.parse('6s').leadMs, 6000);
});

test('config warrules:1 -> 1 min updates, 5 min reminders', () => {
  const r = W.parsers.warrules.parse(1);
  assert.strictEqual(r.everyMs, 60000);
  assert.strictEqual(r.reminderMs, 300000);
});

test('config wartown:1 -> on, traininghero may move', () => {
  const r = W.parsers.wartown.parse(1);
  assert.strictEqual(r.mode, 1);
  assert.strictEqual(r.heroMayMove, true);
});
test('config wartown:2 -> on, traininghero stays', () => {
  const r = W.parsers.wartown.parse(2);
  assert.strictEqual(r.heroMayMove, false);
});
test('config wartown:5 -> rejected', () => {
  assert.ok(W.parsers.wartown.parse(5).errors.length);
});

test('gatepolicy 2 1 2 0 1 -> all five slots read positionally', () => {
  const r = W.parsers.gatepolicy.parse('2 1 2 0 1'.split(' '));
  assert.deepStrictEqual(r.rules, { noattack: 2, regular: 1, scoutbomb: 2, mixed: 0, maintenance: 1 });
  assert.deepStrictEqual(r.errors, []);
});
test('gatepolicy with too few values -> error', () => {
  assert.ok(W.parsers.gatepolicy.parse('2 1'.split(' ')).errors.length);
});
test('gatepolicy with an out-of-range value -> error', () => {
  assert.ok(W.parsers.gatepolicy.parse('2 1 9 0 1'.split(' ')).errors.some((e) => /scoutbomb/.test(e)));
});
test('gatepolicy switches parse alongside the positionals', () => {
  const r = W.parsers.gatepolicy.parse('0 0 0 0 0 /junk:5000 /strongarchers:250000'.split(' '));
  assert.strictEqual(r.switches.junk, '5000');
  assert.deepStrictEqual(r.errors, []);
});
test('gatepolicy rejects an unknown switch', () => {
  assert.ok(W.parsers.gatepolicy.parse('0 0 0 0 0 /wibble:1'.split(' ')).errors.length);
});

test('hidingpolicy defaults are sane with no arguments', () => {
  const r = W.parsers.hidingpolicy.parse([]);
  assert.strictEqual(r.missionType, C.MISSION.transport);
  assert.strictEqual(r.sendResources, true);
  assert.strictEqual(r.sendGold, false);
  assert.strictEqual(r.needHero, true);
  assert.strictEqual(r.recall, true);
  assert.deepStrictEqual(r.errors, []);
});
test('hidingpolicy /target:x,y parses', () => {
  const r = W.parsers.hidingpolicy.parse(['/target:412,90']);
  assert.deepStrictEqual(r.target, { x: 412, y: 90 });
});
test('hidingpolicy /target with a bad shape -> error', () => {
  assert.ok(W.parsers.hidingpolicy.parse(['/target:412']).errors.length);
});
test('hidingpolicy /keep:a:20000,s:10 -> troop keys', () => {
  const r = W.parsers.hidingpolicy.parse(['/keep:a:20000,s:10']);
  assert.deepStrictEqual(r.keep, { archer: 20000, scouter: 10 });
});
test('hidingpolicy /keep with an unknown troop code -> error', () => {
  assert.ok(W.parsers.hidingpolicy.parse(['/keep:zz:5']).errors.length);
});
test('hidingpolicy /mission:reinforce switches mission type', () => {
  assert.strictEqual(W.parsers.hidingpolicy.parse(['/mission:reinforce']).missionType, C.MISSION.reinforce);
});
test('hidingpolicy /mission with a bad name -> error', () => {
  assert.ok(W.parsers.hidingpolicy.parse(['/mission:teleport']).errors.length);
});
test('hidingpolicy /maxrest over the client 24h cap -> error', () => {
  assert.ok(W.parsers.hidingpolicy.parse(['/maxrest:30h']).errors.length);
});
test('hidingpolicy rejects a bare token', () => {
  assert.ok(W.parsers.hidingpolicy.parse(['nonsense']).errors.length);
});
test('hidingpolicy /foodshare: a nonsense value errors and falls back, it does not go NaN', () => {
  const r = W.parsers.hidingpolicy.parse(['/foodshare:lots']);
  assert.ok(r.errors.length);
  assert.strictEqual(r.foodShare, 0.9);
  assert.strictEqual(W.parsers.hidingpolicy.parse(['/foodshare:0.5']).foodShare, 0.5);
});
test('hidingpolicy /junk:0 means react to everything, not fall back to 1000', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    goals: [{ name: 'hidingpolicy', ...W.parsers.hidingpolicy.parse(['/junk:0']) }],
    incoming: [wireArmy({ inMs: 90000, troop: { militia: '3' } })],
  });
  assert.strictEqual(W.plans.hiding(ctx, {}).actions.length, 1, 'a 3-man poke counts when /junk:0');
});

// ============================================================== 3. hiding
section('hiding plan');

const HP = (args) => ({ name: 'hidingpolicy', ...W.parsers.hidingpolicy.parse(args) });

test('hiding off -> no plan at all', () => {
  assert.strictEqual(W.plans.hiding(makeCtx({ config: {} }), {}), null);
});

test('hiding on, nothing inbound -> armed, no actions', () => {
  const ctx = makeCtx({ config: { hiding: 2 }, otherCastles: [secondCity()] });
  const p = W.plans.hiding(ctx, {});
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/nothing inbound/.test(p.note));
});

test('hiding: a junk attack is ignored', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 30000, troop: { militia: '3' } })],
  });
  const p = W.plans.hiding(ctx, {});
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/1 junk ignored/.test(p.note), p.note);
});

test('hiding: a real attack outside the lead window -> wait, do not launch', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 10 * 60000, troop: { archer: '200000' } })],
  });
  const p = W.plans.hiding(ctx, {});
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/launching at T-/.test(p.note), p.note);
});

test('hiding: a real attack inside the lead window -> one hideTroops action', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000', ballista: '4000' } })],
  });
  const p = W.plans.hiding(ctx, {});
  assert.strictEqual(p.actions.length, 1);
  const a = p.actions[0];
  assert.strictEqual(a.kind, 'hideTroops');
  assert.strictEqual(a.heroId, 7, 'the idle hero leads the march');
  // every troop in the city goes, and only the types it actually has
  assert.deepStrictEqual(Object.keys(a.troops).sort(), ['archer', 'lightCavalry', 'pikemen', 'scouter']);
  assert.strictEqual(a.troops.archer, 50000);
  assert.strictEqual(a.troops.pikemen, 10000);
  assert.strictEqual(a.troops.scouter, 500);
  assert.strictEqual(a.troops.lightCavalry, 2000);
  // the bean is what army.newArmy wants (NewArmyParam.as)
  assert.deepStrictEqual(Object.keys(a.bean).sort(),
    ['backAfterConstruct', 'heroId', 'missionType', 'resource', 'restTime', 'targetPoint', 'troops', 'useFlag', 'useItem'].sort());
  assert.strictEqual(a.bean.missionType, C.MISSION.transport);
  assert.strictEqual(a.bean.targetPoint, C.coordsToFieldId(210, 305));
  assert.ok(Number.isInteger(a.bean.restTime) && a.bean.restTime >= 0, 'restTime is whole seconds');
});

test('hiding: the march is still away when the wave lands', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  const a = W.plans.hiding(ctx, {}).actions[0];
  assert.strictEqual(a.safe, true, 'expectedReturnAt must be after forImpactAt');
  assert.ok(a.expectedReturnAt > a.forImpactAt);
});

test('hiding: several waves -> stay out past the LAST one', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [
      wireArmy({ inMs: 90000, troop: { archer: '200000' }, armyId: 1 }),
      wireArmy({ inMs: 20 * 60000, troop: { archer: '200000' }, armyId: 2 }),
    ],
  });
  const a = W.plans.hiding(ctx, {}).actions[0];
  assert.ok(a.forImpactAt >= NOW + 20 * 60000, 'the late wave sets the impact time');
  assert.ok(a.expectedReturnAt > a.forImpactAt);
});

test('hiding: resources ride along and food upkeep is reserved out of capacity', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  const a = W.plans.hiding(ctx, {}).actions[0];
  const carried = Object.values(a.resources).reduce((s, v) => s + v, 0);
  const loads = Object.entries(a.troops).reduce((s, [k, v]) => s + v * C.BY_KEY[k].load, 0);
  const upkeepPerHour = Object.entries(a.troops).reduce((s, [k, v]) => s + v * C.BY_KEY[k].food, 0);
  assert.ok(carried > 0, 'something should be hidden');
  assert.ok(carried <= loads, 'never load past carry capacity');
  // NewArmyWin.as: needFood = upkeepPerHour * (oneWayHours + restHours) and it
  // has to fit alongside the cargo.
  const restHours = a.restSec / 3600;
  assert.ok(carried + upkeepPerHour * restHours <= loads + 1, 'cargo + encamp upkeep must fit in the hold');
  assert.strictEqual(a.resources.gold, undefined, 'gold stays home unless /gold:1');
});

test('hiding: /keep leaves a garrison behind', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()], goals: [HP(['/keep:a:20000'])],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  const a = W.plans.hiding(ctx, {}).actions[0];
  assert.strictEqual(a.troops.archer, 30000, '50k archers minus the 20k kept');
});

test('hiding: /target overrides the destination', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, goals: [HP(['/target:412,90'])],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  const a = W.plans.hiding(ctx, {}).actions[0];
  assert.strictEqual(a.bean.targetPoint, C.coordsToFieldId(412, 90));
});

test('hiding: single city with no /target -> explains itself, no action', () => {
  const ctx = makeCtx({
    config: { hiding: 2 },
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  const p = W.plans.hiding(ctx, {});
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/hidingpolicy \/target/.test(p.note), p.note);
});

// HeroConstants.as: 0 FREE, 1 CHIEF (mayor), 2 GUARD, 3 SEND, 4 SEIZED, 5 BACK, 8 FARM
test('hiding: no idle hero -> refuses and names the mayor (status 1, not 2)', () => {
  const castle = fakeCastle({ heros: [{ id: 9, name: 'Mayor', status: 1 }] });
  const ctx = makeCtx({
    castle, config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  const p = W.plans.hiding(ctx, {});
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/no idle hero/.test(p.note) && /Mayor/.test(p.note), p.note);
});

test('hiding: /needhero:0 marches without a hero', () => {
  const castle = fakeCastle({ heros: [{ id: 9, name: 'Mayor', status: 1 }] });
  const ctx = makeCtx({
    castle, config: { hiding: 2 }, otherCastles: [secondCity()], goals: [HP(['/needhero:0'])],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  const a = W.plans.hiding(ctx, {}).actions[0];
  assert.strictEqual(a.heroId, null);
  assert.strictEqual(a.bean.heroId, undefined, 'no heroId key when there is no hero');
});

test('hiding: no troops to move -> refuses', () => {
  const castle = fakeCastle({ troop: {} });
  const ctx = makeCtx({
    castle, config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  assert.ok(/no troops/.test(W.plans.hiding(ctx, {}).note));
});

test('hiding: impact too close to react -> refuses rather than half-marching', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 800, troop: { archer: '200000' } })],
  });
  const p = W.plans.hiding(ctx, {});
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/too late/.test(p.note), p.note);
});

test('hiding: an attack already handled -> no second march', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  const state = { war: { hide: { forImpactAt: NOW + 90000, expectedReturnAt: NOW + 900000, targetFieldId: 1, missionType: 1 } } };
  const p = W.plans.hiding(ctx, state);
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/troops are out/.test(p.note), p.note);
});

test('hiding: wave landed and gone -> recall, given an armyId', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    selfArmies: [{ armyId: 555, targetFieldId: C.coordsToFieldId(210, 305), missionType: C.MISSION.transport }],
  });
  const state = { war: { hide: { forImpactAt: NOW - 10 * 60000, expectedReturnAt: NOW + 600000,
    targetFieldId: C.coordsToFieldId(210, 305), missionType: C.MISSION.transport } } };
  const p = W.plans.hiding(ctx, state);
  assert.strictEqual(p.actions.length, 1);
  assert.strictEqual(p.actions[0].kind, 'recallArmy');
  assert.strictEqual(p.actions[0].armyId, 555);
});

test('hiding: wave gone but no armyId known -> says so instead of guessing', () => {
  const ctx = makeCtx({ config: { hiding: 2 }, otherCastles: [secondCity()] });
  const state = { war: { hide: { forImpactAt: NOW - 10 * 60000, expectedReturnAt: NOW + 600000, targetFieldId: 7, missionType: 1 } } };
  const p = W.plans.hiding(ctx, state);
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/SelfArmysUpdate/.test(p.note), p.note);
});

test('hiding: a stale hide record is cleared once the army is overdue', () => {
  const ctx = makeCtx({ config: { hiding: 2 }, otherCastles: [secondCity()] });
  const state = { war: { hide: { forImpactAt: NOW - 7200000, expectedReturnAt: NOW - 3600000 } } };
  const p = W.plans.hiding(ctx, state);
  assert.strictEqual(state.war.hide, undefined);
  assert.ok(/clearing/.test(p.note));
});

test('hiding: an inbound army with no arrival time is not acted on blind', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [{ troop: { archer: '200000' }, startPosName: '1,1' }],
  });
  const p = W.plans.hiding(ctx, {});
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/arrival time is unknown/.test(p.note), p.note);
});

test('hiding: works off the flattened shape engine.js produces today', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [flatArmy({ inMs: 90000, troops: 200000 })],
  });
  assert.strictEqual(W.plans.hiding(ctx, {}).actions.length, 1);
});

test('hiding: a wave beyond the horizon does not force an endless encampment', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [
      wireArmy({ inMs: 90000, troop: { archer: '200000' }, armyId: 1 }),
      wireArmy({ inMs: 5 * 3600000, troop: { archer: '200000' }, armyId: 2 }),
    ],
  });
  const a = W.plans.hiding(ctx, {}).actions[0];
  assert.ok(a.restSec <= 8 * 3600, 'default /maxrest is 8h');
  assert.ok(a.forImpactAt < NOW + 5 * 3600000, 'the 5h wave is outside the 1h horizon');
});

test('hiding: a food-starved city clamps the encampment instead of failing', () => {
  const castle = fakeCastle({ resource: { ...fakeCastle().resource, food: { amount: 400000 } } });
  const ctx = makeCtx({
    castle, config: { hiding: 2 }, otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' }, armyId: 1 }),
               wireArmy({ inMs: 55 * 60000, troop: { archer: '200000' }, armyId: 2 })],
  });
  const p = W.plans.hiding(ctx, {});
  if (p.actions.length) {
    const a = p.actions[0];
    const upkeep = Object.entries(a.troops).reduce((s, [k, v]) => s + v * C.BY_KEY[k].food, 0);
    assert.ok(upkeep * (a.restSec / 3600) <= 400000, 'encamp upkeep stays inside the food on hand');
  } else {
    assert.ok(/food/.test(p.note), p.note);
  }
});

test('hiding: all march slots busy -> refuses', () => {
  const ctx = makeCtx({
    config: { hiding: 2 }, otherCastles: [secondCity()], goals: [HP(['/maxmarches:2'])],
    selfArmies: [{ armyId: 1 }, { armyId: 2 }],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  assert.ok(/march slot/.test(W.plans.hiding(ctx, {}).note));
});

// ============================================================== 4. gate
section('gate plan');

const GP = (s) => ({ name: 'gatepolicy', ...W.parsers.gatepolicy.parse(s.split(/\s+/)) });

test('gate off -> no plan', () => {
  assert.strictEqual(W.plans.gate(makeCtx({ config: {} }), {}), null);
});
test('gate: manual CLOSED from the console outranks a gatepolicy that says open', () => {
  const ctx = makeCtx({ castle: fakeCastle({ goOutForBattle: true }), config: { gate: 1 }, goals: [GP('1 1 1 1 1')] });
  ctx.controls = { gate: 'closed' };
  const p = W.plans.gate(ctx, {});
  assert.strictEqual(p.actions.length, 1);
  assert.strictEqual(p.actions[0].open, false);
  assert.strictEqual(p.actions[0].scenario, 'manual');
});
test('gate: manual OPEN works with no gate goal at all, then holds once open', () => {
  const ctx = makeCtx({ config: {} });
  ctx.controls = { gate: 'open' };
  assert.strictEqual(W.plans.gate(ctx, {}).actions[0].open, true);
  ctx.castle.goOutForBattle = true;
  const p = W.plans.gate(ctx, {});
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/holding/.test(p.note), p.note);
});
test('gate: Auto hands the gate back to the goals', () => {
  const ctx = makeCtx({ config: { gate: 1 }, goals: [GP('1 1 2 0 1')] });
  ctx.controls = { gate: 'auto' };
  const p = W.plans.gate(ctx, {});
  assert.strictEqual(p.actions[0].open, true);
  assert.notStrictEqual(p.actions[0].scenario, 'manual');
});
test('gatepolicy without config gate -> says it is idle', () => {
  const p = W.plans.gate(makeCtx({ config: {}, goals: [GP('2 1 2 0 1')] }), {});
  assert.ok(/idle/.test(p.note));
});

test('gate: quiet + policy "close" and the gate is already closed -> nothing to do', () => {
  const ctx = makeCtx({ config: { gate: 1 }, goals: [GP('2 1 2 0 1')] });
  const p = W.plans.gate(ctx, {});
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/noattack/.test(p.note) && /already closed/.test(p.note), p.note);
});

test('gate: quiet + policy "open" -> opens', () => {
  const ctx = makeCtx({ config: { gate: 1 }, goals: [GP('1 1 2 0 1')] });
  const p = W.plans.gate(ctx, {});
  assert.strictEqual(p.actions.length, 1);
  assert.strictEqual(p.actions[0].kind, 'setGate');
  assert.strictEqual(p.actions[0].open, true);
});

test('gate: a regular wave inside the window + policy "open" -> opens', () => {
  const ctx = makeCtx({
    config: { gate: 1 }, goals: [GP('2 1 2 0 1')],
    incoming: [wireArmy({ inMs: 30000, troop: { archer: '100000', ballista: '2000' } })],
  });
  const p = W.plans.gate(ctx, {});
  assert.strictEqual(p.actions[0].open, true);
  assert.strictEqual(p.actions[0].scenario, 'regular');
});

test('gate: a scout bomb + policy "close" -> stays closed', () => {
  const castle = fakeCastle({ goOutForBattle: true });
  const ctx = makeCtx({
    castle, config: { gate: 1 }, goals: [GP('2 1 2 0 1')],
    incoming: [wireArmy({ inMs: 30000, troop: { scouter: '500000' } })],
  });
  const p = W.plans.gate(ctx, {});
  assert.strictEqual(p.actions[0].open, false);
  assert.strictEqual(p.actions[0].scenario, 'scoutbomb');
});

test('gate: scouts AND a real wave together -> mixed', () => {
  const ctx = makeCtx({
    config: { gate: 1 }, goals: [GP('0 0 0 0 0')],
    incoming: [
      wireArmy({ inMs: 30000, troop: { scouter: '500000' }, armyId: 1 }),
      wireArmy({ inMs: 40000, troop: { ballista: '9000' }, armyId: 2 }),
    ],
  });
  assert.ok(/mixed/.test(W.plans.gate(ctx, {}).note));
});

test('gate: a wave outside the lead window is not reacted to yet', () => {
  const ctx = makeCtx({
    config: { gate: '6s' }, goals: [GP('2 1 2 0 1')],
    incoming: [wireArmy({ inMs: 600000, troop: { archer: '100000' } })],
  });
  assert.ok(/noattack/.test(W.plans.gate(ctx, {}).note));
});

test("gate: bot's choice opens for a small loyalty poke", () => {
  const ctx = makeCtx({
    config: { gate: 1 }, goals: [GP('0 0 0 0 0')],
    incoming: [wireArmy({ inMs: 30000, troop: { militia: '2000' } })],
  });
  const p = W.plans.gate(ctx, {});
  assert.strictEqual(p.actions[0].open, true);
  assert.ok(/loyalty/.test(p.note), p.note);
});

test("gate: bot's choice closes for a big wave against a weak city", () => {
  const castle = fakeCastle({ goOutForBattle: true, troop: { archer: 5000 } });
  const ctx = makeCtx({
    castle, config: { gate: 1 }, goals: [GP('0 0 0 0 0')],
    incoming: [wireArmy({ inMs: 30000, troop: { ballista: '400000' } })],
  });
  const p = W.plans.gate(ctx, {});
  assert.strictEqual(p.actions[0].open, false);
});

test("gate: bot's choice meets a scout bomb in the field with 300k+ archers", () => {
  const castle = fakeCastle({ troop: { archer: 400000 } });
  const ctx = makeCtx({
    castle, config: { gate: 1 }, goals: [GP('0 0 0 0 0')],
    incoming: [wireArmy({ inMs: 30000, troop: { scouter: '900000' } })],
  });
  assert.strictEqual(W.plans.gate(ctx, {}).actions[0].open, true);
});

test('gate: maintenance scenario is selected when ctx.maintenance is set', () => {
  const ctx = makeCtx({ config: { gate: 1 }, goals: [GP('2 2 2 2 1')], maintenance: true });
  const p = W.plans.gate(ctx, {});
  assert.strictEqual(p.actions[0].open, true);
  assert.strictEqual(p.actions[0].scenario, 'maintenance');
});

test('gate: will not flap — a toggle inside the cooldown is held', () => {
  const ctx = makeCtx({ config: { gate: 1 }, goals: [GP('1 1 2 0 1')] });
  const state = { war: { gate: { lastAt: NOW - 2000 } } };
  const p = W.plans.gate(ctx, state);
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/holding/.test(p.note), p.note);
});

test('gate: /strongarchers retunes the scout-bomb threshold', () => {
  const castle = fakeCastle({ troop: { archer: 150000 } });
  const ctx = makeCtx({
    castle, config: { gate: 1 }, goals: [GP('0 0 0 0 0 /strongarchers:100000')],
    incoming: [wireArmy({ inMs: 30000, troop: { scouter: '900000' } })],
  });
  assert.strictEqual(W.plans.gate(ctx, {}).actions[0].open, true);
});

// ============================================================== 5. warrules
section('warrules plan');

test('warrules off -> no plan', () => {
  assert.strictEqual(W.plans.warrules(makeCtx({ config: {} }), {}), null);
});

test('warrules: nothing inbound -> armed, silent', () => {
  const p = W.plans.warrules(makeCtx({ config: { warrules: 1 } }), {});
  assert.deepStrictEqual(p.actions, []);
});

test('warrules: the first non-junk attack is announced immediately', () => {
  const ctx = makeCtx({
    config: { warrules: 1 },
    incoming: [wireArmy({ inMs: 300000, troop: { archer: '200000' }, king: 'Raider' })],
  });
  const p = W.plans.warrules(ctx, {});
  assert.strictEqual(p.actions.length, 1);
  assert.strictEqual(p.actions[0].kind, 'allianceChat');
  assert.ok(/Home/.test(p.actions[0].msg) && /Raider/.test(p.actions[0].msg), p.actions[0].msg);
  assert.ok(!/200,?000/.test(p.actions[0].msg), 'the wave size stays out of alliance chat');
});

test('warrules: junk alone never triggers a message', () => {
  const ctx = makeCtx({ config: { warrules: 1 }, incoming: [wireArmy({ inMs: 300000, troop: { militia: '2' } })] });
  assert.deepStrictEqual(W.plans.warrules(ctx, {}).actions, []);
});

test('warrules: an unchanged picture stays quiet until the X*5 reminder', () => {
  const ctx = makeCtx({
    config: { warrules: 1 },
    incoming: [wireArmy({ inMs: 300000, troop: { archer: '200000' }, armyId: 1 })],
  });
  const sig = W.plans.warrules(ctx, {}).actions[0].sig;
  const state = { war: { chat: { lastAt: NOW - 120000, lastSig: sig } } };
  const p = W.plans.warrules(ctx, state);
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/reminder in/.test(p.note), p.note);

  const late = { war: { chat: { lastAt: NOW - 400000, lastSig: sig } } };
  assert.strictEqual(W.plans.warrules(ctx, late).actions.length, 1);
});

test('warrules: a new wave is an update, sent on the shorter X interval', () => {
  const base = makeCtx({ config: { warrules: 1 }, incoming: [wireArmy({ inMs: 300000, troop: { archer: '200000' }, armyId: 1 })] });
  const sig = W.plans.warrules(base, {}).actions[0].sig;
  const ctx2 = makeCtx({
    config: { warrules: 1 },
    incoming: [wireArmy({ inMs: 300000, troop: { archer: '200000' }, armyId: 1 }),
               wireArmy({ inMs: 400000, troop: { archer: '200000' }, armyId: 2 })],
  });
  const state = { war: { chat: { lastAt: NOW - 90000, lastSig: sig } } };
  assert.strictEqual(W.plans.warrules(ctx2, state).actions.length, 1);
});

// ============================================================== 6. wartown
section('wartown plan');

test('wartown unset -> no plan', () => {
  assert.strictEqual(W.plans.wartown(makeCtx({ config: {} }), {}), null);
});
test('wartown:0 -> off, not locked down', () => {
  const p = W.plans.wartown(makeCtx({ config: { wartown: 0 } }), {});
  assert.strictEqual(p.lockdown, false);
});
test('wartown:1 -> locks down, traininghero may still move', () => {
  const p = W.plans.wartown(makeCtx({ config: { wartown: 1 } }), {});
  assert.strictEqual(p.lockdown, true);
  assert.strictEqual(p.heroMayMove, true);
});
test('wartown:2 -> locks down, traininghero stays put', () => {
  assert.strictEqual(W.plans.wartown(makeCtx({ config: { wartown: 2 } }), {}).heroMayMove, false);
});
test('wartown: switching on recalls every marching army', () => {
  const ctx = makeCtx({ config: { wartown: 1 }, selfArmies: [{ armyId: 11 }, { armyId: 12 }] });
  const p = W.plans.wartown(ctx, {});
  assert.deepStrictEqual(p.actions.map((a) => [a.kind, a.armyId]), [['recallArmy', 11], ['recallArmy', 12]]);
});
test('wartown: it only recalls once, not every tick', () => {
  const ctx = makeCtx({ config: { wartown: 1 }, selfArmies: [{ armyId: 11 }] });
  const state = {};
  assert.strictEqual(W.plans.wartown(ctx, state).actions.length, 1);
  assert.strictEqual(W.plans.wartown(ctx, state).actions.length, 0);
});
test('wartown: turning it back off announces the lift', () => {
  const state = {};
  W.plans.wartown(makeCtx({ config: { wartown: 1 } }), state);
  const p = W.plans.wartown(makeCtx({ config: { wartown: 0 } }), state);
  assert.ok(/lifted/.test(p.note));
  assert.strictEqual(p.lockdown, false);
});
test('wartown: armies still out a minute later get a second recall', () => {
  const ctx = makeCtx({ config: { wartown: 1 }, selfArmies: [{ armyId: 11 }] });
  const state = {};
  assert.strictEqual(W.plans.wartown(ctx, state).actions.length, 1);
  assert.strictEqual(W.plans.wartown(ctx, state).actions.length, 0, 'not every tick');
  state.war.wartown.lastRecallAt = NOW - 120000;
  const p = W.plans.wartown(ctx, state);
  assert.strictEqual(p.actions.length, 1);
  assert.ok(/still recalling/.test(p.note), p.note);
});
test('isWarTown reports the mode for the other goal modules', () => {
  assert.strictEqual(W.isWarTown(makeCtx({ config: { wartown: 2 } })), 2);
  assert.strictEqual(W.isWarTown(makeCtx({ config: {} })), 0);
});

// ============================================================ 7. monitorarmy
section('monitorarmy');

test('monitorarmy unset -> no plan', () => {
  assert.strictEqual(W.plans.monitorarmy(makeCtx({ config: {} })), null);
});
test('monitorarmy set -> accepted and ignored, no actions', () => {
  const p = W.plans.monitorarmy(makeCtx({ config: { monitorarmy: 1 } }));
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/never done anything/.test(p.note));
});

// ======================================================== 7b. the constraints
section('keepatthome / attackgap / defensecooldown / nohealing');

// power/management/stratagem already include allocated points; *Added is the
// count of those allocations and must NOT be added on top.
const mixedHeroes = [
  { id: 1, name: 'Bruiser', status: 0, power: 300, powerAdded: 100, management: 40, stratagem: 30 },
  { id: 2, name: 'Clerk',   status: 0, power: 30,  management: 250, managementAdded: 90, stratagem: 40 },
  { id: 3, name: 'Sabre',   status: 0, power: 180, management: 20, stratagem: 10 },
  { id: 4, name: 'Mayor',   status: 1, power: 400, management: 10, stratagem: 10 },
  { id: 5, name: 'Marching', status: 3, power: 500, management: 10, stratagem: 10 },
];

test('keepatthome reserves the strongest idle attack heroes, not the politicians', () => {
  const castle = fakeCastle({ heros: mixedHeroes });
  const k = W.keepAttHome(makeCtx({ castle, config: { keepatthome: 2 } }));
  assert.deepStrictEqual(k.reserved.map((h) => h.name), ['Bruiser', 'Sabre']);
  assert.ok(k.reservedIds.has(1) && k.reservedIds.has(3));
  assert.ok(!k.reservedIds.has(2), 'a politics hero is not an attack hero');
  assert.ok(!k.reservedIds.has(4), 'the mayor (status 1) is not free to reserve');
  assert.ok(!k.reservedIds.has(5), 'a hero already marching (status 3) cannot be reserved');
});
test('keepatthome ranks on power alone — *Added is a point count, not a bonus', () => {
  const castle = fakeCastle({ heros: mixedHeroes });
  const k = W.keepAttHome(makeCtx({ castle, config: { keepatthome: 3 } }));
  // Clerk has management 250 vs power 30; adding managementAdded 90 would not
  // change that, but adding powerAdded 100 to Bruiser must not happen either.
  assert.deepStrictEqual(k.reserved.map((h) => h.name), ['Bruiser', 'Sabre']);
  assert.strictEqual(W._internals.isAttackHero({ power: 100, powerAdded: 900, management: 200 }), false,
    'powerAdded must not be able to promote a politics hero to an attack hero');
});
test('keepatthome reports how many it is short', () => {
  const castle = fakeCastle({ heros: mixedHeroes });
  assert.strictEqual(W.keepAttHome(makeCtx({ castle, config: { keepatthome: 4 } })).short, 2);
});
test('keepatthome:0 reserves nobody', () => {
  assert.strictEqual(W.keepAttHome(makeCtx({ config: { keepatthome: 0 } })).keep, 0);
});
test('keepatthome with junk -> error', () => {
  assert.ok(W.parsers.keepatthome.parse('lots').errors.length);
});

test('attackgap gates outgoing attacks and clears once the gap has passed', () => {
  const ctx = makeCtx({ config: { attackgap: 90 } });
  assert.strictEqual(W.parsers.attackgap.parse(90).gapMs, 90000, 'bare numbers are seconds');
  const state = {};
  assert.strictEqual(W.attackAllowed(ctx, state).ok, true);
  W.noteAttackSent(state, NOW - 30000);
  const held = W.attackAllowed(ctx, state);
  assert.strictEqual(held.ok, false);
  assert.strictEqual(held.waitMs, 60000);
  W.noteAttackSent(state, NOW - 120000);
  assert.strictEqual(W.attackAllowed(ctx, state).ok, true);
});
test('attackgap:2min is unambiguous', () => {
  assert.strictEqual(W.parsers.attackgap.parse('2min').gapMs, 120000);
});
test('attackgap unset -> never blocks', () => {
  assert.strictEqual(W.attackAllowed(makeCtx({ config: {} }), {}).ok, true);
});

test('defensecooldown counts in minutes and paces the gate', () => {
  assert.strictEqual(W.parsers.defensecooldown.parse(5).cooldownMs, 300000);
  assert.strictEqual(W.parsers.defensecooldown.parse('30s').cooldownMs, 30000);
  const ctx = makeCtx({ config: { gate: 1, defensecooldown: 5 }, goals: [GP('1 1 2 0 1')] });
  const state = { war: { lastDefenceAt: NOW - 60000 } };
  const p = W.plans.gate(ctx, state);
  assert.deepStrictEqual(p.actions, []);
  assert.ok(/defensecooldown/.test(p.note), p.note);
});
test('defensecooldown does not block once it has elapsed', () => {
  const ctx = makeCtx({ config: { gate: 1, defensecooldown: 5 }, goals: [GP('1 1 2 0 1')] });
  const state = { war: { lastDefenceAt: NOW - 600000 } };
  assert.strictEqual(W.plans.gate(ctx, state).actions.length, 1);
});

test('nohealing:1 forbids healing, 0 and unset allow it', () => {
  assert.strictEqual(W.healingAllowed(makeCtx({ config: { nohealing: 1 } })), false);
  assert.strictEqual(W.healingAllowed(makeCtx({ config: { nohealing: 0 } })), true);
  assert.strictEqual(W.healingAllowed(makeCtx({ config: {} })), true);
});
test('nohealing:7 -> error', () => {
  assert.ok(W.parsers.nohealing.parse(7).errors.length);
});

test('constraints plan stays quiet when none are configured', () => {
  assert.strictEqual(W.plans.constraints(makeCtx({ config: {} }), {}), null);
});
test('constraints plan reports each configured limit and emits no actions', () => {
  const castle = fakeCastle({ heros: mixedHeroes });
  const ctx = makeCtx({ castle, config: { keepatthome: 2, attackgap: 90, defensecooldown: 5, nohealing: 1 } });
  const p = W.plans.constraints(ctx, { war: { lastAttackAt: NOW - 30000 } });
  assert.deepStrictEqual(p.actions, []);
  for (const word of ['keepatthome', 'attackgap', 'defensecooldown', 'nohealing']) {
    assert.ok(p.note.includes(word), `${word} missing from: ${p.note}`);
  }
});

// ============================================================ 8. executors
section('executors (against a fake game — no socket)');

test('every action kind a plan can emit has an executor', () => {
  const kinds = new Set(['hideTroops', 'recallArmy', 'setGate', 'allianceChat', 'note']);
  for (const k of kinds) assert.strictEqual(typeof W.executors[k], 'function', `missing executor: ${k}`);
});

test('hideTroops sends army.newArmy and records the march', async () => {
  const castle = fakeCastle();
  const game = fakeGame({ castles: [castle, secondCity()] });
  const ctx = makeCtx({ castle, game, config: { hiding: 2 }, otherCastles: [],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })] });
  ctx.game.castles = [castle, secondCity()];
  const a = W.plans.hiding(ctx, {}).actions[0];
  const state = {};
  await W.executors.hideTroops(game, castle, a, state);
  assert.strictEqual(game.sent[0][0], 'army.newArmy');
  assert.strictEqual(game.sent[0][1].castleId, 101);
  assert.strictEqual(state.war.hide.forImpactAt, a.forImpactAt);
  assert.strictEqual(state.war.hide.armyId, null, 'army.newArmy does not reply with an armyId');
});

test('recallArmy sends army.callBackArmy and clears the record', async () => {
  const castle = fakeCastle();
  const game = fakeGame({ castles: [castle] });
  const state = { war: { hide: { armyId: 555 } } };
  await W.executors.recallArmy(game, castle, { armyId: 555 }, state);
  assert.deepStrictEqual(game.sent[0], ['army.callBackArmy', { castleId: 101, armyId: 555 }]);
  assert.strictEqual(state.war.hide, undefined);
});

test('setGate sends army.setArmyGoOut with a boolean and updates the castle', async () => {
  const castle = fakeCastle();
  const game = fakeGame({ castles: [castle] });
  const state = {};
  await W.executors.setGate(game, castle, { open: true }, state);
  assert.deepStrictEqual(game.sent[0], ['army.setArmyGoOut', { castleId: 101, isArmyGoOut: true }]);
  assert.strictEqual(castle.goOutForBattle, true);
  assert.strictEqual(state.war.gate.lastAt, NOW);
});

test('allianceChat sends common.allianceChat with languageType', async () => {
  const castle = fakeCastle();
  const game = fakeGame({ castles: [castle] });
  const state = {};
  await W.executors.allianceChat(game, castle, { msg: 'hi', sig: 'abc' }, state);
  assert.deepStrictEqual(game.sent[0], ['common.allianceChat', { msg: 'hi', languageType: 0 }]);
  assert.strictEqual(state.war.chat.lastSig, 'abc');
});

test('executors work without a state object', async () => {
  const castle = fakeCastle();
  const game = fakeGame({ castles: [castle] });
  await W.executors.setGate(game, castle, { open: false });
  assert.strictEqual(game.sent.length, 1);
});

// ============================================================ 9. end to end
section('a full defensive tick');

test('a real attack drives hiding, the gate and alliance chat together', () => {
  const castle = fakeCastle();
  const other = secondCity();
  const game = fakeGame({ castles: [castle, other] });
  const ctx = {
    game, castle,
    goals: [GP('2 1 2 0 1'), HP([])],
    config: { hiding: 2, gate: 1, warrules: 1, wartown: 1 },
    fortifications: {},
    incoming: [wireArmy({ inMs: 45000, troop: { archer: '300000', ballista: '9000' }, king: 'Raider' })],
    selfArmies: [],
  };
  const state = {};
  const hide = W.plans.hiding(ctx, state);
  const gate = W.plans.gate(ctx, state);
  const chat = W.plans.warrules(ctx, state);
  const town = W.plans.wartown(ctx, state);

  assert.strictEqual(hide.actions[0].kind, 'hideTroops');
  assert.strictEqual(gate.actions[0].kind, 'setGate');
  assert.strictEqual(gate.actions[0].open, true, 'gatepolicy said open for a regular wave');
  assert.strictEqual(chat.actions[0].kind, 'allianceChat');
  assert.strictEqual(town.lockdown, true);
});

test('plans are pure — the same ctx twice gives the same answer', () => {
  const ctx = makeCtx({
    config: { hiding: 2, gate: 1 }, goals: [GP('2 1 2 0 1')], otherCastles: [secondCity()],
    incoming: [wireArmy({ inMs: 90000, troop: { archer: '200000' } })],
  });
  const a = JSON.stringify(W.plans.hiding(ctx, {}));
  const b = JSON.stringify(W.plans.hiding(ctx, {}));
  assert.strictEqual(a, b);
});

test('describe renders one line per configured war goal', () => {
  const lines = W.describe({
    config: { hiding: 2, gate: 1, warrules: 1, wartown: 2, monitorarmy: 1 },
    goals: [GP('2 1 2 0 1'), HP(['/target:412,90'])],
  });
  assert.strictEqual(lines.length, 5);
  assert.ok(lines.some((l) => /^hiding:/.test(l) && /412,90/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^gate:/.test(l) && /scoutbomb:close/.test(l)), lines.join('\n'));
});

test('configKeys names every config key this module reads', () => {
  assert.deepStrictEqual(W.configKeys.slice().sort(),
    ['attackgap', 'defensecooldown', 'gate', 'hiding', 'keepatthome', 'monitorarmy', 'nohealing', 'warrules', 'wartown']);
  // and every one of them has a parser that can validate the value
  for (const k of W.configKeys) assert.strictEqual(typeof W.parsers[k].parse, 'function', `no parser for config ${k}`);
});

// ==================================================================== report
(async () => {
  await Promise.all(queue);
  for (const [tag, name] of results) console.log(tag ? `  ${tag}  ${name}` : name);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
