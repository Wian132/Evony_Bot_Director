'use strict';
// Step 5: build lines read the NEAT way (wiki: Build), and the first Walls.
//
// Offline: fake castles made of building beans ({typeId, level, positionId,
// status}), the planner run over them, and the engine against a stub game.
// Each rule is checked against the wiki's own examples where it has one.
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

// db.js opens EVONY_DB when first required: point it at a throwaway file
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evony-build-neat-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMP, 'test.db');

const C = require('./constants');
const { parseGoals, describe } = require('./goals');
const { Engine, buildPlan, buildLabel, buildOutlook } = require('./engine');

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
const bean = (typeId, positionId, level, status = 0, extra = {}) => ({
  typeId, name: C.BUILDING_BY_ID[typeId].name, positionId, level, status, ...extra,
});
// [typeId, level] x count; `level` may be a list, one per building
const many = (typeId, count, level) => Array.from({ length: count }, (_, i) => [typeId, Array.isArray(level) ? level[i] : level]);
// Town Hall at -1, Walls at -2 (walls: 0 for none), inside plots from 0, fields from 1001
function town({ th = 10, walls = 5, inside = [], outside = [] } = {}) {
  const b = [bean(TY.th, -1, th)];
  if (walls) b.push(bean(TY.walls, -2, walls));
  inside.forEach(([typeId, level], i) => b.push(bean(typeId, i, level)));
  outside.forEach(([typeId, level], i) => b.push(bean(typeId, 1001 + i, level)));
  return {
    id: 1, name: 'T', fieldId: 100 * 800 + 100, buildings: b, troop: {}, fortification: {}, heros: [],
    resource: { food: { amount: 1e12 }, wood: { amount: 1e12 }, stone: { amount: 1e12 }, iron: { amount: 1e12 },
      curPopulation: 1000, maxPopulation: 1000, workPeople: 0, buildPeople: 0 },
  };
}
// all 32 city plots taken: 4 barracks, 12 cottages, every one-per-city building
// but the academy, and warehouses on the rest
const FULL_INSIDE = [
  ...many(TY.barracks, 4, 9), ...many(TY.cottage, 12, 5),
  [TY.stable, 5], [TY.forge, 5], [TY.workshop, 5], [TY.embassy, 5], [TY.fh, 5], [TY.inn, 5], [TY.market, 5],
  [TY.rally, 5], [TY.relief, 5], [TY.beacon, 5], ...many(TY.warehouse, 6, 5),
];

const goalsOf = (src) => parseGoals(src).goals;
const plan = (src, castle, extra = {}) => buildPlan({ goals: goalsOf(src), castle, config: {}, ...extra }, extra.wallsFor || 0);
const levels = (castle, typeId) => castle.buildings.filter((b) => b.typeId === typeId).map((b) => b.level).sort((a, b) => b - a);
const kinds = (list) => list.map((a) => [a.kind, a.def.name, a.positionId]);

// What the builder does once an order ends: one level up, one level down (at
// 0 the plot is empty), or a new building at L1.
function apply(castle, a) {
  if (a.kind === 'new') { castle.buildings.push(bean(a.def.typeId, a.positionId, 1)); return; }
  const i = castle.buildings.findIndex((b) => b.positionId === a.positionId);
  const b = castle.buildings[i];
  b.level += a.kind === 'upgrade' ? 1 : -1;
  if (b.level <= 0) castle.buildings.splice(i, 1);
}
// Place the first order, let it finish, plan again — until nothing is left.
function settle(src, castle, extra = {}, max = 3000) {
  const goals = goalsOf(src);
  const steps = [];
  for (let i = 0; i < max; i++) {
    const p = buildPlan({ goals, castle, config: {}, ...extra }, 0);
    if (!p.actions.length) return { steps, plan: p };
    const a = p.actions[0];
    steps.push({ kind: a.kind, typeId: a.def.typeId, positionId: a.positionId, from: a.kind === 'upgrade' ? a.from : a.level, label: buildLabel(a) });
    apply(castle, a);
  }
  throw new Error('the plan never settled');
}

// A stub game for the engine: records construction orders and reads.
function engineGame(castle, { research = null, wallsReply = null } = {}) {
  const sent = [], reads = [];
  const game = {
    castles: [castle],
    player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [] },
    castle: () => castle,
    castleId: () => 1,
    castleXY: () => ({ x: 100, y: 100 }),
    now: () => Date.now(),
    req: async (cmd) => {
      reads.push(cmd);
      if (cmd === 'tech.getResearchList') return research ? research() : { ok: -1, errorMsg: 'not stubbed' };
      if (cmd === 'fortifications.getProduceQueue') return wallsReply || { ok: 1, allProduceQueue: [] };
      return { ok: 1 };
    },
    upgradeBuilding: async (_cid, pos) => { sent.push(['upgrade', pos]); return { ok: 1 }; },
    newBuilding: async (cid, pos, type) => { sent.push(['new', pos, type, cid]); return { ok: 1 }; },
    destructBuilding: async (_cid, pos) => { sent.push(['demolish', pos]); return { ok: 1 }; },
    produceWall: async () => ({ ok: 1 }),
    dischargeChief: async () => ({ ok: 1 }),
    promoteToChief: async () => ({ ok: 1 }),
  };
  const e = new Engine(game, () => {});
  e.dryRun = false;
  e.state = {};
  return { game, e, sent, reads };
}
const research = (levels) => () => ({ ok: 1, acailableResearchBeans: Object.entries(levels).map(([typeId, level]) => ({ typeId: Number(typeId), level, avalevel: 10 })) });

// The build lines saved for the live cities on 2026-09-14 (scratchpad live-goals.txt).
const A1 = 'build f:10:37,s:0:0,i:0:0,q:0:0';
const A2 = [
  '// Farms only for now. Delete this line and restore the one below it to opt in.',
  'build fh:1',
  'build th:10,w:10,c:10:1,b:10:1,a:10:1,r:10:1,be:10:1,rs:10:1',
  'build f:10:37',
  '// build f:10:37,s:0:1,i:0:1,q:0:1',
  'troop b:5k,t:5k',
  'fortification ab:5000',
].join('\n');

