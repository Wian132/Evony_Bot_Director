'use strict';
// Step 11: the prerequisite resolver for construction (wiki: Build — "the bot
// will automatically build and upgrade the prerequisite building with
// priority"; Research, Upgrade — Michelangelo's Script for a L10).
//
// Offline: fake cities made of building beans, and a stand-in game that
// answers castle.checkOutUpgrade / castle.getAvailableBuildingBean with
// ConditionBeans (ConditionBean.as) worked out from the city as it stands.
// The requirements in `rules` are made up for the tests; the real ones come
// from the server.
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// db.js opens EVONY_DB when first required: point it at a throwaway file
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evony-prereq-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMP, 'test.db');

const C = require('./constants');
const { Game } = require('./game');
const { parseGoals } = require('./goals');
const { Engine, buildPlan, buildLabel, buildOutlook, troopPlan, fortPlan, resolvePrereqs, PREREQ_READS } = require('./engine');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message.split('\n').join('\n        ')); fail++; }
}

// ---------------------------------------------------------------- fake cities
const TY = {
  cottage: 1, barracks: 2, warehouse: 3, sawmill: 4, quarry: 5, iron: 6, farm: 7, stable: 20, inn: 21,
  forge: 22, market: 23, relief: 24, academy: 25, workshop: 26, fh: 27, embassy: 28, rally: 29, beacon: 30,
  th: 31, walls: 32,
};
const TECH = { informatics: 7, horseback: 13 };
const SCRIPT = 'consume.blueprint.1';          // Michelangelo's Script
const bean = (typeId, positionId, level, status = 0) => ({ typeId, name: C.BUILDING_BY_ID[typeId].name, positionId, level, status });
const many = (typeId, count, level) => Array.from({ length: count }, () => [typeId, level]);
const BIG = 1e9;
// Town Hall at -1, Walls at -2 (walls: 0 for none), inside plots from 0, fields from 1001
function town({ th = 10, walls = 10, inside = [], outside = [], bank = {}, pop = {} } = {}) {
  const b = [bean(TY.th, -1, th)];
  if (walls) b.push(bean(TY.walls, -2, walls));
  inside.forEach(([typeId, level], i) => b.push(bean(typeId, i, level)));
  outside.forEach(([typeId, level], i) => b.push(bean(typeId, 1001 + i, level)));
  const amt = (k) => ({ amount: bank[k] ?? BIG });
  return {
    id: 1, name: 'T', fieldId: 100 * 800 + 100, buildings: b, troop: {}, fortification: {}, heros: [],
    resource: { food: amt('food'), wood: amt('wood'), stone: amt('stone'), iron: amt('iron'), gold: bank.gold ?? BIG,
      curPopulation: pop.cur ?? 100000, maxPopulation: 100000, workPeople: pop.work ?? 0, buildPeople: 0 },
  };
}
// all 32 city plots taken, by buildings a city has many of
const FULL_INSIDE = [...many(TY.cottage, 16, 5), ...many(TY.warehouse, 16, 5)];

// The stand-in game. rules: { 'new:<typeId>' | 'up:<typeId>:<level>': {
//   buildings: [[typeId, level]], techs: [[id, level]], items: [[id, num]],
//   food, wood, stone, iron, gold, population } }. Each read is worked out
// from the city and the inventory at that moment, as the server does.
function world(castle, { rules = {}, techs = {}, items = [], refuse = null, troopTypes = null, fortCosts = null } = {}) {
  const reads = [], sent = [];
  const player = { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: items.map(([id, count]) => ({ id, count })) };
  const ruleOf = (key) => (typeof rules === 'function' ? rules(key) : rules[key]) || {};
  const top = (typeId) => Math.max(0, ...castle.buildings.filter((b) => b.typeId === typeId && !(b.status === 0 && b.level === 0)).map((b) => b.level));
  const condFor = (key) => {
    const r = ruleOf(key);
    return {
      food: r.food || 0, wood: r.wood || 0, stone: r.stone || 0, iron: r.iron || 0, gold: r.gold || 0,
      population: r.population || 0, time: 60,
      buildings: (r.buildings || []).map(([typeId, level]) => ({ typeId, level, curLevel: top(typeId), successFlag: top(typeId) >= level })),
      techs: (r.techs || []).map(([id, level]) => ({ id, level, curLevel: techs[id] || 0, successFlag: (techs[id] || 0) >= level })),
      items: (r.items || []).map(([id, num]) => {
        const have = Game.countOf(player.items, id);
        return { id, num, curNum: have, successFlag: have >= num };
      }),
    };
  };
  const at = (pos) => castle.buildings.find((b) => b.positionId === pos);
  let pending = null;
  // the server takes the items an order needs when it accepts it
  const order = (o) => {
    sent.push(o);
    const r = refuse && refuse(o);
    if (r) return r;
    pending = o;
    if (o[0] === 'upgrade') {
      const b = at(o[1]);
      for (const [id, num] of ruleOf(`up:${b.typeId}:${b.level}`).items || []) {
        const it = player.items.find((x) => x.id === id);
        if (it) it.count -= num;
      }
    }
    return { ok: 1 };
  };
  const game = {
    castles: [castle], player,
    castle: () => castle, castleId: () => 1, castleXY: () => ({ x: 100, y: 100 }), now: () => Date.now(),
    req: async (cmd, data) => {
      reads.push([cmd, data]);
      if (cmd === 'castle.checkOutUpgrade') {
        const b = at(data.positionId);
        return b ? { ok: 1, conditionBean: condFor(`up:${b.typeId}:${b.level}`) } : { ok: -1, errorMsg: 'no building there' };
      }
      if (cmd === 'castle.getAvailableBuildingBean') {
        return { ok: 1, builingList: [{ typeId: data.typeId, conditionBean: condFor(`new:${data.typeId}`) }] };
      }
      if (cmd === 'fortifications.getProduceQueue') return { ok: 1, allProduceQueue: [] };
      if (cmd === 'fortifications.getFortificationsProduceList') {
        return fortCosts ? { ok: 1, fortList: Object.entries(fortCosts).map(([typeId, c]) => ({ typeId: Number(typeId), permition: true, conditionBean: c })) }
          : { ok: -1, errorMsg: 'not stubbed' };
      }
      if (cmd === 'troop.getProduceQueue') return { ok: 1, allProduceQueue: [] };
      if (cmd === 'troop.getTroopProduceList') {
        return { ok: 1, troopList: (troopTypes || []).map((typeId) => ({ typeId, permition: true, conditionBean: { time: 1 } })) };
      }
      return { ok: 1 };
    },
    upgradeBuilding: async (_cid, pos) => order(['upgrade', pos]),
    newBuilding: async (_cid, pos, type) => order(['new', pos, type]),
    destructBuilding: async (_cid, pos) => order(['demolish', pos]),
    produceTroop: async (_cid, type, num) => { sent.push(['troop', type, num]); return { ok: 1 }; },
    produceWall: async (_cid, type, num) => { sent.push(['wall', type, num]); return { ok: 1 }; },
    promoteToChief: async () => ({ ok: 1 }),
    dischargeChief: async () => ({ ok: 1 }),
  };
  const e = new Engine(game, () => {});
  e.dryRun = false;
  e.state = {};
  const goals = (src) => { e.goalsFor = () => parseGoals(`config hero:0\n${src}`); };
  // the construction just placed, finished: a level up or down, a new one at L1
  const finish = () => {
    if (!pending) return;
    const [kind, pos, type] = pending;
    pending = null;
    if (kind === 'new') { castle.buildings.push(bean(type, pos, 1)); return; }
    const b = at(pos);
    b.level += kind === 'upgrade' ? 1 : -1;
    if (b.level <= 0) castle.buildings.splice(castle.buildings.indexOf(b), 1);
  };
  const state = () => e.state['1'] || {};
  const condReads = () => reads.filter(([cmd]) => cmd === 'castle.checkOutUpgrade' || cmd === 'castle.getAvailableBuildingBean');
  const builds = () => sent.filter((s) => s[0] === 'upgrade' || s[0] === 'new' || s[0] === 'demolish');
  // focus, finish what was placed, again — until a slice places nothing and
  // has no requirement left to read
  const settle = async (max = 300) => {
    for (let i = 0; i < max; i++) {
      const before = builds().length;
      const r = await e.focus(castle);
      if (builds().length !== before) finish();
      else if (!(r.build && /checking what/.test(r.build.note))) return r;
    }
    throw new Error('never settled');
  };
  return { game, e, sent, reads, goals, finish, state, condReads, builds, settle, player, castle };
}
const levelsOf = (castle, typeId) => castle.buildings.filter((b) => b.typeId === typeId).map((b) => b.level).sort((a, b) => b - a);

