'use strict';
// Step 16: the research goal (wiki: Research, TechGoals, ResearchTypes,
// Abbreviations, Build, Plan, Goal).
//
//   research lo:5,ho:5,com:4     lines run in order, one research at a time
//   research ?a:10?pr:10         a ?condition? before or after its targets
//   config research:0            pauses it; research:1 also researches what the
//                                build lines need (Step 11's research wants)
//
// Offline: fake cities made of building beans, and a stand-in server that
// answers tech.getResearchList from the city and the account as they stand
// (AvailableResearchListBean: level, avalevel, permition, upgradeing, castleId,
// conditionBean), runs one research per city, and finishes it when a test says.
// The requirements in `techRule` are made up for the tests; the real ones come
// from the server.
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// db.js opens EVONY_DB when first required: point it at a throwaway file
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evony-research-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMP, 'test.db');

const C = require('./constants');
const { Game } = require('./game');
const G = require('./goals');
const { parseGoals, describe } = G;
const RS = require('./goal-research');
const S = require('./speedups');
const { Engine, buildOutlook, buildPlan, resolvePrereqs, buildLabel } = require('./engine');
const GL = require('./goallayers');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message.split('\n').join('\n        ')); fail++; }
}
const has = (text, part) => assert.ok(String(text).includes(part), `expected to find\n  ${part}\nin\n  ${text}`);

// ---------------------------------------------------------------- the game's ids
const T = { ag: 1, lu: 2, mas: 3, mi: 4, met: 5, in: 7, ms: 8, mt: 9, ir: 10, lo: 11, com: 12, ho: 13, ar: 14,
  sp: 15, med: 16, con: 17, en: 18, mac: 19, pr: 20 };
const TY = {
  cottage: 1, barracks: 2, warehouse: 3, sawmill: 4, quarry: 5, iron: 6, farm: 7, stable: 20, inn: 21,
  forge: 22, market: 23, relief: 24, academy: 25, workshop: 26, fh: 27, embassy: 28, rally: 29, beacon: 30,
  th: 31, walls: 32,
};
const SCRIPT = 'consume.blueprint.1';          // Michelangelo's Script
const BIG = 1e9;

// ---------------------------------------------------------------- fake cities
const bean = (typeId, positionId, level, status = 0) => ({ typeId, name: C.BUILDING_BY_ID[typeId].name, positionId, level, status });
const many = (typeId, count, level) => Array.from({ length: count }, () => [typeId, level]);
// Town Hall at -1, Walls at -2, inside plots from 0 (the Academy first when
// asked for), fields from 1001
function town({ id = 1, name = 'Home', th = 10, academy = 0, inside = [], outside = [], bank = {} } = {}) {
  const b = [bean(TY.th, -1, th), bean(TY.walls, -2, 10)];
  const ins = academy ? [[TY.academy, academy], ...inside] : inside;
  ins.forEach(([typeId, level], i) => b.push(bean(typeId, i, level)));
  outside.forEach(([typeId, level], i) => b.push(bean(typeId, 1001 + i, level)));
  const amt = (k) => ({ amount: bank[k] ?? BIG });
  return {
    id, name, fieldId: 100 * 800 + 100 + id, buildings: b, troop: {}, fortification: {}, heros: [],
    resource: { food: amt('food'), wood: amt('wood'), stone: amt('stone'), iron: amt('iron'), gold: bank.gold ?? BIG,
      curPopulation: 100000, maxPopulation: 100000, workPeople: 0, buildPeople: 0 },
  };
}
const FULL_INSIDE = [...many(TY.cottage, 16, 5), ...many(TY.warehouse, 16, 5)];
const levelsOf = (castle, typeId) => castle.buildings.filter((b) => b.typeId === typeId).map((b) => b.level).sort((a, b) => b - a);
const top = (castle, typeId) => Math.max(0, ...castle.buildings.filter((b) => b.typeId === typeId && !(b.status === 0 && b.level === 0)).map((b) => b.level));

// ---------------------------------------------------------------- pure plans
// One tech's bean as tech.getResearchList sends it (AvailableResearchListBean)
const tb = (typeId, level, o = {}) => ({
  typeId, level, avalevel: o.avalevel ?? 10, permition: o.permition ?? true,
  upgradeing: !!o.upgradeing, castleId: o.castleId ?? 1, startTime: 0, endTime: o.endTime ?? 0,
  conditionBean: { food: 0, wood: 0, stone: 0, iron: 0, gold: 0, buildings: [], techs: [], items: [], ...(o.cond || {}) },
});
const listOf = (beans, extra = {}) => ({ at: Date.now(), levels: Object.fromEntries(beans.map((b) => [b.typeId, b.level])), beans, ...extra });
// every tech at a level (0 by default), with a few beans put in by hand
const allTechs = (levels = {}, o = {}) => C.TECHS.map((x) => tb(x.typeId, levels[x.typeId] || 0, o));
const withBeans = (levels, ...own) => allTechs(levels).map((b) => own.find((x) => x.typeId === b.typeId) || b);
// a stand-in game for a plan: the cities, the game's cache of what runs where
function fakeG(castles, running = {}, items = []) {
  return {
    castles, player: { items: items.map(([id, count]) => ({ id, count })) },
    castleId: (c) => Number(c.id), now: () => Date.now(),
    runningResearch: (id) => running[id] || null,
  };
}
function plan(src, { beans = allTechs({}), castle = town({ academy: 10 }), wants = [], reserve = null, running = {},
  cityState = {}, list = null, items = [], blocked = [], others = [] } = {}) {
  const parsed = parseGoals(src);
  const g = fakeG([castle, ...others], running, items);
  const ctx = { goals: parsed.goals, config: parsed.config, castle, research: list || listOf(beans),
    researchWants: wants, buildReserve: reserve, researchBuildBlocked: blocked, game: g };
  return RS.researchPlan(ctx, cityState, g);
}