(async () => {
  // ================================================================ parser
  console.log('\nbuild lines: parsing\n');

  await t('a quantity is optional and reads as 1', async () => {
    const [g] = goalsOf('build c:10,b:9:15');
    assert.deepStrictEqual(g.targets.map((x) => [x.typeId, x.level, x.quantity]), [[1, 10, 1], [2, 9, 15]]);
  });

  await t('a level or quantity that is not a whole number is refused, not read as 0', async () => {
    const p = parseGoals('build f:10:*,f:x:3,f:1.5:3,c,c:11,b:9:15');
    assert.deepStrictEqual(p.goals[0].targets.map((x) => x.raw), ['b:9:15'], 'a bad target got through');
    const errs = p.errors.map((e) => e.error).join('\n');
    assert.match(errs, /"f:10:\*": quantity "\*" is not a whole number/);
    assert.match(errs, /"f:x:3": level "x" is not a whole number/);
    assert.match(errs, /"f:1\.5:3": level "1\.5"/);
    assert.match(errs, /"c" needs buildingType:level\[:quantity\]/);
    assert.match(errs, /"c:11": buildings go to level 10 at most/);
  });

  await t('t is the Town Hall, th still works, and full names are accepted', async () => {
    const names = {
      t: 31, th: 31, academy: 25, barrack: 2, barracks: 2, 'beacon tower': 30, beacontower: 30, cottage: 1,
      embassy: 28, 'feasting hall': 27, feastinghall: 27, forge: 22, farm: 7, sawmill: 4, quarry: 5,
      'iron mine': 6, ironmine: 6, inn: 21, market: 23, marketplace: 23, 'rally spot': 29, rallyspot: 29,
      'relief station': 24, reliefstation: 24, stable: 20, 'town hall': 31, townhall: 31, wall: 32, walls: 32,
      warehouse: 3, workshop: 26,
    };
    for (const [name, typeId] of Object.entries(names)) {
      const p = parseGoals(`build ${name}:3`);
      assert.deepStrictEqual(p.errors, [], `${name}: ${JSON.stringify(p.errors)}`);
      assert.strictEqual(p.goals[0].targets[0].typeId, typeId, name);
    }
    const two = parseGoals('build Iron Mine:10:5,Rally Spot:1 town hall:10');
    assert.deepStrictEqual(two.goals[0].targets.map((x) => x.typeId), [6, 29, 31]);
  });

  await t('the console still shows th beside the Town Hall', async () => {
    const { BUILD_ABBR } = require('./goals');
    const codeFor = Object.fromEntries(Object.entries(BUILD_ABBR).map(([code, name]) => [name, code]));
    assert.strictEqual(codeFor['Town Hall'], 'th');
    assert.strictEqual(codeFor.Farm, 'f');
  });

  await t('?condition? before or after the targets reads the same', async () => {
    const [a] = goalsOf('build ?w:10?q:0:0,ws:0:0');
    const [b] = goalsOf('build q:0:0,ws:0:0?w:10?');
    for (const g of [a, b]) {
      assert.strictEqual(g.groups.length, 1);
      assert.deepStrictEqual(g.groups[0].when.map((c) => [c.typeId, c.level, c.quantity]), [[32, 10, 1]]);
      assert.deepStrictEqual(g.groups[0].targets.map((x) => x.raw), ['q:0:0', 'ws:0:0']);
    }
  });

  await t('each space-separated group has its own condition', async () => {
    const [g] = goalsOf('build ?w:10?q:0:0,ws:0:0 w:10');
    assert.strictEqual(g.groups.length, 2);
    assert.strictEqual(g.groups[0].condition, 'w:10');
    assert.strictEqual(g.groups[1].condition, null);
    assert.deepStrictEqual(g.groups[1].targets.map((x) => x.raw), ['w:10'], 'the old parser read "0 w:10" as quantity 0');
  });

  await t('conditions: research, the quantity form, st = Stable and sp = Stockpile', async () => {
    const [g] = goalsOf('build ?met:10,w:10?q:0:0,ws:0:0');
    assert.deepStrictEqual(g.groups[0].when.map((c) => c.tech || c.typeId), [5, 32]);
    assert.ok(g.needsTech);
    const [q] = goalsOf('build ?i:4:0?s:9:40');
    assert.deepStrictEqual(q.groups[0].when.map((c) => [c.typeId, c.level, c.quantity]), [[6, 4, 0]]);
    assert.ok(!q.needsTech, 'reads research for a line that names none');
    const [s] = goalsOf('build ?st:10,sp:5?c:1');
    assert.deepStrictEqual(s.groups[0].when.map((c) => c.tech ? `tech ${c.tech}` : `building ${c.typeId}`), ['building 20', 'tech 15']);
  });

  await t('a condition standing apart from its targets leaves the whole line out', async () => {
    const p = parseGoals('build ?w:10? q:0:0 b:9:15');
    assert.strictEqual(p.goals[0].targets.length, 0, 'q:0:0 would have run without its condition');
    assert.match(p.errors[0].error, /whole line is left out/);
  });

  await t('a condition that cannot be read leaves its group out, never runs it unconditionally', async () => {
    const p = parseGoals('build ?xx:1?q:0:0 w:10');
    assert.deepStrictEqual(p.goals[0].targets.map((x) => x.raw), ['w:10']);
    assert.match(p.errors[0].error, /unknown building or research "xx"/);
  });

  await t('the Town Hall and the Walls are never demolished; one-per-city buildings stay one', async () => {
    const p = parseGoals('build th:0:0,t:5:0,w:0:0,a:10:2');
    assert.deepStrictEqual(p.goals[0].targets.map((x) => [x.raw, x.quantity]), [['a:10:2', 1]]);
    const errs = p.errors.map((e) => e.error).join('\n');
    assert.match(errs, /"th:0:0": the bot never demolishes or takes down the Town Hall/);
    assert.match(errs, /"t:5:0": the bot never demolishes or takes down the Town Hall/);
    assert.match(errs, /"w:0:0": the bot never demolishes or takes down the Walls/);
    assert.match(errs, /a city has one Academy/);
  });

  await t('config building is a known key, 0 or 1', async () => {
    const ok = parseGoals('config building:0');
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.config.building, 0);
    assert.match(parseGoals('config building:off').errors[0].error, /building is 0 \(construction paused\) or 1/);
  });

  await t('every build line on the wiki parses cleanly', async () => {
    const wiki = [
      'build b:9:15', 'build ?w:10?q:0:0,ws:0:0', 'build c:10:9', 'build c:0:8', 'build b:4:15,b:9:2',
      'build c:0:9', 'build st:0:0', 'build fo:0:0', 'build ws:0:0', 'build s:9:40', 'build f:0:0', 'build q:0:0',
      'build i:0:0', 'build b:9:12', 'build inn:2:0', 'build i:5:0', 'build ?w:10?q:0:0,ws:0:0 w:10',
      'build ?met:10,w:10?q:0:0,ws:0:0', 'build q:0:0,ws:0:0?w:10?', 'build ?i:4:0?s:9:40', 'build c:1',
      'build c:4:9,i:4:40', 'build b:4:14',
    ];
    const p = parseGoals(wiki.join('\n'));
    assert.deepStrictEqual(p.errors, []);
  });

  await t('the live goal texts still parse cleanly', async () => {
    assert.deepStrictEqual(parseGoals(A1).errors, []);
    assert.deepStrictEqual(parseGoals(A2).errors, []);
  });

  await t('describe says what each line means', async () => {
    const out = describe(parseGoals('build b:4:15,b:9:2\nbuild ?w:10?q:0:0,ws:0:0 w:10\nbuild c:0:8,inn:2:0')).join('\n');
    assert.match(out, /build: 3 line\(s\), worked on in order/);
    assert.match(out, /1\. 15 x Barracks to L4, 2 x Barracks to L9/);
    assert.match(out, /2\. no Quarry, no Workshop \(only when w:10\); 1 x Walls to L10/);
    assert.match(out, /3\. at most 8 Cottage, no Inn at L2 or higher/);
  });

  // Step 1's editor colours (parseGoals `lines`): blue when the engine acts on
  // the line, red for an error. Nothing build-related is in NOT_IMPLEMENTED.
  await t('editor colours: build lines, conditions and config building', async () => {
    const { NOT_IMPLEMENTED } = require('./goals');
    const st = (src) => parseGoals(src).lines.map((l) => l.status);
    assert.deepStrictEqual(st([
      'build ?w:10?q:0:0,ws:0:0 w:10', 'build q:0:0,ws:0:0?w:10?', 'build ?met:10,w:10?q:0:0,ws:0:0',
      'build ?i:4:0?s:9:40', 'build t:10,Iron Mine:10:5,c:0:8,inn:2:0', 'build b:4:15,b:9:2',
    ].join('\n')), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    assert.deepStrictEqual(parseGoals('config building:0').lines[0], { n: 1, status: 'ok', msg: null });
    assert.deepStrictEqual(parseGoals('config building:1,comfort:1').lines[0], { n: 1, status: 'ok', msg: null });
    for (const src of ['build f:10:*', 'build ?w:10? q:0:0', 'build ?xx:1?q:0:0', 'build a:10:2', 'build th:0:0',
      'build c:11', 'build', 'config building:off']) {
      assert.strictEqual(parseGoals(src).lines[0].status, 'error', src);
    }
    assert.match(parseGoals('build').lines[0].msg, /needs at least one buildingType:level/);
    assert.ok(!('building' in NOT_IMPLEMENTED.config) && !('build' in NOT_IMPLEMENTED.goals));
    assert.ok(!NOT_IMPLEMENTED.bare.includes('build') && !NOT_IMPLEMENTED.bare.includes('building'));
    assert.deepStrictEqual(parseGoals(A2).lines.filter((l) => l.status !== 'comment').map((l) => l.status),
      ['ok', 'ok', 'ok', 'ok', 'ok'], 'a live line is not blue');
  });

  // ================================================================ targets
  console.log('\nbuild targets: a final quantity at a level or higher\n');

  // wiki: "if you have a total of 16 barracks, fourteen at level 9 and two at
  // level 10, and you set build b:9:15 ... the bot will not demolish or downgrade"
  const sixteen = () => town({ inside: [...many(TY.barracks, 2, 10), ...many(TY.barracks, 14, 9)] });

  await t('b:9:15 with 16 barracks demolishes nothing', async () => {
    const p = plan('build b:9:15', sixteen());
    assert.deepStrictEqual(p.ranked, []);
    assert.strictEqual(p.note, 'all build targets met');
  });

  await t('b:9:16 does not take the two L10 barracks down to L9', async () => {
    assert.deepStrictEqual(plan('build b:9:16', sixteen()).ranked, []);
  });

  await t('b:0:15 demolishes one L9 barrack and leaves the two at L10', async () => {
    const castle = sixteen();
    const p = plan('build b:0:15', castle);
    assert.deepStrictEqual(p.ranked.map((a) => [a.kind, a.positionId, a.level]), [['demolish', 2, 9]]);
    settle('build b:0:15', castle);
    assert.deepStrictEqual(levels(castle, TY.barracks), [10, 10, ...Array(13).fill(9)]);
  });

  await t('no quantity: c:1 leaves a city of cottages alone, and gives a new city its first', async () => {
    assert.deepStrictEqual(plan('build c:1', town({ inside: many(TY.cottage, 20, 3) })).ranked, []);
    const p = plan('build c:1', town({ walls: 0 }));
    assert.deepStrictEqual(kinds(p.ranked), [['new', 'Cottage', 0]]);
  });

  await t('no quantity: c:10 raises one cottage and demolishes none', async () => {
    const castle = town({ inside: many(TY.cottage, 5, 3) });
    const p = plan('build c:10', castle);
    assert.deepStrictEqual(kinds(p.ranked), [['upgrade', 'Cottage', 0]]);
    settle('build c:10', castle);
    assert.deepStrictEqual(levels(castle, TY.cottage), [10, 3, 3, 3, 3]);
  });

  await t('c:0:8 keeps 8 cottages, the strongest, and builds none', async () => {
    const castle = town({ inside: many(TY.cottage, 10, [5, 1, 7, 2, 9, 10, 3, 4, 6, 8]) });
    const { steps } = settle('build c:0:8', castle);
    assert.deepStrictEqual(steps.map((s) => s.label), [
      'demolish Cottage (pos 1) L1->L0', 'demolish Cottage (pos 3) L2->L1', 'demolish Cottage (pos 3) L1->L0']);
    assert.deepStrictEqual(levels(castle, TY.cottage), [10, 9, 8, 7, 6, 5, 4, 3]);
    assert.deepStrictEqual(plan('build c:0:8', town({ inside: many(TY.cottage, 5, 3) })).ranked, [], 'built cottages up to 8');
  });

  await t('inn:2:0 takes the inn down one level at a time, to L1', async () => {
    const castle = town({ inside: [[TY.inn, 5]] });
    const { steps } = settle('build inn:2:0', castle);
    assert.deepStrictEqual(steps.map((s) => s.label), [
      'demolish Inn (pos 0) L5->L4', 'demolish Inn (pos 0) L4->L3', 'demolish Inn (pos 0) L3->L2', 'demolish Inn (pos 0) L2->L1']);
    assert.deepStrictEqual(levels(castle, TY.inn), [1]);
  });

  await t('i:5:0 takes every iron mine at L5 or higher to L4, the lowest first', async () => {
    const castle = town({ outside: many(TY.iron, 3, [10, 3, 5]) });
    const { steps } = settle('build i:5:0', castle);
    assert.strictEqual(steps[0].label, 'demolish Ironmine (pos 1003) L5->L4');
    assert.deepStrictEqual(levels(castle, TY.iron), [4, 4, 3]);
  });

  await t('i:0:0 removes every iron mine', async () => {
    const castle = town({ outside: many(TY.iron, 3, [2, 1, 3]) });
    settle('build i:0:0', castle);
    assert.deepStrictEqual(levels(castle, TY.iron), []);
  });

  await t('never the Town Hall, never the Walls, even when a target says 0', async () => {
    const goals = [{ name: 'build', groups: [{ condition: null, when: null, targets: [
      { typeId: 31, building: 'Town Hall', level: 0, quantity: 0, raw: 'th:0:0' },
      { typeId: 32, building: 'Walls', level: 3, quantity: 0, raw: 'w:3:0' },
    ] }] }];
    const p = buildPlan({ goals, castle: town({ walls: 8 }), config: {} });
    assert.deepStrictEqual(p.ranked, []);
  });

  // ================================================================ order
  console.log('\nbuild order: lowest level first, fastest work first, targets combine\n');

  // wiki: "eight level 9 barracks, one level 8, two level 7 and one level 1 ...
  // build b:9:12 ... first upgrade the level 1 barrack to match the two at level
  // 7, then all three of those level 7 barracks to level 8, then all four of
  // the level 8 barracks to level 9"
  await t('b:9:12: the lowest barrack is raised first, as the wiki walks through it', async () => {
    const castle = town({ inside: many(TY.barracks, 12, [9, 9, 9, 9, 9, 9, 9, 9, 8, 7, 7, 1]) });
    const { steps } = settle('build b:9:12', castle);
    assert.deepStrictEqual(steps.map((s) => s.from), [1, 2, 3, 4, 5, 6, 7, 7, 7, 8, 8, 8, 8]);
    assert.deepStrictEqual(levels(castle, TY.barracks), Array(12).fill(9));
  });

  await t('b:4:15,b:9:2: all 15 to L4 before two go on to L9, and 15 in all, not 17', async () => {
    const castle = town({ inside: many(TY.barracks, 15, 1) });
    const { steps } = settle('build b:4:15,b:9:2', castle);
    assert.ok(steps.every((s) => s.kind === 'upgrade'), 'built or demolished something');
    const first = steps.findIndex((s) => s.from >= 4);
    assert.strictEqual(first, 15 * 3, 'went past L4 before every barrack reached it');
    assert.deepStrictEqual(levels(castle, TY.barracks), [9, 9, ...Array(13).fill(4)]);
  });

  await t('b:4:15,b:9:2 no longer fight: nothing is demolished to reach two', async () => {
    const p = plan('build b:4:15,b:9:2', town({ inside: many(TY.barracks, 15, 4) }));
    assert.ok(!p.ranked.some((a) => a.kind === 'demolish'), 'the old engine demolished 13 barracks here');
    assert.deepStrictEqual(p.ranked.map((a) => [a.kind, a.positionId]), [['upgrade', 0], ['upgrade', 1]]);
  });

  await t('within a line the quickest work goes first, whatever the type', async () => {
    const castle = town({ inside: [...many(TY.cottage, 2, 6), ...many(TY.barracks, 2, 2)] });
    const p = plan('build c:9:2,b:9:2', castle);
    assert.deepStrictEqual(p.ranked.map((a) => [a.def.name, a.from]), [['Barracks', 2], ['Barracks', 2], ['Cottage', 6], ['Cottage', 6]]);
  });

  await t('demolitions go first in a line: they free the plots its new buildings need', async () => {
    const castle = town({ th: 10, outside: [...many(TY.farm, 30, 9), ...many(TY.sawmill, 10, 4)] });
    const p = plan(A1, castle);
    const firstNew = p.ranked.findIndex((a) => a.kind !== 'demolish');
    assert.ok(firstNew >= 10 && p.ranked.slice(0, firstNew).every((a) => a.kind === 'demolish'));
  });

  await t('two lines never undo each other: the first-written target wins', async () => {
    const tenAt10 = () => town({ inside: many(TY.cottage, 10, 10) });
    const same = plan('build c:10:9,c:0:8', tenAt10());
    assert.strictEqual(same.ranked.filter((a) => a.kind === 'demolish').length, 1, 'kept 8 or kept 10');
    assert.match(same.note, /c:0:8 would undo c:10:9: 9 kept/);
    const nine = town({ inside: many(TY.cottage, 9, 10) });
    assert.deepStrictEqual(plan('build c:10:9\nbuild c:0:8', nine).ranked, [], 'line 2 took down what line 1 needs');
    const eight = town({ inside: many(TY.cottage, 8, 10) });
    const p = plan('build c:0:8\nbuild c:10:9', eight);
    assert.deepStrictEqual(p.ranked, [], 'line 2 built past what line 1 allows');
    assert.match(p.note, /c:10:9 would undo c:0:8: 8 kept/);
  });

  // ================================================================ lines
  console.log('\nbuild lines run in order, like troop stages\n');

  await t('the first line not yet met is worked on first', async () => {
    const castle = town({ inside: [...many(TY.cottage, 2, 8), ...many(TY.barracks, 2, 1)] });
    const p = plan('build c:10:2\nbuild b:5:2', castle);
    assert.strictEqual(p.line, 1);
    assert.match(p.note, /line 1\/2: Cottage upgrade 2 to L10/);
    const { steps } = settle('build c:10:2\nbuild b:5:2', castle);
    const lastCottage = steps.map((s) => s.typeId).lastIndexOf(TY.cottage);
    const firstBarracks = steps.findIndex((s) => s.typeId === TY.barracks);
    assert.ok(lastCottage < firstBarracks, 'a barracks went up before line 1 was done');
  });

  // wiki: the npc10 conversion. "replace each slot one by one as it opens with a
  // level 9 barrack"
  await t('a line with no free plot is skipped, and taken up again as a plot frees', async () => {
    const castle = town({ inside: FULL_INSIDE });
    const src = 'build b:9:15\nbuild c:0:9\nbuild st:0:0';
    const p = plan(src, castle);
    assert.match(p.note, /line 1\/3 waits for a plot: no free city plot for 11 more Barracks/);
    assert.deepStrictEqual(kinds([p.ranked[0]]), [['demolish', 'Cottage', 4]]);
    // bring the first cottage down (L5: five orders); the plot goes to a barrack,
    // which is raised to L9 (eight orders) before the next cottage comes down
    const steps = [];
    for (let i = 0; i < 15; i++) {
      const a = plan(src, castle).actions[0];
      steps.push(buildLabel(a));
      apply(castle, a);
    }
    assert.deepStrictEqual(steps.slice(0, 7), [
      'demolish Cottage (pos 4) L5->L4', 'demolish Cottage (pos 4) L4->L3', 'demolish Cottage (pos 4) L3->L2',
      'demolish Cottage (pos 4) L2->L1', 'demolish Cottage (pos 4) L1->L0', 'new Barracks (pos 4)',
      'upgrade Barracks (pos 4) L1->L2, goal L9']);
    assert.ok(steps.slice(6, 14).every((s) => /^upgrade Barracks \(pos 4\)/.test(s)), 'the new barrack was not raised to L9 before the next cottage');
    assert.strictEqual(steps[14], 'demolish Cottage (pos 5) L5->L4');
    assert.deepStrictEqual(levels(castle, TY.barracks), Array(5).fill(9));
  });

  await t('a one-per-city building with no plot stops the lines: "Needs space"', async () => {
    const castle = town({ inside: FULL_INSIDE });
    const p = plan('build a:1\nbuild c:10:12', castle);
    assert.deepStrictEqual(p.ranked, [], 'went on past the academy');
    assert.match(p.note, /Needs space: Academy/);
    const mid = plan('build c:6:12\nbuild a:1\nbuild b:10:4', castle);
    assert.ok(mid.ranked.length && mid.ranked.every((a) => a.def.name === 'Cottage'), 'reached the line after the academy');
    assert.match(buildOutlook({ castle, goals: goalsOf('build a:1') }).idle, /nothing to place: .*Needs space: Academy/);
  });

  await t('a one-per-city building gets a plot before buildings a city has many of', async () => {
    const castle = town({ inside: many(TY.warehouse, 29, 5) });        // plots 29-31 free
    const p = plan('build c:1:5,a:1', castle);
    assert.deepStrictEqual(p.ranked.filter((a) => a.kind === 'new').map((a) => [a.def.name, a.positionId]),
      [['Cottage', 30], ['Cottage', 31], ['Academy', 29]]);
    assert.ok(!/Needs space/.test(p.note), p.note);
    assert.match(p.note, /no free city plot for 3 more Cottage/);
  });

  await t('a line the server keeps refusing does not leave the builder idle', async () => {
    const castle = town({ inside: [...many(TY.cottage, 2, 8), ...many(TY.barracks, 2, 1)] });
    const goals = goalsOf('build c:10:2\nbuild b:5:2');
    const hold = { n: 2, until: Date.now() + 600e3, msg: 'Town Hall level too low' };
    const cityState = { failures: { 'build:upgrade:1:0': hold, 'build:upgrade:1:1': hold } };
    const o = buildOutlook({ castle, goals, cityState });
    assert.strictEqual(o.next, 'upgrade Barracks (pos 2) L1->L2, goal L5');
    assert.strictEqual(o.held.length, 2);
    const { e, sent } = engineGame(castle);
    e.goalsFor = () => parseGoals('config hero:0\nbuild c:10:2\nbuild b:5:2');
    e.state[1] = cityState;          // castle id 1: state is keyed by id
    await e.focus(castle);
    assert.deepStrictEqual(sent, [['upgrade', 2]]);
  });

  await t('the plan keeps its shape for the console', async () => {
    const p = plan('build c:10:2', town({ inside: many(TY.cottage, 2, 8) }));
    for (const k of ['actions', 'ranked', 'busy', 'note']) assert.ok(k in p, k);
    const busy = town({ inside: [[TY.cottage, 8]] });
    Object.assign(busy.buildings.find((x) => x.typeId === TY.cottage), { status: 1, endTime: Date.now() + 60e3 });
    const b = plan('build c:10:2', busy);
    assert.deepStrictEqual(b.actions, []);
    assert.match(b.note, /builder busy: building Cottage \(pos 0\) L8->L9.*next: new Cottage \(pos 1\)/);
  });

  // ================================================================ conditions
  console.log('\n?condition?: buildings, research, and the quantity form\n');

  const wallsAt = (level, status = 0) => {
    const castle = town({ walls: level, inside: [[TY.workshop, 3]], outside: many(TY.quarry, 2, 4) });
    castle.buildings.find((b) => b.typeId === TY.walls).status = status;
    return castle;
  };

  await t('?w:10?q:0:0,ws:0:0 w:10: the Walls first, the demolitions once they are L10', async () => {
    const src = 'build ?w:10?q:0:0,ws:0:0 w:10';
    const low = plan(src, wallsAt(7));
    assert.deepStrictEqual(kinds(low.ranked), [['upgrade', 'Walls', -2]]);
    assert.match(low.note, /\?w:10\? not met \(w:10: Walls L7\)/);
    const high = plan(src, wallsAt(10));
    assert.deepStrictEqual(high.ranked.map((a) => a.kind), ['demolish', 'demolish', 'demolish']);
    assert.deepStrictEqual(new Set(high.ranked.map((a) => a.def.name)), new Set(['Quarry', 'Workshop']));
  });

  await t('the suffix form q:0:0,ws:0:0?w:10? does the same', async () => {
    assert.deepStrictEqual(plan('build q:0:0,ws:0:0?w:10?', wallsAt(9)).ranked, []);
    assert.strictEqual(plan('build q:0:0,ws:0:0?w:10?', wallsAt(10)).ranked.length, 3);
  });

  await t('Walls still going up to L10 do not meet ?w:10? yet', async () => {
    assert.deepStrictEqual(plan('build ?w:10?q:0:0', wallsAt(9, 1)).ranked, []);
  });

  await t('research: ?met:10,w:10? needs both, and unknown research is not met', async () => {
    const src = 'build ?met:10,w:10?q:0:0,ws:0:0';
    const none = plan(src, wallsAt(10));
    assert.deepStrictEqual(none.ranked, [], 'demolished on unknown research');
    assert.match(none.note, /research levels unknown/);
    const nine = plan(src, wallsAt(10), { techs: { levels: { 5: 9 } } });
    assert.deepStrictEqual(nine.ranked, []);
    assert.match(nine.note, /met:10: Metal Casting is L9/);
    assert.strictEqual(plan(src, wallsAt(10), { techs: { levels: { 5: 10 } } }).ranked.length, 3);
    assert.deepStrictEqual(plan(src, wallsAt(9), { techs: { levels: { 5: 10 } } }).ranked, [], 'ran on half the condition');
  });

  await t('?i:4:0?: build sawmills only once no iron mine is L4 or higher', async () => {
    const src = 'build ?i:4:0?s:9:2';
    assert.deepStrictEqual(plan(src, town({ outside: [[TY.iron, 4], [TY.sawmill, 1]] })).ranked, []);
    const p = plan(src, town({ outside: [[TY.iron, 3], [TY.sawmill, 1]] }));
    assert.deepStrictEqual(p.ranked.map((a) => [a.kind, a.def.name]), [['new', 'Sawmill'], ['upgrade', 'Sawmill']]);
  });

  await t('st inside a condition is the Stable', async () => {
    const castle = (lv) => town({ inside: [[TY.stable, lv], [TY.cottage, 1]] });
    assert.strictEqual(plan('build ?st:10?c:2:1', castle(10)).ranked.length, 1);
    assert.deepStrictEqual(plan('build ?st:10?c:2:1', castle(9)).ranked, []);
  });

  await t('a condition only holds back its own group', async () => {
    const p = plan('build ?w:10?q:0:0 b:5:1', town({ walls: 3, inside: [[TY.barracks, 1]], outside: [[TY.quarry, 5]] }));
    assert.deepStrictEqual(kinds(p.ranked), [['upgrade', 'Barracks', 0]]);
  });

  await t('a line whose condition does not hold is skipped for the next', async () => {
    const castle = town({ walls: 3, inside: [[TY.cottage, 1]], outside: [[TY.quarry, 5]] });
    const p = plan('build ?w:10?q:0:0\nbuild c:2:1', castle);
    assert.strictEqual(p.line, 2);
    assert.match(p.note, /line 1\/2 waits: \?w:10\? not met/);
  });

  // ================================================================ config building
  console.log('\nconfig building:0 pauses construction\n');

  await t('building:0: no orders, and the note and the console say why', async () => {
    const castle = town({ inside: many(TY.cottage, 2, 8) });
    const goals = goalsOf('build c:10:2');
    const p = buildPlan({ goals, castle, config: { building: 0 } });
    assert.deepStrictEqual(p.actions, []);
    assert.match(p.note, /construction paused by config building:0/);
    assert.match(buildOutlook({ castle, goals, config: { building: 0 } }).idle, /paused by config building:0/);
    assert.strictEqual(buildPlan({ goals, castle, config: { building: 1 } }).actions.length, 2);
  });

  await t('building:0 through the engine: nothing is sent, the Walls for forts included', async () => {
    const castle = town({ walls: 0, inside: many(TY.cottage, 2, 8) });
    const { e, sent } = engineGame(castle);
    e.goalsFor = () => parseGoals('config hero:0,building:0\nbuild c:10:2\nfortification ab:100');
    const r = await e.focus(castle);
    assert.deepStrictEqual(sent, []);
    assert.match(r.build.note, /paused/);
  });

  // ================================================================ research reads
  console.log('\nresearch levels: read only when a condition asks, at most every 10 minutes\n');

  await t('a condition naming research reads the list once, then from the cache', async () => {
    const castle = wallsAt(10);
    const { e, sent, reads } = engineGame(castle, { research: research({ 5: 10 }) });
    e.goalsFor = () => parseGoals('config hero:0\nbuild ?met:10,w:10?q:0:0,ws:0:0');
    await e.focus(castle);
    await e.focus(castle);
    assert.strictEqual(reads.filter((c) => c === 'tech.getResearchList').length, 1);
    assert.strictEqual(sent.length, 2, 'one demolition a tick');
    assert.strictEqual(sent[0][0], 'demolish');
    assert.deepStrictEqual(e.state[1].techs.levels, { 5: 10 }, 'the console outlook reads the levels from the city state');
    e.state[1].techs.at = e.techLevels[1].at = Date.now() - 11 * 60e3;
    await e.focus(castle);
    assert.strictEqual(reads.filter((c) => c === 'tech.getResearchList').length, 2, 'not re-read after 10 minutes');
  });

  await t('no research in any condition: the list is never read', async () => {
    const castle = wallsAt(10);
    const { e, reads } = engineGame(castle, { research: research({ 5: 10 }) });
    e.goalsFor = () => parseGoals('config hero:0\nbuild ?w:10?q:0:0');
    await e.focus(castle);
    assert.ok(!reads.includes('tech.getResearchList'));
  });

  // Step 2's war-only pass (tick({urgent:true}) -> warPass) races an attack:
  // hiding and the gate alone, never construction or a research read.
  await t('an urgent war-only tick neither builds nor reads research; the full tick does', async () => {
    const castle = wallsAt(10);
    const { e, sent, reads } = engineGame(castle, { research: research({ 5: 10 }) });
    e.goalsFor = () => parseGoals('config hero:0\nbuild ?met:10,w:10?q:0:0,ws:0:0');
    await e.tick({ urgent: true });
    assert.deepStrictEqual(sent, []);
    assert.ok(!reads.includes('tech.getResearchList'), 'the war pass read research');
    await e.tick();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0][0], 'demolish');
    assert.ok(reads.includes('tech.getResearchList'));
  });

  await t('research too low, or the list unreadable: nothing is demolished', async () => {
    for (const reply of [research({ 5: 9 }), () => ({ ok: -1, errorMsg: 'server busy' })]) {
      const castle = wallsAt(10);
      const { e, sent } = engineGame(castle, { research: reply });
      e.goalsFor = () => parseGoals('config hero:0\nbuild ?met:10?q:0:0,ws:0:0');
      const r = await e.focus(castle);
      assert.deepStrictEqual(sent, []);
      assert.match(r.build.note, /met:10: (Metal Casting is L9|research levels unknown \(research list unreadable: server busy\))/);
    }
  });

  await t('a failed read keeps the last levels: research never goes back down', async () => {
    const castle = wallsAt(10);
    let reply = research({ 5: 10 });
    const { e } = engineGame(castle, { research: () => reply() });
    const first = await e.readTechs(castle, {});
    first.at = Date.now() - 11 * 60e3;
    reply = () => ({ ok: -1, errorMsg: 'timeout' });
    const second = await e.readTechs(castle, {});
    assert.deepStrictEqual(second.levels, { 5: 10 });
    assert.match(second.error, /timeout/);
  });

  // ================================================================ 5b: first Walls
  console.log('\nthe first Walls: castle.newBuilding at position -2\n');

  // src: BaseNewBuildingWin.onNewBuildingButtonClick sends positionId
  // BuildingConstants.POSITION_WALL (-2) for TYPE_WALL (32); NewWallBuilding asks
  // for the Walls' bean with TYPE_WALL; WallBuilding.onClick opens it when the
  // city has no Walls bean.
  await t('w:10 in a city without Walls builds them at -2, then raises them', async () => {
    const castle = town({ walls: 0 });
    const p = plan('build w:10', castle);
    assert.deepStrictEqual(kinds(p.ranked), [['new', 'Walls', -2]]);
    assert.strictEqual(buildLabel(p.ranked[0]), 'new Walls (pos -2)');
    settle('build w:10', castle);
    assert.deepStrictEqual(levels(castle, TY.walls), [10]);
  });

  await t('a fortification goal in a city without Walls builds them', async () => {
    const castle = town({ walls: 0 });
    const p = buildPlan({ goals: goalsOf('fortification ab:100'), castle, config: {} });
    assert.deepStrictEqual(kinds(p.ranked), [['new', 'Walls', -2]]);
    assert.strictEqual(buildLabel(p.ranked[0]), 'new Walls (pos -2) for fortifications');
    const both = buildPlan({ goals: goalsOf('build w:5\nfortification ab:100'), castle, config: {} }, 2);
    assert.strictEqual(both.ranked.filter((a) => a.def.name === 'Walls').length, 1, 'the Walls were ordered twice');
    assert.strictEqual(buildPlan({ goals: goalsOf('fortification ab:100'), castle: town({ walls: 1 }), config: {} }), null);
  });

  await t('through the engine: castle.newBuilding {castleId, positionId: -2, buildingType: 32}', async () => {
    const castle = town({ walls: 0 });
    const { e, sent } = engineGame(castle);
    e.goalsFor = () => parseGoals('config hero:0\nbuild w:5');
    await e.focus(castle);
    assert.deepStrictEqual(sent, [['new', -2, C.WALLS_TYPE, 1]]);
    const { Game } = require('./game');
    const g = new Game();
    let got = null;
    g.req = async (cmd, data) => { got = [cmd, data]; return { ok: 1 }; };
    await g.newBuilding(1, -2, C.WALLS_TYPE);
    assert.deepStrictEqual(got, ['castle.newBuilding', { castleId: 1, positionId: -2, buildingType: 32 }]);
  });

  await t('fortifications alone, the wall queue unreadable: the Walls still go up', async () => {
    const castle = town({ walls: 0 });
    const { e, sent } = engineGame(castle, { wallsReply: { ok: -1, errorMsg: 'no walls' } });
    e.goalsFor = () => parseGoals('config hero:0\nfortification ab:5000');
    await e.focus(castle);
    assert.deepStrictEqual(sent, [['new', -2, 32, 1]]);
  });

  // ================================================================ live goals
  console.log('\nthe live goal lines\n');

  await t('a1: sawmills, iron mines and quarries come down, the field ends as 37 L10 farms', async () => {
    const castle = town({
      inside: many(TY.cottage, 6, 7),
      outside: [...many(TY.farm, 20, 10), ...many(TY.sawmill, 8, 6), ...many(TY.iron, 6, 5), ...many(TY.quarry, 6, 4)],
    });
    const { steps } = settle(A1, castle);
    assert.deepStrictEqual(levels(castle, TY.farm), Array(37).fill(10));
    for (const typeId of [TY.sawmill, TY.iron, TY.quarry]) assert.deepStrictEqual(levels(castle, typeId), []);
    assert.deepStrictEqual(levels(castle, TY.cottage), Array(6).fill(7), 'touched a building the line does not name');
    assert.ok(!steps.some((s) => s.kind === 'demolish' && s.typeId === TY.farm));
  });

  const developed = (th = 10) => town({
    th, walls: 10,
    inside: [...many(TY.cottage, 8, 10), ...many(TY.barracks, 3, 10), [TY.academy, 10], [TY.rally, 10],
      [TY.beacon, 10], [TY.relief, 10], [TY.fh, 1]],
    outside: [...many(TY.farm, 37, 10), ...many(TY.sawmill, 3, 10)],
  });

  await t('a2: the extra cottages and barracks are no longer demolished', async () => {
    const p = buildPlan({ goals: goalsOf(A2), castle: developed(), config: {} });
    assert.ok(!p.ranked.some((a) => a.kind === 'demolish'), 'the old engine took 7 cottages and 2 barracks down here');
    assert.strictEqual(p.note, 'all build targets met');
  });

  await t('a2: line 2 goes first; the farms of line 3 follow while line 2 is held back', async () => {
    const castle = developed(9);
    for (const b of castle.buildings.filter((x) => x.typeId === TY.farm).slice(0, 3)) b.level = 8;
    const p = buildPlan({ goals: goalsOf(A2), castle, config: {} });
    assert.strictEqual(p.line, 2);
    assert.strictEqual(buildLabel(p.ranked[0]), 'upgrade Town Hall (pos -1) L9->L10');
    assert.deepStrictEqual(p.ranked.slice(1).map((a) => a.def.name), ['Farm', 'Farm', 'Farm']);
    const cityState = { failures: { 'build:upgrade:31:-1': { n: 1, until: Date.now() + 60e3, msg: 'needs a Michelangelo\'s Script' } } };
    assert.match(buildOutlook({ castle, goals: goalsOf(A2), cityState }).next, /^upgrade Farm \(pos 1001\) L8->L9/);
  });

  // ================================================================ migration
  console.log('\nmigrate-goals-build.js: dry run by default, --apply writes\n');

  const { DatabaseSync } = require('node:sqlite');
  const A2_TEXT = [
    '// Lord02',
    'config comfort:1,hero:1,troopsusepopmax:1,npc:5',
    'build fh:1',
    'build th:10,w:10,c:10:1,b:10:1,a:10:1,r:10:1,be:10:1,rs:10:1',
    'build f:10:37',
    '// build f:10:37,s:0:1,i:0:1,q:0:1',
    'troop b:5k,t:5k',
  ].join('\r\n');
  const A1_TEXT = '// Lord22 build-up\nconfig comfort:1\nbuild f:10:37,s:0:0,i:0:0,q:0:0\ntroop b:5k,t:5k\n';
  function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evony-migrate-'));
    const file = path.join(dir, 'fixture.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE goals (accountId TEXT NOT NULL DEFAULT '', cityKey TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'goal',
      src TEXT NOT NULL, savedAt INTEGER, PRIMARY KEY (accountId, cityKey, kind))`);
    const ins = db.prepare('INSERT INTO goals VALUES (?,?,?,?,?)');
    ins.run('a1', '86253479', 'goal', A1_TEXT, 1);
    ins.run('a2', '100269294', 'goal', A2_TEXT, 1);
    ins.run('a2', 'default', 'goal', 'build f:10:37', 1);
    ins.run('a2', '100269294:load1', 'script', 'build c:10:1', 1);
    ins.run('a1', 'quiet', 'goal', 'troop b:1', 1);
    db.close();
    return { dir, file };
  }
  const rowsOf = (file) => {
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT accountId, cityKey, kind, src FROM goals ORDER BY accountId, cityKey, kind').all();
    db.close();
    return rows.map((r) => ({ ...r }));
  };
  const migrate = (...args) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'migrate-goals-build.js'), ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
    return r.stdout;
  };

  await t('the dry run prints each city before and after, and writes nothing', async () => {
    const { dir, file } = fixture();
    try {
      const before = rowsOf(file);
      const out = migrate('--db', file);
      assert.match(out, /dry run on .*fixture\.db \(nothing is written; add --apply\)/);
      assert.match(out, /=== account a1 city 86253479\n {2}line 3: build f:10:37,s:0:0,i:0:0,q:0:0\n {7}-> build f:10:37,f:0:37,s:0:0,i:0:0,q:0:0/);
      assert.match(out, /-> build th:10,w:10,c:10:1,c:0:1,b:10:1,b:0:1,a:10:1,r:10:1,be:10:1,rs:10:1/);
      assert.match(out, /=== account a2 city default\n {2}line 1: build f:10:37\n {7}-> build f:10:37,f:0:37/);
      assert.match(out, /3 build lines now run one after another/);
      assert.match(out, /3 of 4 goal row\(s\) would change/);
      assert.deepStrictEqual(rowsOf(file), before, 'the dry run wrote to the database');
      assert.deepStrictEqual(fs.readdirSync(dir), ['fixture.db'], 'the dry run left a file behind');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t('--apply rewrites the build lines only, keeps a backup, and a second run changes nothing', async () => {
    const { dir, file } = fixture();
    try {
      const before = rowsOf(file);
      const out = migrate('--db', file, '--apply');
      assert.match(out, /3 row\(s\) rewritten/);
      const after = Object.fromEntries(rowsOf(file).map((r) => [`${r.accountId}/${r.cityKey}/${r.kind}`, r.src]));
      assert.strictEqual(after['a1/86253479/goal'], A1_TEXT.replace('build f:10:37,', 'build f:10:37,f:0:37,'));
      assert.strictEqual(after['a2/100269294/goal'], A2_TEXT
        .replace('c:10:1,b:10:1', 'c:10:1,c:0:1,b:10:1,b:0:1').replace('\r\nbuild f:10:37\r\n', '\r\nbuild f:10:37,f:0:37\r\n'));
      assert.ok(after['a2/100269294/goal'].includes('// build f:10:37,s:0:1,i:0:1,q:0:1'), 'a comment was rewritten');
      assert.strictEqual(after['a2/default/goal'], 'build f:10:37,f:0:37');
      assert.strictEqual(after['a2/100269294:load1/script'], 'build c:10:1', 'a script was rewritten');
      // the old rows, in json-backup/ beside the database (gitignored)
      const bdir = path.join(dir, 'json-backup');
      const backups = fs.readdirSync(bdir).filter((f) => /^goals-before-build-migration-\d+\.json$/.test(f));
      assert.strictEqual(backups.length, 1);
      const saved = JSON.parse(fs.readFileSync(path.join(bdir, backups[0]), 'utf8'));
      assert.deepStrictEqual(saved.map((r) => r.src).sort(), before.filter((r) => r.kind === 'goal' && /build/.test(r.src)).map((r) => r.src).sort());
      assert.match(migrate('--db', file, '--apply'), /0 of 4 goal row\(s\) to rewrite/);
      assert.strictEqual(fs.readdirSync(bdir).length, 1, 'a second backup for nothing');
      // the rewritten lines mean what the old engine did: exactly one cottage and one barracks
      const castle = developed();
      settle(after['a2/100269294/goal'], castle);
      assert.deepStrictEqual(levels(castle, TY.cottage), [10]);
      assert.deepStrictEqual(levels(castle, TY.barracks), [10]);
      assert.deepStrictEqual(parseGoals(after['a2/100269294/goal']).errors, []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await t('notes for what the rewrite cannot keep', async () => {
    const { migrateText } = require('./migrate-goals-build');
    const r = migrateText('build ?w:10?q:0:0\nbuild c:10\nbuild inn:2:0\nbuild f:10:*');
    assert.deepStrictEqual(r.changed, []);
    const notes = r.notes.join('\n');
    assert.match(notes, /the old engine ignored it and ran the line always/);
    assert.match(notes, /c:10: no quantity\. The old engine kept exactly one Cottage/);
    assert.match(notes, /inn:2:0: the old engine demolished every Inn; now each is only taken down to L1/);
    assert.match(notes, /f:10:\*: not a number/);
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