(async () => {
  // ================================================================ game.js
  console.log('\nthe ConditionBean helpers (game.js)\n');

  await t('unmet reads the tech by its id, so "tech undefined" is gone', async () => {
    const cond = { techs: [{ id: 7, level: 1, curLevel: 0, successFlag: false }, { id: 13, level: 2, curLevel: 2, successFlag: true }] };
    const [m, ...rest] = new Game().unmet(cond);
    assert.deepStrictEqual(rest, []);
    assert.deepStrictEqual([m.kind, m.id, m.typeId, m.need, m.have], ['tech', 7, 7, 1, 0]);
    assert.strictEqual(m.text, 'research Informatics level 1 (you have 0)');
    assert.ok(!/undefined/.test(m.text));
  });

  await t('unmet lists items against the inventory, and the bank when given the castle', async () => {
    const g = new Game();
    g.player = { items: [{ id: SCRIPT, count: 0 }] };
    const cond = { wood: 120000, stone: 10, gold: 5000, population: 300,
      buildings: [{ typeId: 31, level: 8, curLevel: 7, successFlag: false }],
      items: [{ id: SCRIPT, num: 1, curNum: 3, successFlag: true }] };      // the bean is older than the inventory
    const castle = town({ bank: { wood: 50000, gold: 100 }, pop: { cur: 1000, work: 900 } });
    const all = g.unmet(cond, castle).map((m) => m.text);
    assert.deepStrictEqual(all, ['Town Hall level 8 (you have 7)', "1 Michelangelo's Script (you have 0)",
      'wood 120,000 (you have 50,000)', 'gold 5,000 (you have 100)', 'idle population 300 (you have 100)']);
    assert.strictEqual(g.unmet(cond).filter((m) => m.kind === 'resource' || m.kind === 'population').length, 0, 'the bank checked without a castle');
    // no inventory loaded: the bean's own flag decides
    assert.deepStrictEqual(Game.unmetOf({ items: [{ id: SCRIPT, num: 1, curNum: 0, successFlag: false }] }).map((m) => m.kind), ['item']);
    assert.deepStrictEqual(Game.unmetOf({ items: [{ id: SCRIPT, num: 1, curNum: 1, successFlag: true }] }), []);
  });

  await t('constructionCondition: the two commands the client sends, and their replies', async () => {
    const g = new Game();
    const sent = [];
    g.req = async (cmd, data) => {
      sent.push([cmd, data]);
      if (cmd === 'castle.checkOutUpgrade') return { ok: 1, conditionBean: { wood: 5 } };
      return { ok: 1, builingList: [{ typeId: 3, conditionBean: { wood: 1 } }, { typeId: 20, conditionBean: { wood: 2 } }] };
    };
    assert.deepStrictEqual(await g.constructionCondition(9, { kind: 'upgrade', typeId: 1, positionId: 4 }), { cond: { wood: 5 } });
    assert.deepStrictEqual(await g.constructionCondition(9, { kind: 'new', typeId: 20, positionId: 7 }), { cond: { wood: 2 } });
    assert.deepStrictEqual(sent, [['castle.checkOutUpgrade', { castleId: 9, positionId: 4 }],
      ['castle.getAvailableBuildingBean', { castleId: 9, typeId: 20 }]]);
    g.req = async () => ({ ok: -1, errorMsg: 'max level' });
    assert.deepStrictEqual(await g.constructionCondition(9, { kind: 'upgrade', positionId: 4 }), { error: 'max level' });
    g.req = async () => { throw new Error('no reply to castle.checkOutUpgrade'); };
    assert.match((await g.constructionCondition(9, { kind: 'upgrade', positionId: 4 })).error, /no reply/);
  });

  // ================================================================ buildings
  console.log('\na building the order needs goes first\n');

  // wiki: "to upgrade a cottage to level 9, you need townhall level 8 first.
  // The bot would upgrade the townhall to level 8 before completing a cottage
  // build to level 9."
  const cottageNeedsTH = { 'up:1:8': { buildings: [[TY.th, 8]] } };

  await t('Cottage L9 needs Town Hall L8: the Town Hall goes first, with no backoff', async () => {
    const w = world(town({ th: 7, inside: [[TY.cottage, 8]] }), { rules: cottageNeedsTH });
    w.goals('build c:9');
    const r = await w.e.focus(w.castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', -1]]);
    assert.match(r.build.note, /prerequisite first: upgrade Town Hall \(pos -1\) L7->L8 for Cottage L9 \(it needs Town Hall L8\)/);
    assert.deepStrictEqual(w.state().failures || {}, {}, 'a requirement went on the backoff ladder');
    w.finish();
    await w.e.focus(w.castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', -1], ['upgrade', 0]], 'the cottage did not follow the Town Hall');
  });

  await t('a Town Hall two levels short is raised a level at a time, the cottage waiting', async () => {
    const w = world(town({ th: 6, inside: [[TY.cottage, 8]] }), { rules: cottageNeedsTH });
    w.goals('build c:9');
    await w.settle();
    assert.deepStrictEqual(w.builds(), [['upgrade', -1], ['upgrade', -1], ['upgrade', 0]]);
    assert.deepStrictEqual([levelsOf(w.castle, TY.th), levelsOf(w.castle, TY.cottage)], [[8], [9]]);
  });

  // wiki: "if you tell the bot to build a stable, then it will need a farm at
  // level 5. If it has no farm or room for a farm, it will say 'Needs space:
  // farm' and stop there"
  const stableNeedsFarm = { 'new:20': { buildings: [[TY.farm, 5]] } };

  await t('a Stable needs a L5 Farm and there is none: a Farm is built, raised to L5, then the Stable', async () => {
    const w = world(town({ th: 10 }), { rules: stableNeedsFarm });
    w.goals('build st:1');
    const r = await w.e.focus(w.castle);
    assert.match(r.build.note, /prerequisite first: new Farm \(pos 1001\) for a new Stable \(it needs Farm L5\)/);
    w.finish();
    await w.settle();
    assert.deepStrictEqual(w.builds(), [['new', 1001, TY.farm], ['upgrade', 1001], ['upgrade', 1001], ['upgrade', 1001],
      ['upgrade', 1001], ['new', 0, TY.stable]]);
    assert.deepStrictEqual(w.state().failures || {}, {});
  });

  await t('no farm and no field plot, Town Hall L10: "Needs space: Farm", and the builder stops', async () => {
    const castle = town({ th: 10, outside: many(TY.sawmill, 40, 10), inside: [[TY.cottage, 3]] });
    const w = world(castle, { rules: stableNeedsFarm });
    w.goals('build st:1\nbuild c:5:1');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [], 'it went on past the stable');
    assert.match(r.build.note, /Needs space: Farm \(a new Stable needs Farm L5\)/);
    const o = buildOutlook({ castle, goals: parseGoals('build st:1\nbuild c:5:1').goals, cityState: w.state() });
    assert.strictEqual(o.next, null);
    assert.match(o.idle, /nothing to place: Needs space: Farm/);
  });

  await t('no field plot below Town Hall L10: the Town Hall opens one for the Farm', async () => {
    const castle = town({ th: 5, outside: many(TY.sawmill, 25, 10) });     // 13 + 4 x 3 = 25 plots, all taken
    const w = world(castle, { rules: stableNeedsFarm });
    w.goals('build st:1');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', -1]]);
    assert.match(r.build.note, /upgrade Town Hall \(pos -1\) L5->L6 for a field plot \(a new Stable needs Farm L5\)/);
  });

  await t('a one-per-city prerequisite with no city plot: "Needs space: Forge"', async () => {
    const castle = town({ inside: [...FULL_INSIDE.slice(0, 31), [TY.workshop, 1]] });
    const w = world(castle, { rules: { 'up:26:1': { buildings: [[TY.forge, 3]] } } });
    w.goals('build ws:5');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), []);
    assert.match(r.build.note, /Needs space: Forge \(Workshop L2 needs Forge L3\)/);
  });

  await t('several of the type: the one closest to the level is raised (the fewest upgrades)', async () => {
    const castle = town({ outside: [[TY.farm, 1], [TY.farm, 4], [TY.farm, 2]] });
    const w = world(castle, { rules: stableNeedsFarm });
    w.goals('build st:1');
    await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', 1002]]);
  });

  await t('a prerequisite the build lines take down is never built for them to demolish', async () => {
    const w = world(town(), { rules: stableNeedsFarm });
    w.goals('build st:1,f:0:0\nbuild c:1');
    const r = await w.e.focus(w.castle);
    assert.deepStrictEqual(w.builds(), [['new', 1, TY.cottage]], 'no farm, and the next order goes');
    assert.match(r.build.note, /passed over: new Stable \(pos 0\): a new Stable needs Farm L5, which the build lines take down/);
  });

  // ================================================================ recursion
  console.log('\nprerequisites of prerequisites\n');

  const chainRules = {
    'new:26': { buildings: [[TY.forge, 2]] },                 // a Workshop needs Forge L2
    'up:22:1': { buildings: [[TY.academy, 2]] },              // Forge L2 needs Academy L2
    'up:25:1': { buildings: [[TY.th, 4]] },                   // Academy L2 needs Town Hall L4
  };

  await t('three deep: the Town Hall first; two reads a slice, so it takes two slices to find', async () => {
    const castle = town({ th: 3, inside: [[TY.forge, 1], [TY.academy, 1]] });
    const w = world(castle, { rules: chainRules });
    w.goals('build ws:1');
    const r1 = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [], 'placed before every requirement was read');
    assert.strictEqual(w.condReads().length, PREREQ_READS);
    assert.match(r1.build.note, /checking what new Workshop \(pos 2\) needs \(next slice\)/);
    const r2 = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', -1]]);
    assert.strictEqual(w.condReads().length, 4, 'what was read the first slice was read again');
    assert.match(r2.build.note, /prerequisite first: upgrade Town Hall \(pos -1\) L3->L4 for Academy L2 \(it needs Town Hall L4\) \(a new Workshop needs Forge L2; Forge L2 needs Academy L2; Academy L2 needs Town Hall L4\)/);
    w.finish();
    await w.settle();
    assert.deepStrictEqual(w.builds(), [['upgrade', -1], ['upgrade', 1], ['upgrade', 0], ['new', 2, TY.workshop]]);
  });

  await t('a loop (A needs B, B needs A) is passed over with a note, no backoff, and the next order goes', async () => {
    const castle = town({ inside: [[TY.forge, 1], [TY.academy, 1], [TY.cottage, 1]] });
    const w = world(castle, { rules: { 'up:22:1': { buildings: [[TY.academy, 2]] }, 'up:25:1': { buildings: [[TY.forge, 2]] } } });
    w.goals('build fo:2\nbuild c:2');
    await w.e.focus(castle);                                 // two reads: the forge, then the academy
    const r = await w.e.focus(castle);                       // the cottage's
    assert.deepStrictEqual(w.builds(), [['upgrade', 2]]);
    assert.match(r.build.note, /passed over: upgrade Forge \(pos 0\) L1->L2: Academy L2 needs Forge L2, which needs it back/);
    assert.deepStrictEqual(w.state().failures || {}, {});
  });

  await t('prerequisites nested deeper than the guard are passed over', async () => {
    // Cottage L2 <- Barracks L2 <- Warehouse L2 <- Inn L2 <- Market L2 <- Embassy L2
    const types = [TY.cottage, TY.barracks, TY.warehouse, TY.inn, TY.market, TY.embassy];
    const rules = {};
    for (let i = 0; i < types.length - 1; i++) rules[`up:${types[i]}:1`] = { buildings: [[types[i + 1], 2]] };
    const castle = town({ inside: types.map((typeId) => [typeId, 1]) });
    const w = world(castle, { rules });
    w.goals('build c:2');
    let r;
    for (let i = 0; i < 4; i++) r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), []);
    assert.match(r.build.note, /prerequisites nest deeper than 4/);
  });

  // ================================================================ research
  console.log('\nresearch an order needs: a want for the research goal\n');

  await t('a Beacon Tower that needs Informatics: passed over, the want recorded, the next order goes', async () => {
    const castle = town({ inside: [[TY.cottage, 1]] });
    const w = world(castle, { rules: { 'new:30': { techs: [[TECH.informatics, 1]] } } });
    w.goals('build be:1\nbuild c:2');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', 0]]);
    assert.match(r.build.note, /passed over: new Beacon Tower \(pos 1\): needs research Informatics L1 \(a research goal will pick this up\)/);
    const wants = w.state().researchWants;
    assert.strictEqual(wants.length, 1);
    assert.deepStrictEqual({ ...wants[0], at: 0 }, { techId: 7, level: 1, have: 0, name: 'Informatics', for: 'a new Beacon Tower', at: 0 });
    assert.ok(wants[0].at > 0);
    assert.deepStrictEqual(r.build.researchWants, wants, 'the report carries the wants too');
    assert.deepStrictEqual(w.state().failures || {}, {});
  });

  await t('wants: one per tech at the highest level asked; kept while the builder works; gone with the build lines', async () => {
    const castle = town({ inside: [[TY.cottage, 1]], outside: [[TY.farm, 1]] });
    const w = world(castle, { rules: {
      'new:30': { techs: [[TECH.informatics, 1]] }, 'new:20': { techs: [[TECH.informatics, 3], [TECH.horseback, 2]] },
    } });
    w.goals('build be:1,st:1\nbuild c:2');
    await w.e.focus(castle);
    assert.deepStrictEqual(w.state().researchWants.map((x) => [x.techId, x.level, x.for]),
      [[7, 3, 'a new Stable'], [13, 2, 'a new Stable']]);
    castle.buildings.find((b) => b.typeId === TY.cottage).status = 1;          // the builder is busy
    castle.buildings.find((b) => b.typeId === TY.cottage).endTime = Date.now() + 60e3;
    await w.e.focus(castle);
    assert.strictEqual(w.state().researchWants.length, 2, 'lost while the builder was busy');
    w.goals('troop w:1');
    await w.e.focus(castle);
    assert.strictEqual(w.state().researchWants, undefined);
  });

  await t('research the engine has since read as done beats an older requirement read', async () => {
    const castle = town({ inside: [[TY.cottage, 1]] });
    const w = world(castle, { rules: { 'new:30': { techs: [[TECH.informatics, 1]] } } });
    w.goals('build be:1');
    await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), []);
    w.state().techs = { at: Date.now(), levels: { 7: 1 } };     // Engine.readTechs, for a ?condition?
    await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['new', 1, TY.beacon]]);
    assert.strictEqual(w.state().researchWants, undefined, 'the want outlived the research');
  });

  await t('ctx.researchWants reaches the plans of the same slice (Step 16 reads it)', async () => {
    const castle = town({ inside: [[TY.cottage, 1]] });
    const w = world(castle, { rules: { 'new:30': { techs: [[TECH.informatics, 1]] } } });
    w.goals('build be:1');
    let seen = null;
    const heroes = require('./goal-heroes');
    const had = heroes.plans.__probe;
    heroes.plans.__probe = (ctx) => { seen = ctx.researchWants; return null; };
    try { await w.e.focus(castle); } finally { if (had) heroes.plans.__probe = had; else delete heroes.plans.__probe; }
    assert.deepStrictEqual(seen.map((x) => [x.techId, x.level]), [[7, 1]]);
  });

  // ================================================================ items
  console.log('\nMichelangelo\'s Script for a L10\n');

  const scriptFor10 = { 'up:31:9': { items: [[SCRIPT, 1]] }, 'up:7:9': { items: [[SCRIPT, 1]] } };

  await t('no script held: the L10 is passed over, no backoff, and the next order goes', async () => {
    const castle = town({ th: 9, outside: [[TY.farm, 5]] });
    const w = world(castle, { rules: scriptFor10 });
    w.goals('build t:10\nbuild f:6:1');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', 1001]]);
    assert.match(r.build.note, /passed over: upgrade Town Hall \(pos -1\) L9->L10: needs 1 Michelangelo's Script, none held/);
    assert.deepStrictEqual(w.state().failures || {}, {});
  });

  await t('a script held: the L10 goes, the server spends it, and the note warns', async () => {
    const castle = town({ th: 9 });
    const w = world(castle, { rules: scriptFor10, items: [[SCRIPT, 2]] });
    w.goals('build t:10');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', -1]]);
    assert.match(r.build.note, /upgrade Town Hall \(pos -1\) L9->L10 spends 1 Michelangelo's Script \(2 held\) \(the NEAT wiki warns its bot spends Michelangelo's Scripts too\)/);
    assert.strictEqual(Game.countOf(w.player.items, SCRIPT), 1, 'the server took one');
  });

  await t('the inventory beats an older read: a script that arrives is used without asking again', async () => {
    const castle = town({ th: 9, outside: [[TY.farm, 5]] });
    const w = world(castle, { rules: scriptFor10 });
    w.goals('build t:10');
    await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), []);
    const readsBefore = w.condReads().length;
    w.player.items.push({ id: SCRIPT, count: 1 });              // server.ItemUpdate
    await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', -1]]);
    assert.strictEqual(w.condReads().length, readsBefore, 'read again for an item the inventory already showed');
  });

  // ================================================================ resources
  console.log('\nresources short: the builder waits, no backoff\n');

  await t('short of wood: nothing placed, the note says what for, no backoff; placed once the wood is in', async () => {
    const castle = town({ inside: [[TY.cottage, 5], [TY.barracks, 1]], bank: { wood: 50000 } });
    const w = world(castle, { rules: { 'up:1:5': { wood: 120000, food: 1000 } } });
    w.goals('build c:6\nbuild b:2');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [], 'the builder took something else, or sent a doomed order');
    assert.match(r.build.note, /waiting for 120k wood \(50k held\) to upgrade Cottage \(pos 0\) L5->L6; troop and wall batches leave 1,000 food, 120k wood in the bank for it/);
    assert.deepStrictEqual(w.state().failures || {}, {});
    const reads = w.condReads().length;
    await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [], 'still short');
    castle.resource.wood.amount = 200000;                      // server.ResourceUpdate
    await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', 0]]);
    assert.strictEqual(w.condReads().length, reads, 'the cost was read again each slice');
  });

  await t('short of idle population: the same wait, and troops leave it', async () => {
    const castle = town({ inside: [[TY.cottage, 5]], pop: { cur: 1000, work: 800 } });
    const w = world(castle, { rules: { 'up:1:5': { population: 500 } } });
    w.goals('build c:6');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), []);
    assert.match(r.build.note, /waiting for 500 idle population \(200 idle\) to upgrade Cottage \(pos 0\) L5->L6/);
  });

  await t('a prerequisite short of resources: the wait is for the prerequisite, and says whose', async () => {
    const castle = town({ th: 7, inside: [[TY.cottage, 8]], bank: { stone: 10 } });
    const w = world(castle, { rules: { ...cottageNeedsTH, 'up:31:7': { stone: 90000 } } });
    w.goals('build c:9');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), []);
    assert.match(r.build.note, /waiting for 90k stone \(10 held\) to upgrade Town Hall \(pos -1\) L7->L8 for Cottage L9 \(it needs Town Hall L8\), which Cottage L9 needs first/);
  });

  await t('a refusal the ConditionBean did not predict still backs off; "at a time" still holds the builder', async () => {
    const castle = town({ inside: [[TY.cottage, 1]] });
    const w = world(castle, { refuse: () => ({ ok: -1, errorMsg: 'Something else went wrong' }) });
    w.goals('build c:3');
    await w.e.focus(castle);
    assert.ok(w.state().failures['build:upgrade:1:0'], 'the unexplained refusal was not backed off');
    const busy = world(town({ inside: [[TY.cottage, 1]] }), { refuse: () => ({ ok: -1, errorMsg: 'One building allowed to be built at a time.' }) });
    busy.goals('build c:3');
    await busy.e.focus(busy.castle);
    assert.ok(busy.state().builderHeld > Date.now());
    assert.deepStrictEqual(busy.state().failures || {}, {});
    const reads = busy.condReads().length;
    await busy.e.focus(busy.castle);
    assert.strictEqual(busy.condReads().length, reads, 'read requirements while the server said the builder is busy');
  });

  await t('an unreadable requirement: sent unchecked, as before; a refusal then backs off', async () => {
    const castle = town({ inside: [[TY.cottage, 1]] });
    const w = world(castle, { refuse: () => ({ ok: -1, errorMsg: 'Insufficient resources. Required Lumber 500.' }) });
    w.game.req = async (cmd) => { w.reads.push([cmd]); return { ok: -1, errorMsg: 'server busy' }; };
    w.goals('build c:3');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', 0]]);
    assert.match(r.build.note, /its requirements could not be read \(server busy\), so it goes unchecked/);
    assert.ok(w.state().failures['build:upgrade:1:0']);
  });

  // ================================================================ reads
  console.log('\nreads: cached, and dropped when the buildings change\n');

  await t('a read is kept: the next slice asks nothing; a changed building reads again', async () => {
    const castle = town({ inside: [[TY.cottage, 5]], bank: { wood: 1 } });
    const w = world(castle, { rules: { 'up:1:5': { wood: 100 } } });
    w.goals('build c:6');
    await w.e.focus(castle);
    await w.e.focus(castle);
    assert.strictEqual(w.condReads().length, 1);
    castle.buildings.push(bean(TY.barracks, 5, 1));          // a push: something new stands
    await w.e.focus(castle);
    assert.strictEqual(w.condReads().length, 2);
  });

  await t('one read serves every building of a type at a level', async () => {
    const castle = town({ outside: many(TY.farm, 6, 3) });
    const w = world(castle, { rules: { 'up:7:3': { techs: [[TECH.informatics, 2]] } } });
    w.goals('build f:4:6');
    const r = await w.e.focus(castle);
    assert.strictEqual(w.condReads().length, 1);
    assert.match(r.build.note, /passed over: upgrade Farm \(pos 1001\) L3->L4: needs research Informatics L2 .*\(\+3 more\)/);
  });

  await t('nothing is read while the builder is busy, or with construction paused', async () => {
    const castle = town({ inside: [[TY.cottage, 5]] });
    Object.assign(castle.buildings.find((b) => b.typeId === TY.cottage), { status: 1, endTime: Date.now() + 600e3 });
    const w = world(castle);
    w.goals('build c:9');
    await w.e.focus(castle);
    assert.strictEqual(w.condReads().length, 0);
    const p = world(town({ inside: [[TY.cottage, 5]] }));
    p.e.goalsFor = () => parseGoals('config hero:0,building:0\nbuild c:9');
    await p.e.focus(p.castle);
    assert.strictEqual(p.condReads().length, 0);
  });

  await t('a fault in the resolver does not stop construction: the first order goes, as before', async () => {
    const castle = town({ inside: [[TY.cottage, 1]] });
    const w = world(castle, { rules: { 'up:1:1': { wood: 5 } } });
    w.goals('build c:3');
    const was = Game.unmetOf;
    Game.unmetOf = () => { throw new Error('boom'); };
    let r;
    try { r = await w.e.focus(castle); } finally { Game.unmetOf = was; }
    assert.deepStrictEqual(w.builds(), [['upgrade', 0]]);
    assert.match(r.build.note, /requirements not checked \(boom\)/);
  });

  await t('a dry run reads and plans the prerequisite, and sends nothing', async () => {
    const w = world(town({ th: 7, inside: [[TY.cottage, 8]] }), { rules: cottageNeedsTH });
    w.goals('build c:9');
    w.e.dryRun = true;
    const r = await w.e.focus(w.castle);
    assert.deepStrictEqual(w.builds(), []);
    assert.ok(r.acted.includes('[plan] upgrade Town Hall (pos -1) L7->L8 for Cottage L9 (it needs Town Hall L8)'), r.acted.join(' | '));
  });

  // ================================================================ budget
  console.log('\nconstruction has its own slot, outside the three actions\n');

  await t('three troop batches and a construction in the same slice', async () => {
    const castle = town({ inside: [[TY.barracks, 10], [TY.cottage, 1]] });
    const w = world(castle, { troopTypes: [3, 4, 5] });
    w.goals('troop w:100,s:100,p:100\nbuild c:2');
    assert.strictEqual(w.e.maxActionsPerSlice, 3);
    await w.e.focus(castle);
    assert.strictEqual(w.sent.filter((s) => s[0] === 'troop').length, 3);
    assert.deepStrictEqual(w.builds(), [['upgrade', 1]], 'the troop batches starved the builder');
  });

  await t('still one construction a slice', async () => {
    const castle = town({ inside: [[TY.cottage, 1], [TY.cottage, 1]] });
    const w = world(castle);
    w.goals('build c:5:2');
    await w.e.focus(castle);
    assert.strictEqual(w.builds().length, 1);
  });

  // ================================================================ reserve
  console.log('\ntroop and wall batches leave the next construction\'s cost in the bank\n');

  const troopCtx = (bank, reserve) => {
    const castle = town({ bank });
    return { goals: parseGoals('troop b:1000').goals, config: {}, castle, buildReserve: reserve };
  };

  await t('troop batches are sized against the bank less the construction\'s cost', async () => {
    const free = troopPlan(troopCtx({ wood: 100000 }, null));
    assert.strictEqual(free.orders[0].num, 33);                 // 100,000 / 3,000 wood a ballista
    const kept = troopPlan(troopCtx({ wood: 100000 }, { wood: 40000, stone: 5, label: 'upgrade Walls (pos -2) L9->L10' }));
    assert.strictEqual(kept.orders[0].num, 20);                 // 60,000 / 3,000
    assert.match(kept.note, /leaving 40k wood, 5 stone in the bank for upgrade Walls \(pos -2\) L9->L10/);
    const none = troopPlan(troopCtx({ wood: 30000 }, { wood: 40000, label: 'x' }));
    assert.deepStrictEqual(none.orders, []);
    assert.match(none.note, /waiting on resources/);
  });

  await t('through the engine: a construction waiting for wood stops wood-hungry batches', async () => {
    const castle = town({ inside: [[TY.barracks, 10], [TY.cottage, 5]], bank: { wood: 50000 } });
    const w = world(castle, { rules: { 'up:1:5': { wood: 120000 } }, troopTypes: [11] });
    w.goals('troop b:1000\nbuild c:6');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.sent, [], 'the batch spent the wood the builder waits for');
    assert.match(r.troop.note, /leaving 120k wood in the bank for upgrade Cottage \(pos 1\) L5->L6/);
  });

  await t('the construction placed this slice keeps its cost from the batches placed before it', async () => {
    const castle = town({ inside: [[TY.barracks, 10], [TY.cottage, 5]], bank: { wood: 200000 } });
    const w = world(castle, { rules: { 'up:1:5': { wood: 120000 } }, troopTypes: [11] });
    w.goals('troop b:1000\nbuild c:6');
    await w.e.focus(castle);
    assert.deepStrictEqual(w.sent, [['troop', 11, 26], ['upgrade', 1]]);     // (200k - 120k) / 3k
  });

  await t('wall batches too: sized from what one of each costs, read once', async () => {
    const castle = town({ walls: 10, inside: [[TY.cottage, 5]], bank: { wood: 150000 } });
    const w = world(castle, { rules: { 'up:1:5': { wood: 120000 } }, fortCosts: { 15: { wood: 100 } } });
    w.goals('build c:6\nfortification ab:5000');
    await w.e.focus(castle);
    assert.deepStrictEqual(w.sent, [['wall', 15, 300], ['upgrade', 0]]);     // (150k - 120k) / 100
    await w.e.focus(castle);
    assert.strictEqual(w.reads.filter(([c]) => c === 'fortifications.getFortificationsProduceList').length, 1);
  });

  await t('wall costs unreadable while the builder waits: no wall batch rather than spend its cost', async () => {
    const castle = town({ walls: 10, inside: [[TY.cottage, 5]], bank: { wood: 50000 } });
    const w = world(castle, { rules: { 'up:1:5': { wood: 120000 } } });
    w.goals('build c:6\nfortification ab:5000');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.sent, []);
    assert.match(r.fort.note, /waiting on the fortification costs \(unread\), with 120k wood kept for upgrade Cottage/);
    const f = fortPlan({ goals: parseGoals('fortification ab:10').goals, fortifications: {}, walls: { level: 10, queue: [] }, castle });
    assert.deepStrictEqual(f.orders.map((o) => o.num), [10], 'with nothing kept, the space alone decides, as before');
  });

  // ================================================================ field plots
  console.log('\nfield plots: the Town Hall opens them\n');

  await t('fields that cannot fit raise the Town Hall, no further than they need', async () => {
    const castle = town({ th: 7, outside: many(TY.farm, 31, 9) });            // 13 + 6 x 3 = 31, all taken
    const p = buildPlan({ goals: parseGoals('build f:10:37').goals, castle, config: {} });
    const th = p.ranked.find((a) => a.def.typeId === TY.th);
    assert.ok(th, 'the Town Hall was not raised');
    assert.strictEqual(buildLabel(th), 'upgrade Town Hall (pos -1) L7->L8 for field plots (Town Hall L9 opens 37)');
    assert.strictEqual(p.ranked[0], th, 'field plots come before the farm upgrades');
    assert.match(p.note, /Town Hall to L9 for field plots/);
  });

  await t('new fields on open plots first, then the Town Hall, then the upgrades', async () => {
    const castle = town({ th: 7, outside: many(TY.farm, 29, 9) });            // two plots free
    const p = buildPlan({ goals: parseGoals('build f:10:37').goals, castle, config: {} });
    assert.deepStrictEqual(p.ranked.slice(0, 3).map((a) => [a.kind, a.def.name]), [['new', 'Farm'], ['new', 'Farm'], ['upgrade', 'Town Hall']]);
  });

  await t('no Town Hall when the demolitions in the lines free enough, or it is L10', async () => {
    const mixed = town({ th: 7, outside: [...many(TY.farm, 20, 10), ...many(TY.sawmill, 11, 5)] });
    const p = buildPlan({ goals: parseGoals('build f:10:31,s:0:0').goals, castle: mixed, config: {} });
    assert.ok(!p.ranked.some((a) => a.def.typeId === TY.th), '31 farms fit once the sawmills are gone');
    const ten = buildPlan({ goals: parseGoals('build f:10:41').goals, castle: town({ outside: many(TY.farm, 40, 9) }), config: {} });
    assert.ok(!ten.ranked.some((a) => a.def.typeId === TY.th));
  });

  await t('a1\'s line with Town Hall L7: demolitions, the Town Hall to L9, then 37 L10 farms', async () => {
    const castle = town({ th: 7, outside: [...many(TY.farm, 20, 10), ...many(TY.sawmill, 6, 6), ...many(TY.iron, 5, 5)] });
    const goals = parseGoals('build f:10:37,s:0:0,i:0:0,q:0:0').goals;
    for (let i = 0; i < 2000; i++) {
      const p = buildPlan({ goals, castle, config: {} });
      if (!p.actions.length) break;
      const a = p.actions[0];
      if (a.kind === 'new') castle.buildings.push(bean(a.def.typeId, a.positionId, 1));
      else {
        const b = castle.buildings.find((x) => x.positionId === a.positionId);
        b.level += a.kind === 'upgrade' ? 1 : -1;
        if (b.level <= 0) castle.buildings.splice(castle.buildings.indexOf(b), 1);
      }
    }
    assert.deepStrictEqual(levelsOf(castle, TY.th), [9]);
    assert.deepStrictEqual(levelsOf(castle, TY.farm), Array(37).fill(10));
    assert.deepStrictEqual([levelsOf(castle, TY.sawmill), levelsOf(castle, TY.iron)], [[], []]);
  });

  await t('a Town Hall to L10 for field plots needs a script: none held, the farms go on', async () => {
    const castle = town({ th: 9, outside: many(TY.farm, 37, 9) });
    const w = world(castle, { rules: { 'up:31:9': { items: [[SCRIPT, 1]] } } });
    w.goals('build f:10:40');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', 1001]]);
    assert.match(r.build.note, /passed over: upgrade Town Hall \(pos -1\) L9->L10 for field plots \(Town Hall L10 opens 40\): needs 1 Michelangelo's Script, none held/);
  });

  // ================================================================ console
  console.log('\nthe console\'s outlook\n');

  await t('the Buildings tab names the prerequisite, the wait, and what is passed over', async () => {
    const castle = town({ th: 7, inside: [[TY.cottage, 8]] });
    const w = world(castle, { rules: { ...cottageNeedsTH, 'new:30': { techs: [[TECH.informatics, 1]] } } });
    w.goals('build be:1,c:9');
    w.e.dryRun = true;
    await w.e.focus(castle);
    const checking = buildOutlook({ castle, goals: parseGoals('build be:1,c:9').goals, cityState: w.state() });
    assert.deepStrictEqual([checking.next, checking.wait], ['upgrade Cottage (pos 0) L8->L9', 'its requirements are read next slice']);
    await w.e.focus(castle);
    const goals = parseGoals('build be:1,c:9').goals;
    const o = buildOutlook({ castle, goals, cityState: w.state() });
    assert.strictEqual(o.next, 'upgrade Town Hall (pos -1) L7->L8 for Cottage L9 (it needs Town Hall L8)');
    assert.ok(o.held.some((h) => /Beacon Tower.*Informatics L1/.test(h)), o.held.join(' | '));
    castle.resource.stone.amount = 0;
    const s = world(castle, { rules: { ...cottageNeedsTH, 'up:31:7': { stone: 5000 } } });
    s.goals('build c:9');
    await s.e.focus(castle);
    const held = buildOutlook({ castle, goals: parseGoals('build c:9').goals, cityState: s.state() });
    assert.match(held.next, /^upgrade Town Hall \(pos -1\) L7->L8/);
    assert.match(held.wait, /^waiting for 5,000 stone \(0 held\)/);
    castle.buildings.push(bean(TY.inn, 3, 1));                 // the city changed since: the plan's own view
    assert.match(buildOutlook({ castle, goals: parseGoals('build c:9').goals, cityState: s.state() }).next, /^upgrade Cottage/);
  });

  await t('resolvePrereqs is pure: an unread order comes back as a need', async () => {
    const castle = town({ inside: [[TY.cottage, 1]] });
    const plan = buildPlan({ goals: parseGoals('build c:2').goals, castle, config: {} });
    const r = resolvePrereqs({ plan, castle, conds: () => undefined });
    assert.strictEqual(r.pick, null);
    assert.strictEqual(buildLabel(r.need), 'upgrade Cottage (pos 0) L1->L2');
    const known = resolvePrereqs({ plan, castle, conds: () => ({ at: Date.now(), cond: { wood: 10 } }) });
    assert.strictEqual(buildLabel(known.pick), 'upgrade Cottage (pos 0) L1->L2');
    assert.deepStrictEqual(known.cost, { wood: 10 });
  });

  // ================================================================ live goals
  console.log('\nthe live a2 lines\n');

  // Lord02's build lines (live-goals.txt). Stand-in requirements: the
  // Beacon Tower wants Walls L5 and Informatics L1, the Relief Station a L5
  // Stable (the city has none) and the Stable a L5 Farm; every L10 a
  // Michelangelo's Script, of which the city holds one.
  const A2 = 'build fh:1\nbuild th:10,w:10,c:10:1,b:10:1,a:10:1,r:10:1,be:10:1,rs:10:1\nbuild f:10:37';
  const a2City = () => town({
    th: 9, walls: 9,
    inside: [...many(TY.cottage, 8, 10), ...many(TY.barracks, 3, 10), [TY.academy, 10], [TY.rally, 10], [TY.fh, 1]],
    outside: many(TY.farm, 37, 10),
  });
  const a2Rules = (key) => {
    if (key === 'new:30') return { buildings: [[TY.walls, 5]], techs: [[TECH.informatics, 1]], wood: 5000 };
    if (key === 'new:24') return { buildings: [[TY.stable, 5]], wood: 5000 };
    if (key === 'new:20') return { buildings: [[TY.farm, 5]], wood: 5000 };
    if (/^up:\d+:9$/.test(key)) return { items: [[SCRIPT, 1]], wood: 50000 };
    return { wood: 1000 };
  };

  await t('a2: the Stable for the Relief Station first, the Beacon Tower waits on research, one script on the Town Hall', async () => {
    const castle = a2City();
    const w = world(castle, { rules: a2Rules, items: [[SCRIPT, 1]] });
    w.goals(A2);
    await w.e.focus(castle);                   // the Beacon Tower's and the Relief Station's needs read
    assert.deepStrictEqual(w.builds(), []);
    const first = await w.e.focus(castle);     // then the Stable's
    assert.deepStrictEqual(w.builds(), [['new', 16, TY.stable]], 'the Stable goes on the first plot the plan has not claimed');
    assert.match(first.build.note, /prerequisite first: new Stable \(pos 16\) for a new Relief Station \(it needs Stable L5\)/);
    assert.match(first.build.note, /passed over: new Beacon Tower \(pos 14\): needs research Informatics L1/);
    w.finish();
    const last = await w.settle();
    const b = w.builds().map(([k, pos, type]) => (k === 'new' ? `new ${C.BUILDING_BY_ID[type].name}` : `${k} ${pos}`));
    assert.deepStrictEqual(b.slice(0, 6), ['new Stable', 'upgrade 16', 'upgrade 16', 'upgrade 16', 'upgrade 16', 'new Relief Station']);
    assert.deepStrictEqual(b.slice(6, 14), Array(8).fill('upgrade 15'), 'the Relief Station to L9');
    assert.deepStrictEqual(b.slice(14), ['upgrade -1'], 'the one script went on the Town Hall');
    assert.deepStrictEqual([levelsOf(castle, TY.th), levelsOf(castle, TY.walls), levelsOf(castle, TY.relief), levelsOf(castle, TY.stable)],
      [[10], [9], [9], [5]]);
    assert.deepStrictEqual(levelsOf(castle, TY.beacon), []);
    assert.strictEqual(Game.countOf(w.player.items, SCRIPT), 0);
    assert.match(last.build.note, /upgrade Walls \(pos -2\) L9->L10: needs 1 Michelangelo's Script, none held/);
    assert.match(last.build.note, /upgrade Relief Station \(pos 15\) L9->L10: needs 1 Michelangelo's Script, none held/);
    assert.deepStrictEqual(w.state().researchWants.map((x) => [x.techId, x.level, x.for]), [[7, 1, 'a new Beacon Tower']]);
    assert.deepStrictEqual(w.state().failures || {}, {}, 'something went on the backoff ladder');
  });

  await t('a2, every line already met: nothing is read and nothing sent', async () => {
    const castle = town({
      th: 10, walls: 10,
      inside: [...many(TY.cottage, 8, 10), ...many(TY.barracks, 3, 10), [TY.academy, 10], [TY.rally, 10],
        [TY.beacon, 10], [TY.relief, 10], [TY.fh, 1]],
      outside: many(TY.farm, 37, 10),
    });
    const w = world(castle, { rules: a2Rules });
    w.goals(A2);
    const r = await w.e.focus(castle);
    assert.deepStrictEqual([w.builds(), w.condReads()], [[], []]);
    assert.strictEqual(r.build.note, 'all build targets met');
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