// ---------------------------------------------------------------- the world
// castles: the account's cities. techs: the account's levels. techRule(techId,
// level, castle) -> what researching level -> level+1 takes: { buildings:
// [[typeId, level]], techs: [[id, level]], items: [[id, num]], food, wood,
// stone, iron, gold, permition, avalevel }. By default a city offers a tech from
// the Academy level the client's table says (RS.ACADEMY_FOR) and caps it at its
// Academy level (avalevel). rules: construction requirements as test-prereq.js
// has them ('new:<typeId>' | 'up:<typeId>:<level>').
function world(castles, { techs = {}, techRule = null, rules = {}, items = [], refuseResearch = null, troopTypes = null } = {}) {
  castles = Array.isArray(castles) ? castles : [castles];
  const reads = [], sent = [];
  const player = { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: items.map(([id, count]) => ({ id, count })) };
  const lv = { ...techs };
  const running = {};                        // castleId -> { typeId, startTime, endTime }
  const byId = (id) => castles.find((c) => Number(c.id) === Number(id));
  const ruleOf = (techId, castle) => (techRule && techRule(techId, lv[techId] || 0, castle)) || {};
  const buildRule = (key) => (typeof rules === 'function' ? rules(key) : rules[key]) || {};
  const heldOf = (id) => Game.countOf(player.items, id);
  const cond = (r, castle) => ({
    food: r.food || 0, wood: r.wood || 0, stone: r.stone || 0, iron: r.iron || 0, gold: r.gold || 0, population: r.population || 0, time: 60,
    buildings: (r.buildings || []).map(([typeId, level]) => ({ typeId, level, curLevel: top(castle, typeId), successFlag: top(castle, typeId) >= level })),
    techs: (r.techs || []).map(([id, level]) => ({ id, level, curLevel: lv[id] || 0, successFlag: (lv[id] || 0) >= level })),
    items: (r.items || []).map(([id, num]) => ({ id, num, curNum: heldOf(id), successFlag: heldOf(id) >= num })),
  });
  const runOf = (techId) => Object.entries(running).find(([, r]) => r.typeId === techId) || null;
  const beansFor = (castle) => C.TECHS.map((x) => {
    const r = ruleOf(x.typeId, castle);
    const run = runOf(x.typeId);
    return {
      typeId: x.typeId, level: lv[x.typeId] || 0,
      avalevel: r.avalevel ?? top(castle, TY.academy),
      permition: r.permition ?? top(castle, TY.academy) >= (RS.ACADEMY_FOR[x.typeId] || 1),
      upgradeing: !!run, castleId: run ? Number(run[0]) : 0,
      startTime: run ? run[1].startTime : 0, endTime: run ? run[1].endTime : 0,
      conditionBean: cond(r, castle),
    };
  });
  const at = (castle, pos) => castle.buildings.find((b) => b.positionId === pos);
  let pending = null;
  const order = (castle, o) => {
    sent.push(o);
    pending = { castle, o };
    if (o[0] === 'upgrade') {
      const b = at(castle, o[1]);
      for (const [id, num] of buildRule(`up:${b.typeId}:${b.level}`).items || []) {
        const it = player.items.find((x) => x.id === id);
        if (it) it.count -= num;
      }
    }
    return { ok: 1 };
  };
  const game = {
    castles, player,
    castleId: (c) => Number(c.id), castle: (id) => byId(id), castleXY: () => ({ x: 100, y: 100 }), now: () => Date.now(),
    lane: (_k, fn) => fn(),
    req: async (cmd, data) => {
      reads.push([cmd, data]);
      const castle = byId(data && data.castleId);
      if (cmd === 'tech.getResearchList') {
        if (game.listDown) return { ok: -1, errorMsg: game.listDown };
        return { ok: 1, academyCount: castles.filter((c) => top(c, TY.academy) > 0).length, acailableResearchBeans: beansFor(castle) };
      }
      if (cmd === 'tech.research') {
        sent.push(['research', Number(data.castleId), data.techId]);
        const refused = refuseResearch && refuseResearch(data);
        if (refused) return refused;
        if (running[data.castleId]) return { ok: -1, errorMsg: 'One academy can only conduct one research at a time.' };
        if (runOf(data.techId)) return { ok: -1, errorMsg: 'That technology is being researched.' };
        const b = beansFor(castle).find((x) => x.typeId === data.techId);
        if (!b.permition || b.level >= b.avalevel || b.level >= 10) return { ok: -1, errorMsg: 'Not allowed to research.' };
        const c = b.conditionBean;
        if (![...c.buildings, ...c.techs, ...c.items].every((x) => x.successFlag)) return { ok: -1, errorMsg: 'Conditions not met.' };
        for (const k of ['food', 'wood', 'stone', 'iron', 'gold']) {
          if (Game.bankOf(castle.resource, k) < c[k]) return { ok: -1, errorMsg: `Insufficient ${k}.` };
        }
        for (const k of ['food', 'wood', 'stone', 'iron']) castle.resource[k].amount -= c[k];
        castle.resource.gold -= c.gold;
        // an hour, or a little under its preset time when that is five minutes
        // or less (research shortens it), as the free finish expects
        const preset = S.presetSec('research', data.techId, b.level);
        const now = Date.now(), end = now + (preset ? preset * 0.8 : 3600) * 1000;
        running[data.castleId] = { typeId: data.techId, startTime: now, endTime: end };
        return { ok: 1, tech: { ...b, upgradeing: true, castleId: Number(data.castleId), startTime: now, endTime: end } };
      }
      if (cmd === 'tech.speedUpResearch') {
        sent.push(['speedUpResearch', Number(data.castleId), data.itemId]);
        const run = running[data.castleId];
        if (!run) return { ok: -1, errorMsg: 'Nothing is being researched.' };
        lv[run.typeId] = (lv[run.typeId] || 0) + 1;
        delete running[data.castleId];
        return { ok: 1, tech: { typeId: run.typeId, level: lv[run.typeId], upgradeing: false } };
      }
      if (cmd === 'castle.checkOutUpgrade') {
        const b = at(castle, data.positionId);
        return b ? { ok: 1, conditionBean: cond(buildRule(`up:${b.typeId}:${b.level}`), castle) } : { ok: -1, errorMsg: 'no building there' };
      }
      if (cmd === 'castle.getAvailableBuildingBean') {
        return { ok: 1, builingList: [{ typeId: data.typeId, conditionBean: cond(buildRule(`new:${data.typeId}`), castle) }] };
      }
      if (cmd === 'fortifications.getProduceQueue' || cmd === 'troop.getProduceQueue') return { ok: 1, allProduceQueue: [] };
      if (cmd === 'troop.getTroopProduceList') {
        return { ok: 1, troopList: (troopTypes || []).map((typeId) => ({ typeId, permition: true, conditionBean: { time: 1 } })) };
      }
      return { ok: 1 };
    },
    upgradeBuilding: async (cid, pos) => order(byId(cid), ['upgrade', pos]),
    newBuilding: async (cid, pos, type) => order(byId(cid), ['new', pos, type]),
    destructBuilding: async (cid, pos) => order(byId(cid), ['demolish', pos]),
    produceTroop: async (_cid, type, num) => { sent.push(['troop', type, num]); return { ok: 1 }; },
    produceWall: async (_cid, type, num) => { sent.push(['wall', type, num]); return { ok: 1 }; },
    promoteToChief: async () => ({ ok: 1 }),
    dischargeChief: async () => ({ ok: 1 }),
  };
  // the real bookkeeping of what runs where (game.js)
  for (const k of ['research', 'speedUpResearch', 'noteResearch', 'noteResearchList', 'runningResearch', 'applyResearchComplete']) {
    game[k] = Game.prototype[k];
  }
  const e = new Engine(game, () => {});
  e.dryRun = false;
  e.state = {};
  const goals = (src) => { e.goalsFor = () => parseGoals(`config hero:0\n${src}`); };
  // the construction placed last, finished
  const finish = () => {
    if (!pending) return false;
    const { castle, o: [kind, pos, type] } = pending;
    pending = null;
    if (kind === 'new') { castle.buildings.push(bean(type, pos, 1)); return true; }
    const b = at(castle, pos);
    b.level += kind === 'upgrade' ? 1 : -1;
    if (b.level <= 0) castle.buildings.splice(castle.buildings.indexOf(b), 1);
    return true;
  };
  // a city's research, finished, and the push the server sends for it
  const finishResearch = (cid = 1, { push = true } = {}) => {
    const run = running[cid];
    if (!run) return false;
    lv[run.typeId] = (lv[run.typeId] || 0) + 1;
    delete running[cid];
    if (push) game.applyResearchComplete({ castleId: cid });
    return true;
  };
  const state = (cid = 1) => e.state[String(cid)] || {};
  const listReads = () => reads.filter(([cmd]) => cmd === 'tech.getResearchList').length;
  const researched = () => sent.filter((s) => s[0] === 'research').map((s) => s[2]);
  const builds = () => sent.filter((s) => s[0] === 'upgrade' || s[0] === 'new' || s[0] === 'demolish');
  // focus, finish what it started, again — until two slices in a row start
  // nothing and have no requirement left to read (a want the builder records
  // one slice is researched the next)
  const settle = async (castle = castles[0], max = 200) => {
    let quiet = 0;
    for (let i = 0; i < max; i++) {
      const before = sent.length;
      const r = await e.focus(castle);
      const did = finish() | finishResearch(Number(castle.id));
      if (!did && sent.length === before && !(r.build && /checking what/.test(r.build.note))) {
        if (++quiet >= 2) return r;
      } else quiet = 0;
    }
    throw new Error('never settled');
  };
  return { game, e, sent, reads, lv, running, goals, finish, finishResearch, state, listReads, researched, builds, settle, player, castles, castle: castles[0] };
}

(async () => {
  // ================================================================ the line
  console.log('\nreading a research line (goals.js, goal-research.js)\n');

  await t('research lo:5,ho:5,com:4: three targets in the order written, and the line is blue', () => {
    const p = parseGoals('research lo:5,ho:5,com:4');
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.goals[0].targets.map((x) => [x.techId, x.name, x.level]),
      [[T.lo, 'Logistics', 5], [T.ho, 'Horseback Riding', 5], [T.com, 'Compass', 4]]);
    assert.deepStrictEqual(p.lines[0], { n: 1, status: 'ok', msg: null });
    has(describe(p).join('\n'), 'research: 1 line(s), worked on in order');
    has(describe(p).join('\n'), 'Logistics to L5, Horseback Riding to L5, Compass to L4');
  });

  await t('every NEAT code, st and sp for Stockpile, full names and startresearch words', () => {
    const codes = 'ag:1,lu:1,mas:1,mi:1,met:1,in:1,ms:1,mt:1,ir:1,lo:1,com:1,ho:1,ar:1,st:1,med:1,con:1,en:1,mac:1,pr:1';
    const p = parseGoals(`research ${codes}`);
    assert.deepStrictEqual(p.errors, []);
    assert.deepStrictEqual(p.goals[0].targets.map((x) => x.techId), [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const names = parseGoals('research horseback riding:5,Metal Casting:3,ironworking:2,iron working:4,stockpiling:4,sp:6,Military Science:2,privateering:1');
    assert.deepStrictEqual(names.errors, []);
    assert.deepStrictEqual(names.goals[0].targets.map((x) => [x.techId, x.level]),
      [[T.ho, 5], [T.met, 3], [T.ir, 2], [T.ir, 4], [T.sp, 4], [T.sp, 6], [T.ms, 2], [T.pr, 1]]);
    const words = parseGoals('research metal:1,info:1,ironwork:1,horseback:1,construct:1,engineer:1,privateer:1');
    assert.deepStrictEqual(words.goals[0].targets.map((x) => x.techId), [T.met, T.in, T.ir, T.ho, T.con, T.en, T.pr]);
  });

  await t('a ?condition? before or after its targets means the same; inside it st is the Stable and sp Stockpile', () => {
    const before = parseGoals('research ?a:10?pr:10').goals[0];
    const after = parseGoals('research pr:10?a:10?').goals[0];
    for (const g of [before, after]) {
      assert.strictEqual(g.groups.length, 1);
      assert.deepStrictEqual(g.groups[0].targets.map((x) => [x.techId, x.level]), [[T.pr, 10]]);
      assert.deepStrictEqual(g.groups[0].when.map((c) => [c.typeId, c.level]), [[TY.academy, 10]]);
    }
    const mixed = parseGoals('research ?st:5,sp:3?ho:5 st:2').goals[0];
    assert.deepStrictEqual(mixed.groups[0].when.map((c) => (c.tech ? ['tech', c.tech, c.level] : ['building', c.typeId, c.level])),
      [['building', TY.stable, 5], ['tech', T.sp, 3]]);
    assert.deepStrictEqual(mixed.groups[1], { condition: null, when: null, targets: [mixed.groups[1].targets[0]] });
    assert.strictEqual(mixed.groups[1].targets[0].techId, T.sp, 'st on the line itself is Stockpile');
    has(describe(parseGoals('research ?a:10?pr:10')).join('\n'), 'Privateering to L10 (only when a:10)');
  });

  await t('mistakes are errors on the line, never guesses', () => {
    const cases = {
      'research xx:5': 'unknown research "xx"',
      'research lo:0': 'a research level is 1 to 10',
      'research lo:11': 'a research level is 1 to 10',
      'research lo:2.5': 'level "2.5" is not a whole number',
      'research lo': 'needs research:level',
      'research lo:5k': 'level "5k" is not a whole number',
      'research ?ho:10?st:0:0': 'reads as a building target',
      'research a:10': 'a is the Academy, a building',
      research: 'needs at least one research:level',
      'research ?zz:1?lo:5': 'unknown building or research "zz"',
      'research ?a:10? lo:5': 'a ?condition? goes right before or right after its targets',
    };
    for (const [src, want] of Object.entries(cases)) {
      const p = parseGoals(src);
      assert.ok(p.errors.length, `${src}: no error`);
      has(p.errors.map((e) => e.error).join(' | '), want);
      assert.strictEqual(p.lines[0].status, 'error', src);
    }
    // what was readable on a line with a mistake still runs; a condition that
    // cannot be read never lets its targets run without it
    assert.deepStrictEqual(parseGoals('research lo:5,xx:2').goals[0].targets.map((x) => x.techId), [T.lo]);
    assert.deepStrictEqual(parseGoals('research ?zz:1?lo:5 ag:2').goals[0].targets.map((x) => x.techId), [T.ag]);
    assert.deepStrictEqual(parseGoals('research ?a:10? lo:5').goals[0].targets, []);
  });

  await t('config research:0 and :1 are read, anything else is an error, and neither is "not built yet" any more', () => {
    assert.strictEqual(parseGoals('config research:0').config.research, 0);
    assert.strictEqual(parseGoals('config research:1').config.research, 1);
    has(parseGoals('config research:2').errors[0].error, 'research is 0 (research paused) or 1');
    assert.ok(!('research' in G.NOT_IMPLEMENTED.config));
    assert.deepStrictEqual(parseGoals('config research:0').lines[0], { n: 1, status: 'ok', msg: null });
  });

  await t('research lines stack, in order, like build lines', () => {
    const p = parseGoals('research lo:5\nbuild c:1\nresearch ho:5');
    assert.deepStrictEqual(p.goals.filter((g) => g.name === 'research').map((g) => g.targets[0].techId), [T.lo, T.ho]);
    assert.deepStrictEqual(p.errors, []);
  });

  // ================================================================ the plan
  console.log('\nthe plan: the first target that can go, in line order\n');

  await t('a target below its goal, everything met and paid for: tech.research for it', () => {
    const p = plan('research lo:5', { beans: withBeans({}, tb(T.lo, 3, { cond: { food: 1000, gold: 2000 } })) });
    assert.deepStrictEqual(p.actions.map((a) => [a.kind, a.techId, a.from, a.to]), [['research', T.lo, 3, 4]]);
    assert.strictEqual(p.actions[0].label, 'research Logistics L3->L4');
    has(p.note, 'research: line 1/1: Logistics L3->L4: starting');
    assert.deepStrictEqual(p.reserve, { food: 1000, gold: 2000, label: 'research Logistics L3->L4' });
  });

  await t('targets met are passed by; the line in order; the next line waits for this one', () => {
    const beans = withBeans({ [T.lo]: 5, [T.ho]: 2 });
    const p = plan('research lo:5,ho:5,com:4\nresearch ag:1', { beans });
    assert.deepStrictEqual(p.actions.map((a) => a.techId), [T.ho]);
    has(p.note, 'Horseback Riding L2->L3: starting; Compass L0->L1: ready');
    assert.ok(!/line 2\/2/.test(p.note), p.note);
    const done = plan('research lo:5,ho:5\nresearch ag:1', { beans: withBeans({ [T.lo]: 5, [T.ho]: 5 }) });
    assert.deepStrictEqual(done.actions.map((a) => a.techId), [T.ag]);
    assert.strictEqual(done.line, 2);
    const all = plan('research lo:5\nresearch ag:1', { beans: withBeans({ [T.lo]: 5, [T.ag]: 3 }) });
    assert.deepStrictEqual(all.actions, []);
    has(all.note, 'all 2 research line(s) met');
  });

  await t('one research at a time: running here, by the list or by the game\'s cache, and nothing starts', () => {
    const now = Date.now();
    const p = plan('research lo:5,ag:1', { beans: withBeans({ [T.lo]: 3 }, tb(T.lo, 3, { upgradeing: true, castleId: 1, endTime: now + 90 * 60e3 })) });
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'researching Logistics L3->L4 here, 1h 30m left');
    has(p.note, 'Agriculture L0->L1: ready');
    assert.strictEqual(p.reserve, null, 'a research running keeps nothing in the bank');
    // started since the list was read (Game.research noted it)
    const cached = plan('research lo:5', { beans: withBeans({ [T.lo]: 3 }), running: { 1: { typeId: T.lo, level: 3, endTime: now + 60e3, seenAt: now } } });
    assert.deepStrictEqual(cached.actions, []);
    has(cached.note, 'researching Logistics L3->L4 here, 1m left');
    // something the lines do not name (a script's start, the console's)
    const other = plan('research lo:5', { beans: withBeans({ [T.lo]: 3 }), running: { 1: { typeId: T.med, level: 2, endTime: now + 60e3, seenAt: now } } });
    assert.deepStrictEqual(other.actions, []);
    has(other.note, 'researching Medicine L2->L3 here, 1m left');
  });

  await t('a tech another city is researching is not started here; the line is passed over for the next', () => {
    const now = Date.now();
    const far = town({ id: 2, name: 'Far', academy: 10 });
    const beans = withBeans({ [T.lo]: 3 }, tb(T.lo, 3, { upgradeing: true, castleId: 2, endTime: now + 3600e3 }));
    const p = plan('research lo:5\nresearch ag:1', { beans, others: [far] });
    assert.deepStrictEqual(p.actions.map((a) => a.techId), [T.ag]);
    has(p.note, 'line 1/2: Logistics L3->L4 under way in Far, 1h 0m left');
    has(p.note, 'line 1/2 passed over for now');
    // the game's cache knows a start another city made since this list was read
    const cache = plan('research lo:5', { beans: withBeans({ [T.lo]: 3 }), others: [far],
      running: { 2: { typeId: T.lo, level: 3, endTime: now + 60e3, seenAt: now } } });
    assert.deepStrictEqual(cache.actions, []);
    has(cache.note, 'under way in Far');
    // within a line, the next target goes meanwhile
    const same = plan('research lo:5,ag:1', { beans, others: [far] });
    assert.deepStrictEqual(same.actions.map((a) => a.techId), [T.ag]);
  });

  await t('a building the tech needs: handed to the builder, and the next target in the line goes meanwhile', () => {
    const castle = town({ academy: 10, inside: [[TY.stable, 3]] });
    const beans = withBeans({ [T.ho]: 4 }, tb(T.ho, 4, { cond: { buildings: [{ typeId: TY.stable, level: 5, curLevel: 3, successFlag: false }] } }));
    const p = plan('research ho:5,ag:1', { castle, beans });
    assert.deepStrictEqual(p.buildWants, [{ typeId: TY.stable, level: 5, name: 'Stable', for: 'Horseback Riding L5' }]);
    has(p.note, 'Horseback Riding L4->L5 needs Stable L5 (L3 here): the builder takes it on first');
    assert.deepStrictEqual(p.actions.map((a) => a.techId), [T.ag]);
    // raised since the list was read: the flag is as old as the read
    castle.buildings.find((b) => b.typeId === TY.stable).level = 5;
    assert.deepStrictEqual(plan('research ho:5', { castle, beans }).actions.map((a) => a.techId), [T.ho]);
    // under way: no want, and the note says so
    castle.buildings.find((b) => b.typeId === TY.stable).level = 4;
    castle.buildings.find((b) => b.typeId === TY.stable).status = 1;
    const busy = plan('research ho:5', { castle, beans });
    assert.deepStrictEqual(busy.buildWants, []);
    has(busy.note, 'needs Stable L5 (L4 here), under way');
  });

  await t('the Academy\'s cap (Lv.3/Ct.3): the Academy goes up a level first, and the note says why', () => {
    const castle = town({ academy: 3 });
    const p = plan('research lo:5', { castle, beans: withBeans({}, tb(T.lo, 3, { avalevel: 3 })) });
    assert.deepStrictEqual(p.actions, []);
    assert.deepStrictEqual(p.buildWants, [{ typeId: TY.academy, level: 4, name: 'Academy', for: 'Logistics L4' }]);
    has(p.note, 'Logistics L3->L4 needs the Academy above L3 (Logistics is at its cap here, Lv.3/Ct.3): the builder takes it on first');
    // below the cap: it goes
    assert.deepStrictEqual(plan('research lo:5', { castle, beans: withBeans({}, tb(T.lo, 2, { avalevel: 3 })) }).actions.map((a) => a.techId), [T.lo]);
  });

  await t('the game says no and names nothing: the Academy level the client offers the tech from (Machinery L9)', () => {
    const castle = town({ academy: 5 });
    const p = plan('research mac:1', { castle, beans: withBeans({}, tb(T.mac, 0, { permition: false, avalevel: 5 })) });
    assert.deepStrictEqual(p.buildWants.map((w) => [w.typeId, w.level]), [[TY.academy, 9]]);
    has(p.note, 'Machinery L0->L1 needs Academy L9 (Machinery is offered from Academy L9; L5 here)');
    // an Academy high enough and still no: it cannot go, and says so
    const high = plan('research mac:1', { castle: town({ academy: 9 }), beans: withBeans({}, tb(T.mac, 0, { permition: false, avalevel: 9 })) });
    assert.deepStrictEqual([high.actions, high.buildWants], [[], []]);
    has(high.note, 'the game does not offer Machinery L0->L1 here yet, and names nothing it lacks');
  });

  await t('a tech the target needs is researched first, a loop is noted, and so is one nested too deep', () => {
    const beans = withBeans({}, tb(T.ar, 2, { cond: { techs: [{ id: T.mt, level: 3, curLevel: 1, successFlag: false }] } }), tb(T.mt, 1));
    const p = plan('research ar:5', { beans });
    assert.deepStrictEqual(p.actions.map((a) => [a.techId, a.from]), [[T.mt, 1]]);
    has(p.note, 'Military Tradition L1->L2 first, for Archery L3: starting');
    const loop = withBeans({},
      tb(T.ar, 2, { cond: { techs: [{ id: T.mt, level: 3, successFlag: false }] } }),
      tb(T.mt, 1, { cond: { techs: [{ id: T.ar, level: 5, successFlag: false }] } }));
    const l = plan('research ar:5', { beans: loop });
    assert.deepStrictEqual(l.actions, []);
    has(l.note, 'Archery L2->L3 needs Military Tradition L3: Military Tradition L1->L2 needs Archery L5, which needs it back');
    const chain = [T.ag, T.lu, T.mas, T.mi, T.met, T.in];
    const deep = withBeans({}, ...chain.slice(0, -1).map((id, i) => tb(id, 0, { cond: { techs: [{ id: chain[i + 1], level: 1, successFlag: false }] } })));
    has(plan('research ag:1', { beans: deep }).note, 'prerequisites nest deeper than 4');
  });

  await t('short of resources: the line waits with a note, and troop and wall batches leave its cost in the bank', () => {
    const castle = town({ academy: 10, bank: { food: 50000 } });
    const beans = withBeans({}, tb(T.lo, 3, { cond: { food: 120000, gold: 5000 } }), tb(T.ag, 0, { cond: { food: 10 } }));
    const p = plan('research lo:5,ag:1', { castle, beans });
    assert.deepStrictEqual(p.actions, [], 'the cheaper target behind it went first');
    has(p.note, 'waiting for 120k food (50k held) to research Logistics L3->L4');
    has(p.note, 'troop and wall batches leave 120k food, 5,000 gold in the bank for it');
    assert.deepStrictEqual(p.reserve, { food: 120000, gold: 5000, label: 'research Logistics L3->L4' });
    // gold counts: the client checks it too (UIUtil.isResourceConditionMatch)
    const poor = plan('research lo:5', { castle: town({ academy: 10, bank: { gold: 10 } }), beans });
    has(poor.note, 'waiting for 5,000 gold (10 held)');
  });

  await t('what the builder keeps for its next order is not the research\'s to spend', () => {
    const castle = town({ academy: 10, bank: { wood: 100000 } });
    const beans = withBeans({}, tb(T.lo, 3, { cond: { wood: 50000 } }));
    const p = plan('research lo:5', { castle, beans, reserve: { wood: 80000, label: 'upgrade Cottage (pos 0) L5->L6' } });
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'waiting for 50k wood (100k held, 80k kept for the builder)');
    assert.deepStrictEqual(plan('research lo:5', { castle, beans, reserve: { wood: 40000 } }).actions.map((a) => a.techId), [T.lo]);
  });

  await t('an item the research needs and none held: noted, and the line passed over', () => {
    const beans = withBeans({}, tb(T.lo, 3, { cond: { items: [{ id: SCRIPT, num: 1, curNum: 0, successFlag: false }] } }));
    const p = plan('research lo:5\nresearch ag:1', { beans });
    has(p.note, "Logistics L3->L4 needs 1 Michelangelo's Script, none held");
    assert.deepStrictEqual(p.actions.map((a) => a.techId), [T.ag]);
    assert.deepStrictEqual(plan('research lo:5', { beans, items: [[SCRIPT, 1]] }).actions.map((a) => a.techId), [T.lo], 'the inventory beats the flag');
  });

  await t('a refused tech is backed off, and the line with it passed over until the retry', () => {
    const cityState = { failures: { 'research:11': { n: 1, until: Date.now() + 60e3, msg: 'Not allowed to research.' } } };
    const p = plan('research lo:5\nresearch ag:1', { cityState });
    has(p.note, 'Logistics L0->L1: Not allowed to research. (retry in 1m, 1 attempt(s))');
    assert.deepStrictEqual(p.actions.map((a) => a.techId), [T.ag]);
  });

  await t('config research:0 pauses: nothing starts and nothing is asked of the builder', () => {
    const p = plan('config research:0\nresearch lo:5', { castle: town({ academy: 0 }) });
    assert.deepStrictEqual([p.actions, p.buildWants, p.paused], [[], [], true]);
    assert.strictEqual(p.note, 'research: paused by config research:0');
  });

  await t('a ?condition? holds its group back, with a note; research in it is tested, st is the Stable', () => {
    const castle = town({ academy: 9 });
    const p = plan('research ?a:10?pr:10\nresearch ag:1', { castle });
    has(p.note, 'line 1/2 waits: ?a:10? not met (a:10: Academy L9)');
    assert.deepStrictEqual(p.actions.map((a) => a.techId), [T.ag], 'a line held by its condition lets the next go');
    castle.buildings.find((b) => b.typeId === TY.academy).level = 10;
    assert.deepStrictEqual(plan('research pr:10?a:10?', { castle }).actions.map((a) => a.techId), [T.pr]);
    const beans = withBeans({ [T.sp]: 2 });
    has(plan('research ?st:1,sp:3?ho:5', { castle, beans }).note, '?st:1,sp:3? not met (st:1: no Stable)');
    castle.buildings.push(bean(TY.stable, 20, 1));
    has(plan('research ?st:1,sp:3?ho:5', { castle, beans }).note, '?st:1,sp:3? not met (sp:3: Stockpile is L2)');
    assert.deepStrictEqual(plan('research ?st:1,sp:2?ho:5', { castle, beans }).actions.map((a) => a.techId), [T.ho]);
    const met = plan('research ?a:10?pr:1', { castle, beans: withBeans({ [T.pr]: 1 }) });
    has(met.note, 'all 1 research line(s) met');
  });

  await t('no list yet, or one that cannot be read: nothing is planned on a guess; an old list starts nothing', () => {
    has(plan('research lo:5', { list: { at: Date.now(), levels: null, error: 'research list unreadable: server busy' } }).note,
      'the research list is unreadable (research list unreadable: server busy)');
    const none = RS.researchPlan({ goals: parseGoals('research lo:5').goals, config: {}, castle: town({ academy: 0 }) }, {}, fakeG([town()]));
    assert.strictEqual(none.note, 'research: the research list is not read yet');
    assert.deepStrictEqual(none.buildWants, [], 'an Academy wanted on a guess');
    const old = plan('research lo:5', { list: listOf(allTechs({}), { error: 'research list unreadable: server busy' }) });
    assert.deepStrictEqual(old.actions, []);
    has(old.note, 'Logistics L0->L1: ready');
    has(old.note, 'nothing starts until the research list reads again (research list unreadable: server busy)');
  });

  await t('a level-10 building for research: the plan warns of Michelangelo\'s Scripts, as NEAT\'s wiki does', () => {
    const castle = town({ academy: 10, inside: [[TY.warehouse, 9]] });
    const beans = withBeans({ [T.sp]: 9 }, tb(T.sp, 9, { cond: { buildings: [{ typeId: TY.warehouse, level: 10, successFlag: false }] } }));
    const p = plan('research sp:10', { castle, beans });
    assert.deepStrictEqual(p.buildWants.map((w) => [w.name, w.level]), [['Warehouse', 10]]);
    has(p.note, "a level-10 building takes a Michelangelo's Script: the builder spends one if it is held and passes the upgrade over if not");
  });

  await t('what the builder cannot do for it is in the note: no plot, no script', () => {
    const p = plan('research lo:1', { castle: town({ academy: 0 }), beans: withBeans({}, tb(T.lo, 0, { permition: false, avalevel: 0 })),
      blocked: ['Needs space: Academy (research Logistics L1 needs Academy L4)'] });
    has(p.note, 'Logistics L0->L1 needs Academy L4 (Logistics is offered from Academy L4; none here): the builder takes it on first');
    has(p.note, 'the builder cannot place it now: Needs space: Academy (research Logistics L1 needs Academy L4)');
  });

  // ================================================================ build wants
  console.log('\nthe techs the build lines need (Step 11\'s research wants)\n');

  const INF_WANT = [{ techId: T.in, level: 1, have: 0, name: 'Informatics', for: 'a new Beacon Tower', at: 1 }];

  await t('no research line and no config research:1: a note only — NEAT\'s build goal builds, it does not research', () => {
    const p = plan('build be:1', { wants: INF_WANT });
    assert.deepStrictEqual(p.actions, []);
    has(p.note, 'the build lines need Informatics L1 (for a new Beacon Tower) — nothing researches it: add a research line, or config research:1');
  });

  await t('config research:1, or any research line: researched, ahead of the lines when it can start', () => {
    const one = plan('config research:1\nbuild be:1', { wants: INF_WANT });
    assert.deepStrictEqual(one.actions.map((a) => a.techId), [T.in]);
    has(one.note, 'for the build lines: Informatics L0->L1 (a new Beacon Tower needs Informatics L1): starting');
    const lines = plan('research lo:5\nbuild be:1', { wants: INF_WANT });
    assert.deepStrictEqual(lines.actions.map((a) => a.techId), [T.in]);
    has(lines.note, 'line 1/1: Logistics L0->L1: ready');
    // one that cannot start never holds the lines up
    const short = plan('research lo:5', { wants: INF_WANT, beans: withBeans({}, tb(T.in, 0, { cond: { food: 1e12 } })) });
    assert.deepStrictEqual(short.actions.map((a) => a.techId), [T.lo]);
    // met since the want was made: nothing more
    assert.deepStrictEqual(plan('config research:1', { wants: INF_WANT, beans: withBeans({ [T.in]: 1 }) }).actions, []);
  });

  // ================================================================ reads
  console.log('\nreading the research list: only when a decision is due\n');

  await t('readEvery: a target open, only a research ?condition? waiting, or nothing at all to read for', () => {
    const castle = town({ academy: 10 });
    const ctx = (src) => ({ goals: parseGoals(src).goals, castle });
    const list = listOf(allTechs({ [T.lo]: 5, [T.sp]: 1 }));
    assert.strictEqual(RS.readEvery(ctx('research lo:6'), list), RS.RESEARCH_TTL);
    assert.strictEqual(RS.readEvery(ctx('research lo:5'), list), null);
    assert.strictEqual(RS.readEvery(ctx('research ?sp:3?pr:1'), list), RS.COND_TTL, 'another city may meet it');
    assert.strictEqual(RS.readEvery(ctx('research ?a:10?pr:1'), listOf(allTechs({})), { }), RS.RESEARCH_TTL);
    assert.strictEqual(RS.readEvery(ctx('research ?st:1?pr:1'), list), null, 'a building condition needs no read');
    assert.strictEqual(RS.readEvery(ctx('research lo:5'), list, { researchWants: INF_WANT }), RS.RESEARCH_TTL);
  });

  await t('the list is due at once when a building its answer hangs on has gone up since the read', () => {
    const castle = town({ academy: 3, inside: [[TY.cottage, 1], [TY.stable, 2]] });
    const ctx = (src) => ({ goals: parseGoals(src).goals, castle });
    const beans = withBeans({ [T.lo]: 3, [T.ho]: 1 }, tb(T.ho, 1, { cond: { buildings: [{ typeId: TY.stable, level: 3, successFlag: false }] } }));
    const list = listOf(beans, { tops: RS.topsOf(castle) });
    assert.deepStrictEqual([RS.topsOf(castle)[TY.academy], RS.topsOf(castle)[TY.stable]], [3, 2]);
    assert.strictEqual(RS.readEvery(ctx('research lo:6'), list), RS.RESEARCH_TTL);
    castle.buildings.find((b) => b.typeId === TY.cottage).level = 5;
    assert.strictEqual(RS.readEvery(ctx('research lo:6'), list), RS.RESEARCH_TTL, 'a cottage has nothing to do with it');
    castle.buildings.find((b) => b.typeId === TY.stable).level = 3;
    assert.strictEqual(RS.readEvery(ctx('research lo:6'), list), 0, 'the Stable a bean said was short');
    castle.buildings.find((b) => b.typeId === TY.stable).level = 2;
    castle.buildings.find((b) => b.typeId === TY.academy).level = 4;
    assert.strictEqual(RS.readEvery(ctx('research lo:6'), list), 0, 'the Academy');
    assert.strictEqual(RS.readEvery(ctx('research lo:3'), list), null, 'every target met: no read for it');
  });

  await t('listNeeded: a research line, or research:1 with a want; never under research:0', () => {
    const need = (src, cs = {}) => RS.listNeeded(parseGoals(src), cs);
    assert.deepStrictEqual([need('research lo:1'), need('build c:1'), need('config research:1'), need('config research:1', { researchWants: INF_WANT }),
      need('config research:0\nresearch lo:1'), need('build c:1', { researchWants: INF_WANT })], [true, false, false, true, false, false]);
  });

  // ================================================================ engine
  console.log('\nthrough the engine (focus)\n');

  await t('a city researches its line to the goal, one at a time, and the Academy goes up for the cap', async () => {
    const castle = town({ academy: 1, inside: [[TY.cottage, 1]] });
    const w = world(castle);
    w.goals('research ag:3');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.researched(), [T.ag]);
    has(r.research.note, 'Agriculture L0->L1: starting');
    assert.ok(r.acted.includes('research Agriculture L0->L1 -> ok'), r.acted.join(' | '));
    const again = await w.e.focus(castle);
    assert.deepStrictEqual(w.researched(), [T.ag], 'a second research while one runs');
    has(again.research.note, 'researching Agriculture L0->L1 here, 1h 0m left');
    w.finishResearch();
    const capped = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', 0]], 'the Academy was not raised for the cap');
    has(capped.build.note, 'for the research goal first: upgrade Academy (pos 0) L1->L2 for research Agriculture L2 (it needs Academy L2)');
    has(capped.research.note, 'Agriculture L1->L2 needs the Academy above L1 (Agriculture is at its cap here, Lv.1/Ct.1): the builder takes it on first');
    w.finish();
    const last = await w.settle();
    assert.deepStrictEqual(w.researched(), [T.ag, T.ag, T.ag]);
    assert.deepStrictEqual([w.lv[T.ag], levelsOf(castle, TY.academy)], [3, [3]]);
    has(last.research.note, 'all 1 research line(s) met');
    assert.deepStrictEqual(w.state().failures || {}, {}, 'something went on the backoff ladder');
  });

  await t('lines run in order: the second starts once the first is met', async () => {
    const w = world(town({ academy: 10 }), { techs: { [T.lo]: 4 } });
    w.goals('research lo:5\nresearch ho:2,ag:1');
    await w.settle();
    assert.deepStrictEqual(w.researched(), [T.lo, T.ho, T.ho, T.ag]);
  });

  await t('the list is read only when a decision is due: not while research runs, once when it ends, not once all is met', async () => {
    const w = world(town({ academy: 10 }));
    w.goals('research lo:2');
    await w.e.focus(w.castle);
    assert.strictEqual(w.listReads(), 1);
    for (let i = 0; i < 5; i++) await w.e.focus(w.castle);
    assert.strictEqual(w.listReads(), 1, 'read while the research ran');
    w.finishResearch();                                   // server.ResearchCompleteUpdate
    await w.e.focus(w.castle);
    assert.strictEqual(w.listReads(), 2);
    assert.deepStrictEqual(w.researched(), [T.lo, T.lo]);
    w.finishResearch();
    await w.e.focus(w.castle);
    assert.strictEqual(w.listReads(), 3, 'the end of the last one is read once');
    for (let i = 0; i < 5; i++) await w.e.focus(w.castle);
    assert.strictEqual(w.listReads(), 3, 'read again with every target met');
    // no push: the end time passing says the same
    const q = world(town({ academy: 10 }));
    q.goals('research lo:2');
    await q.e.focus(q.castle);
    q.finishResearch(1, { push: false });
    q.game.noteResearch(1, { typeId: T.lo, level: 0, upgradeing: true, endTime: Date.now() - 1000 });
    await q.e.focus(q.castle);
    assert.strictEqual(q.listReads(), 2);
    assert.deepStrictEqual(q.researched(), [T.lo, T.lo]);
  });

  await t('a research a script started here: the city waits for it, and reads the list the moment it ends', async () => {
    const castle = town({ academy: 10, bank: { food: 0 } });
    const w = world(castle, { techRule: (id) => (id === T.ag ? { food: 5000 } : null) });
    w.goals('research ag:1');
    await w.e.focus(castle);
    assert.deepStrictEqual([w.listReads(), w.researched()], [1, []]);
    await w.game.research(1, T.lo);                        // the script's `research logistics`
    castle.resource.food.amount = 10000;
    const r = await w.e.focus(castle);
    assert.deepStrictEqual([w.listReads(), w.researched()], [1, [T.lo]]);
    has(r.research.note, 'researching Logistics L0->L1 here, 1h 0m left');
    w.finishResearch();
    await w.e.focus(castle);
    assert.deepStrictEqual([w.listReads(), w.researched()], [2, [T.lo, T.ag]]);
  });

  await t('a start goes on a list read within the minute: an older one is read again first', async () => {
    const w = world(town({ academy: 10, bank: { food: 0 } }), { techRule: (id) => (id === T.lo ? { food: 5000 } : null) });
    w.goals('research lo:2');
    await w.e.focus(w.castle);
    assert.deepStrictEqual([w.listReads(), w.researched()], [1, []], 'started with no food');
    w.e.techLevels[1].at -= 2 * 60e3;                     // the list is two minutes old
    w.castle.resource.food.amount = 10000;                 // server.ResourceUpdate
    w.lv[T.lo] = 2;                                        // another city finished it meanwhile
    const r = await w.e.focus(w.castle);
    assert.deepStrictEqual([w.listReads(), w.researched()], [2, []], 'researched one past the goal on an old list');
    has(r.research.note, 'all 1 research line(s) met');
    // and one that cannot be read again starts nothing
    const d = world(town({ academy: 10 }));
    d.goals('research lo:2');
    await d.e.focus(d.castle);
    d.finishResearch();
    d.game.listDown = 'server busy';
    d.e.techLevels[1].at -= 2 * 60e3;
    const stale = await d.e.focus(d.castle);
    assert.deepStrictEqual(d.researched(), [T.lo]);
    has(stale.research.note, 'nothing starts until the research list reads again (research list unreadable: server busy)');
  });

  await t('a list that cannot be read is not asked for every slice: once per interval, as a good one', async () => {
    const w = world(town({ academy: 10 }));
    w.goals('research lo:2');
    w.game.listDown = 'server busy';
    const r = await w.e.focus(w.castle);
    has(r.research.note, 'the research list is unreadable (research list unreadable: server busy)');
    for (let i = 0; i < 4; i++) await w.e.focus(w.castle);
    assert.deepStrictEqual([w.listReads(), w.researched()], [1, []]);
    w.game.listDown = null;
    w.e.techLevels[1].at -= RS.RESEARCH_TTL;
    await w.e.focus(w.castle);
    assert.deepStrictEqual([w.listReads(), w.researched()], [2, [T.lo]]);
  });

  await t('a tech another city researches is left to it, and this city takes the next', async () => {
    const home = town({ academy: 10 });
    const far = town({ id: 2, name: 'Far', academy: 10 });
    const w = world([home, far]);
    w.goals('research lo:5,ag:1');
    await w.e.focus(far);                                  // Far starts Logistics
    assert.deepStrictEqual(w.researched(), [T.lo]);
    const r = await w.e.focus(home);
    assert.deepStrictEqual(w.sent.filter((s) => s[0] === 'research'), [['research', 2, T.lo], ['research', 1, T.ag]]);
    has(r.research.note, 'Logistics L0->L1 under way in Far');
  });

  await t('the buildings research needs come before the build lines ("with priority")', async () => {
    const castle = town({ academy: 3, inside: [[TY.cottage, 1]] });
    const w = world(castle, { techs: { [T.lo]: 3 } });
    w.goals('build c:5\nresearch lo:4');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', 0]], 'the cottage went before the Academy');
    has(r.build.note, 'for the research goal first: upgrade Academy (pos 0) L3->L4 for research Logistics L4 (it needs Academy L4)');
    w.finish();
    await w.e.focus(castle);
    assert.deepStrictEqual(w.researched(), [T.lo]);
    assert.deepStrictEqual(w.builds(), [['upgrade', 0], ['upgrade', 1]], 'the cottage came next');
  });

  await t('no build lines at all: the Academy is still built, on a free plot', async () => {
    const castle = town({ academy: 0, inside: [[TY.cottage, 1]] });
    const w = world(castle);
    w.goals('research ag:1');
    await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['new', 1, TY.academy]]);
    w.finish();
    await w.e.focus(castle);
    assert.deepStrictEqual(w.researched(), [T.ag]);
  });

  await t('a building research needs has its own prerequisites met first (Step 11\'s resolver)', async () => {
    const castle = town({ th: 3, academy: 3 });
    const w = world(castle, { techs: { [T.lo]: 3 }, rules: { 'up:25:3': { buildings: [[TY.th, 4]] } } });
    w.goals('research lo:4');
    const r = await w.e.focus(castle);                 // the Academy's needs read, then the Town Hall's
    assert.deepStrictEqual(w.builds(), [['upgrade', -1]]);
    has(r.build.note, 'prerequisite first: upgrade Town Hall (pos -1) L3->L4');
    w.finish();
    await w.settle();
    assert.deepStrictEqual(w.builds(), [['upgrade', -1], ['upgrade', 0]]);
    assert.deepStrictEqual(w.researched(), [T.lo]);
  });

  await t('no plot for the Academy: "Needs space: Academy" in both notes, and the build lines go on', async () => {
    const castle = town({ inside: [...FULL_INSIDE] });
    const w = world(castle);
    w.goals('build c:6:1\nresearch ag:1');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', 0]], 'the build lines stopped');
    has(r.build.note, 'for the research goal, not now: Needs space: Academy (research Agriculture L1 needs Academy L1)');
    has(r.research.note, 'the builder cannot place it now: Needs space: Academy');
    assert.deepStrictEqual(w.researched(), []);
  });

  await t('a level-10 building for research: no script held, passed over; one held, it is spent', async () => {
    const castle = town({ academy: 10, inside: [[TY.warehouse, 9]] });
    const rule = (id, level) => (id === T.sp && level === 9 ? { buildings: [[TY.warehouse, 10]] } : null);
    const w = world(castle, { techs: { [T.sp]: 9 }, techRule: rule, rules: { 'up:3:9': { items: [[SCRIPT, 1]] } } });
    w.goals('research sp:10');
    await w.e.focus(castle);
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), []);
    has(r.build.note, "for the research goal, not now: upgrade Warehouse (pos 1) L9->L10 for research Stockpile L10 (it needs Warehouse L10): needs 1 Michelangelo's Script, none held");
    has(r.research.note, "a level-10 building takes a Michelangelo's Script");
    assert.deepStrictEqual(w.state().failures || {}, {});
    const held = world(town({ academy: 10, inside: [[TY.warehouse, 9]] }), { techs: { [T.sp]: 9 }, techRule: rule,
      rules: { 'up:3:9': { items: [[SCRIPT, 1]] } }, items: [[SCRIPT, 1]] });
    held.goals('research sp:10');
    const h = await held.e.focus(held.castle);
    assert.deepStrictEqual(held.builds(), [['upgrade', 1]]);
    has(h.build.note, "spends 1 Michelangelo's Script (1 held)");
    held.finish();
    await held.e.focus(held.castle);
    assert.deepStrictEqual(held.researched(), [T.sp]);
  });

  await t('a building the build lines take down is not built for research', async () => {
    const castle = town({ academy: 0, inside: [[TY.cottage, 1]] });
    const w = world(castle);
    w.goals('build a:0:0,c:2\nresearch ag:1');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['upgrade', 0]]);
    has(r.build.note, 'research Agriculture L1 needs Academy L1, which the build lines take down');
  });

  await t('config building:0: the research building waits, and both notes say so', async () => {
    const w = world(town({ academy: 1 }), { techs: { [T.ag]: 1 } });
    w.goals('config building:0\nresearch ag:2');
    const r = await w.e.focus(w.castle);
    assert.deepStrictEqual([w.builds(), w.researched()], [[], []]);
    has(r.research.note, 'construction is paused by config building:0, so Academy L2 waits');
    assert.strictEqual(r.build.note, 'build: construction paused by config building:0');
  });

  await t('config research:0 with research lines: nothing read, nothing started, and the plan says it is paused', async () => {
    const w = world(town({ academy: 10 }));
    w.goals('config research:0\nresearch lo:5');
    const r = await w.e.focus(w.castle);
    assert.deepStrictEqual([w.listReads(), w.researched()], [0, []]);
    assert.strictEqual(r.research.note, 'research: paused by config research:0');
  });

  await t('a construction and a research in the same slice share the bank: each keeps what the other takes', async () => {
    const castle = town({ academy: 10, inside: [[TY.cottage, 5]], bank: { wood: 100000 } });
    const w = world(castle, { techRule: (id) => (id === T.lo ? { wood: 50000 } : null), rules: { 'up:1:5': { wood: 80000 } } });
    w.goals('build c:6\nresearch lo:1');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual([w.builds(), w.researched()], [[['upgrade', 1]], []]);
    has(r.research.note, 'waiting for 50k wood (100k held, 80k kept for the builder) to research Logistics L0->L1');
  });

  await t('troop batches leave the research\'s cost in the bank, as they leave the builder\'s', async () => {
    const castle = town({ academy: 10, inside: [[TY.barracks, 10]], bank: { wood: 50000 } });
    const w = world(castle, { techRule: (id) => (id === T.lo ? { wood: 120000 } : null), troopTypes: [11] });
    w.goals('troop b:1000\nresearch lo:1');
    const r = await w.e.focus(castle);
    assert.deepStrictEqual(w.sent, [], 'the batch spent the wood the research waits for');
    has(r.troop.note, 'leaving 120k wood in the bank for research Logistics L0->L1');
    const rich = world(town({ academy: 10, inside: [[TY.barracks, 10]], bank: { wood: 200000 } }),
      { techRule: (id) => (id === T.lo ? { wood: 120000 } : null), troopTypes: [11] });
    rich.goals('troop b:1000\nresearch lo:1');
    await rich.e.focus(rich.castle);
    assert.deepStrictEqual(rich.sent, [['troop', 11, 26], ['research', 1, T.lo]], '(200k - 120k) / 3k ballista');
  });

  await t('the upkeep, market and push goals find the research\'s cost kept with the builder\'s (ctx.buildReserve)', async () => {
    const castle = town({ academy: 10, inside: [[TY.cottage, 5]], bank: { wood: 100000, gold: 1000 } });
    const w = world(castle, { techRule: (id) => (id === T.lo ? { gold: 50000, food: 1000 } : null), rules: { 'up:1:5': { wood: 80000 } } });
    w.goals('build c:6\nresearch lo:1');
    const seen = {};
    const probe = (name) => (ctx) => { seen[name] = ctx.buildReserve; return null; };
    const mods = { upkeep: require('./goal-upkeep'), trade: require('./goal-trade'), transfer: require('./goal-transfer') };
    for (const [name, m] of Object.entries(mods)) m.plans.__probe = probe(name);
    try { await w.e.focus(castle); } finally { for (const m of Object.values(mods)) delete m.plans.__probe; }
    const both = { label: 'upgrade Cottage (pos 1) L5->L6 and research Logistics L0->L1', food: 1000, wood: 80000, gold: 50000 };
    assert.deepStrictEqual(seen, { upkeep: both, trade: both, transfer: both });
  });

  await t('research has its own slot: three troop batches, a construction and a research in one slice', async () => {
    const castle = town({ academy: 10, inside: [[TY.barracks, 10], [TY.cottage, 1]] });
    const w = world(castle, { troopTypes: [3, 4, 5] });
    w.goals('troop w:100,s:100,p:100\nbuild c:2\nresearch lo:1');
    await w.e.focus(castle);
    assert.strictEqual(w.sent.filter((s) => s[0] === 'troop').length, 3);
    assert.deepStrictEqual([w.builds(), w.researched()], [[['upgrade', 2]], [T.lo]]);
  });

  await t('a refusal backs that tech off, the list is read again, and the next target goes', async () => {
    const w = world(town({ academy: 10 }), { refuseResearch: (d) => (d.techId === T.lo ? { ok: -1, errorMsg: 'Something went wrong.' } : null) });
    w.goals('research lo:1\nresearch ag:1');
    await w.e.focus(w.castle);
    assert.deepStrictEqual(w.researched(), [T.lo]);
    assert.ok(w.state().failures['research:11'], 'no backoff');
    const r = await w.e.focus(w.castle);
    assert.strictEqual(w.listReads(), 2, 'the list was not read again after the refusal');
    assert.deepStrictEqual(w.researched(), [T.lo, T.ag]);
    has(r.research.note, 'Logistics L0->L1: Something went wrong. (retry in 1m, 1 attempt(s))');
  });

  await t('the build lines\' research with config research:1: researched, then the building goes up', async () => {
    const castle = town({ academy: 3, inside: [[TY.cottage, 1]] });
    const w = world(castle, { rules: { 'new:30': { techs: [[T.in, 1]] } } });
    w.goals('config research:1\nbuild be:1');
    const first = await w.e.focus(castle);
    assert.deepStrictEqual([w.builds(), w.researched(), w.listReads()], [[], [], 0]);
    has(first.build.note, 'needs research Informatics L1 (a research goal will pick this up)');
    const second = await w.e.focus(castle);
    assert.deepStrictEqual(w.researched(), [T.in]);
    has(second.research.note, 'for the build lines: Informatics L0->L1 (a new Beacon Tower needs Informatics L1): starting');
    // Informatics 1 takes 300 s: the free finish (Step 7) ends it at once
    assert.ok(w.sent.some((s) => s[0] === 'speedUpResearch'), 'no free finish');
    await w.e.focus(castle);
    assert.deepStrictEqual(w.builds(), [['new', 2, TY.beacon]]);
  });

  await t('the build lines\' research needs the Academy raised: with config research:1 the builder does that too', async () => {
    const castle = town({ academy: 1, inside: [[TY.cottage, 1]] });
    const w = world(castle, { rules: { 'new:30': { techs: [[T.in, 1]] } } });
    w.goals('config research:1\nbuild be:1');
    await w.settle();
    assert.deepStrictEqual(levelsOf(castle, TY.academy), [3], 'Informatics is offered from Academy L3');
    assert.deepStrictEqual(w.researched(), [T.in]);
    assert.deepStrictEqual(levelsOf(castle, TY.beacon), [1]);
  });

  await t('without research:1 or a research line: the note, and no list read at all', async () => {
    const castle = town({ academy: 3, inside: [[TY.cottage, 1]] });
    const w = world(castle, { rules: { 'new:30': { techs: [[T.in, 1]] } } });
    w.goals('build be:1');
    await w.e.focus(castle);
    const r = await w.e.focus(castle);
    assert.deepStrictEqual([w.researched(), w.listReads()], [[], 0]);
    has(r.research.note, 'nothing researches it: add a research line, or config research:1');
  });

  await t('a dry run reads and plans, and starts nothing', async () => {
    const w = world(town({ academy: 10 }));
    w.goals('research lo:1');
    w.e.dryRun = true;
    const r = await w.e.focus(w.castle);
    assert.deepStrictEqual(w.researched(), []);
    assert.ok(r.acted.includes('[plan] research Logistics L0->L1'), r.acted.join(' | '));
  });

  await t('the research list read for the research goal serves a build line\'s ?condition? too: one read', async () => {
    const castle = town({ academy: 10, outside: [[TY.quarry, 1]] });
    const w = world(castle, { techs: { [T.met]: 10 } });
    w.goals('build ?met:10?q:0:0\nresearch lo:1');
    await w.e.focus(castle);
    assert.strictEqual(w.listReads(), 1);
    assert.deepStrictEqual(w.builds(), [['demolish', 1001]]);
  });

  await t('the console\'s Buildings tab names the research goal\'s building next', async () => {
    const castle = town({ academy: 1 });
    const w = world(castle, { techs: { [T.ag]: 1 } });
    w.goals('research ag:2');
    w.e.dryRun = true;
    await w.e.focus(castle);
    const parsed = parseGoals('research ag:2');
    const o = buildOutlook({ castle, goals: parsed.goals, config: parsed.config, cityState: w.state() });
    assert.strictEqual(o.next, 'upgrade Academy (pos 0) L1->L2 for research Agriculture L2 (it needs Academy L2)');
    assert.strictEqual(o.idle, null);
    assert.deepStrictEqual(w.state().researchBuildWants, [{ typeId: TY.academy, level: 2, name: 'Academy', for: 'Agriculture L2' }]);
  });

  await t('resolvePrereqs is pure: the research goal\'s building comes before the plan\'s orders', () => {
    const castle = town({ academy: 1, inside: [[TY.cottage, 1]] });
    const p = buildPlan({ goals: parseGoals('build c:2').goals, castle, config: {}, researchBuildWants: [{ typeId: TY.academy, level: 2, for: 'Agriculture L2' }] });
    const r = resolvePrereqs({ plan: p, castle, conds: () => ({ at: Date.now(), cond: {} }), forResearch: [{ typeId: TY.academy, level: 2, for: 'Agriculture L2' }] });
    assert.strictEqual(buildLabel(r.pick), 'upgrade Academy (pos 0) L1->L2 for research Agriculture L2 (it needs Academy L2)');
    const none = buildPlan({ goals: [], castle, config: {} });
    assert.strictEqual(none, null, 'no build lines and nothing for research is still no plan');
  });

  // ================================================================ game.js
  console.log('\nwhat runs where (game.js)\n');

  await t('server.ResearchCompleteUpdate: nothing runs in that city any more', async () => {
    const g = new Game();
    g.now = () => Date.now();
    g.noteResearch(1, { typeId: T.lo, level: 3, upgradeing: true, endTime: Date.now() + 60e3 });
    g.noteResearch(2, { typeId: T.ag, level: 1, upgradeing: true, endTime: Date.now() + 60e3 });
    g.applyResearchComplete({ castleId: 1 });
    assert.strictEqual(g.runningResearch(1), null);
    assert.strictEqual(g.runningResearch(2).typeId, T.ag, 'the other city\'s was cleared too');
    g.applyResearchComplete(null);
    g.applyResearchComplete({});
    assert.strictEqual(g.runningResearch(2).typeId, T.ag);
  });

  // ================================================================ scripts
  console.log('\nresearch lines from a script (goallayers.js)\n');

  await t('a script\'s research line (goal research ar:4,ms:5) is taken and runs', async () => {
    const acct = 'acct-research';
    const r = GL.addScriptLine(acct, 1, 'research ar:4,ms:5');
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.layer.src, 'research ar:4,ms:5');
    const w = world(town({ academy: 10 }));
    w.e.goalsFor = () => GL.parseLayered({ city: 'config hero:0', script: GL.getScriptLayer(acct, 1) });
    await w.e.focus(w.castle);
    assert.deepStrictEqual(w.researched(), [T.ar]);
    GL.clearScriptLayer(acct, 1);
  });

  await t('techgoals, NEAT\'s older form, is read as a research line; research lines stack', () => {
    const acct = 'acct-techgoals';
    let r = GL.addScriptLine(acct, 2, 'techgoals ar:10,ho:10,mt:9');
    assert.deepStrictEqual(r.errors, []);
    r = GL.addScriptLine(acct, 2, 'research lo:5');
    assert.strictEqual(r.layer.src, 'research ar:10,ho:10,mt:9\nresearch lo:5');
    const set = GL.setScriptLayer(acct, 3, 'config npc:0\ntechgoals lo:2');
    assert.deepStrictEqual(set.errors, []);
    assert.strictEqual(GL.getScriptLayer(acct, 3).src, 'config npc:0\nresearch lo:2');
    // a goal line with a mistake is kept, as a troop line is (Step 10), and the
    // error names its place in the layer
    const bad = GL.addScriptLine(acct, 2, 'research zz:1');
    has(bad.errors[0].error, 'unknown research "zz"');
    assert.strictEqual(bad.errors[0].where, 'script line 3');
    assert.strictEqual(GL.addScriptLine(acct, 2, 'techgoal lo:1').errors[0].where, 'script, not added');
    GL.clearScriptLayer(acct, 2);
    GL.clearScriptLayer(acct, 3);
  });

  // ================================================================ live goals
  console.log('\nthe live goals (live-goals.txt)\n');

  const A1 = `// Lord22 build-up
config comfort:1,hero:1,troopsusepopmax:1
comfortpolicy 15 16 popraise
defensepolicy /usetruce:79 /usespeech:2 /junktroop:5000 /usewarhorn:1 /usecorselet:1 /usepenicillin:1
build f:10:37,s:0:0,i:0:0,q:0:0
troop b:5k,t:5k
troop wo:10k,w:10k,s:10k,p:10k,sw:10k,a:10k,t:10k,c:10k,cata:10k,b:10k
troop a:100k,s:100k
fortification ab:5000`;
  const A2_BUILD = 'build fh:1\nbuild th:10,w:10,c:10:1,b:10:1,a:10:1,r:10:1,be:10:1,rs:10:1\nbuild f:10:37';

  await t('a1 and a2 have no research line: the research goal reads nothing, plans nothing, starts nothing', async () => {
    // a2's config npc:5 has NPC farming check its research (Step 15,
    // Engine.accountTechs): that one read is its, and the research goal adds none
    for (const [src, reads] of [[A1, 0], [`config comfort:1,hero:1,troopsusepopmax:1,npc:5\n${A2_BUILD}`, 1]]) {
      const p = parseGoals(src);
      assert.ok(!p.goals.some((g) => g.name === 'research'));
      assert.ok(!p.lines.some((l) => l.status === 'error' && /research/i.test(l.msg || '')));
      const w = world(town({ th: 9, academy: 10, outside: many(TY.farm, 37, 9) }));
      w.e.goalsFor = () => parseGoals(src);
      const r = await w.e.focus(w.castle);
      await w.e.focus(w.castle);
      assert.strictEqual(w.listReads(), reads);
      assert.strictEqual(r.research, undefined);
      assert.deepStrictEqual(w.researched(), []);
    }
  });

  await t('one list read serves the research goal and NPC farming\'s research check alike', async () => {
    const w = world(town({ academy: 10 }), { techs: { [T.mt]: 7 } });
    w.e.goalsFor = () => parseGoals('config hero:0,npc:5\nresearch mt:9');
    await w.e.focus(w.castle);
    assert.strictEqual(w.listReads(), 1);
    assert.deepStrictEqual(w.researched(), [T.mt]);
    // and the other way round: a fresh reading for NPC farming is what the research goal starts on
    const n = world([town({ academy: 10 }), town({ id: 2, name: 'Far', academy: 10 })]);
    n.e.goalsFor = (id) => parseGoals(Number(id) === 2 ? 'config hero:0,npc:5' : 'config hero:0\nresearch lo:1');
    await n.e.focus(n.castles[1]);
    assert.strictEqual(n.listReads(), 1);
    await n.e.focus(n.castles[0]);
    assert.deepStrictEqual([n.listReads(), n.researched()], [2, [T.lo]], 'each city reads its own list for its research');
  });

  await t('a2\'s Beacon Tower that needs research: the research plan only says so', async () => {
    // every a2 build target met but the Beacon Tower, which (made up) needs Informatics 1
    const castle = town({ th: 10, academy: 10, inside: [[TY.fh, 1], [TY.cottage, 10], [TY.barracks, 10], [TY.rally, 10], [TY.relief, 10]],
      outside: many(TY.farm, 37, 10) });
    const w = world(castle, { rules: { 'new:30': { techs: [[T.in, 1]] } } });
    w.e.goalsFor = () => parseGoals(`config hero:0\n${A2_BUILD}`);
    const r = await w.e.focus(castle);
    assert.deepStrictEqual([w.builds(), w.researched(), w.listReads()], [[], [], 0]);
    has(r.build.note, 'passed over: new Beacon Tower (pos 6): needs research Informatics L1 (a research goal will pick this up)');
    has(r.research.note, 'the build lines need Informatics L1 (for a new Beacon Tower) — nothing researches it');
    await w.e.focus(castle);
    assert.strictEqual(w.listReads(), 0);
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
