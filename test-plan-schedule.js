'use strict';
// Step 19: the plan goal, schedulepolicy and processingpolicy — the last of
// NEAT's general goals — and NEAT's obsolete goals read as what replaced them
// (wiki: Plan, SchedulePolicy, ProcessingPolicy, Obsolete, CapturedFireLimit).
//
//   plan c:4:9,i:4:40,b:4:14,mi:4      buildings and research, finished before the next line
//   schedulepolicy 06:00 12:00 ...     the city acts only in these hours; defence always
//   processingpolicy n:10 m:20 *:5     which march task goes first, by points
//   ballsused / npc10* / npcexcludelist / noabandonflats / capturedfirelimit
//
// Offline: fake cities made of building beans and a stand-in server (the one
// test-research.js uses) that answers the research list and construction
// requirements, runs one research per city and finishes work when a test says.
// No network, no login; the database is a throwaway file.
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// db.js opens EVONY_DB when first required: point it at a throwaway file
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evony-plan-'));
if (!process.env.EVONY_DB) process.env.EVONY_DB = path.join(TMP, 'test.db');

const C = require('./constants');
const { Game } = require('./game');
const G = require('./goals');
const { parseGoals, describe } = G;
const RS = require('./goal-research');
const PL = require('./goal-plan');
const P = require('./processing');
const W = require('./goal-war');
const NPC = require('./goal-npc');
const B = require('./goal-buildnpc');
const TR = require('./goal-transfer');
const H = require('./goal-heroes');
const V = require('./goal-valley');
const { Engine, buildOutlook, buildPlan } = require('./engine');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok    ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + String(e && e.message).split('\n').join('\n        ')); fail++; }
}
const section = (s) => console.log(`\n${s}\n`);
const has = (text, part) => assert.ok(String(text).includes(part), `expected to find\n  ${part}\nin\n  ${text}`);
const hasNot = (text, part) => assert.ok(!String(text).includes(part), `did not expect\n  ${part}\nin\n  ${text}`);
const eq = assert.deepStrictEqual;

// ---------------------------------------------------------------- the game's ids
const T = { ag: 1, lu: 2, mas: 3, mi: 4, met: 5, in: 7, ms: 8, mt: 9, ir: 10, lo: 11, com: 12, ho: 13, ar: 14,
  sp: 15, med: 16, con: 17, en: 18, mac: 19, pr: 20 };
const TY = {
  cottage: 1, barracks: 2, warehouse: 3, sawmill: 4, quarry: 5, iron: 6, farm: 7, stable: 20, inn: 21,
  forge: 22, market: 23, relief: 24, academy: 25, workshop: 26, fh: 27, embassy: 28, rally: 29, beacon: 30,
  th: 31, walls: 32,
};
const BIG = 1e9;
const MIN = 60000;

// The clock: schedulepolicy and processingpolicy windows are this machine's
// clock, read through game.now(), so the fixture times are local times.
const at = (h, m = 0) => new Date(2026, 8, 14, h, m, 0).getTime();

// ---------------------------------------------------------------- fake cities
const bean = (typeId, positionId, level, status = 0) => ({ typeId, name: C.BUILDING_BY_ID[typeId].name, positionId, level, status });
// Town Hall at -1, Walls at -2, inside plots from 0 (the Academy first when
// asked for), fields from 1001
let nextCity = 1;
function town({ id = nextCity++, name = `City${id}`, th = 10, academy = 0, inside = [], outside = [], bank = {} } = {}) {
  const b = [bean(TY.th, -1, th), bean(TY.walls, -2, 10)];
  const ins = academy ? [[TY.academy, academy], ...inside] : inside;
  ins.forEach(([typeId, level], i) => b.push(bean(typeId, i, level)));
  outside.forEach(([typeId, level], i) => b.push(bean(typeId, 1001 + i, level)));
  const amt = (k) => ({ amount: bank[k] ?? BIG });
  return {
    id, castleId: id, name, fieldId: 100 * 800 + 100 + id, buildings: b, troop: {}, fortification: {}, heros: [],
    resource: { food: amt('food'), wood: amt('wood'), stone: amt('stone'), iron: amt('iron'), gold: bank.gold ?? BIG,
      curPopulation: 100000, maxPopulation: 100000, workPeople: 0, buildPeople: 0, support: 100 },
  };
}
const levelsOf = (castle, typeId) => castle.buildings.filter((b) => b.typeId === typeId).map((b) => b.level).sort((a, b) => b - a);
const top = (castle, typeId) => Math.max(0, ...castle.buildings.filter((b) => b.typeId === typeId && !(b.status === 0 && b.level === 0)).map((b) => b.level));

// ---------------------------------------------------------------- the world
// The stand-in server of test-research.js: the account's techs, a research list
// per city (level, avalevel, permition, upgradeing, castleId, conditionBean),
// one research per city, construction that finishes when finish() says, and a
// few more commands the schedule tests need (defence items, the gate, recalls).
//   clock    () -> game.now(), local time
//   enemy    () -> the account's hostile armies (player.enemyArmys)
//   self     our own marches (player.selfArmys)
function world(castles, { techs = {}, rules = {}, items = [], clock = null, enemy = null, self = [] } = {}) {
  castles = Array.isArray(castles) ? castles : [castles];
  const reads = [], sent = [], lines = [];
  const player = { playerInfo: { userName: 'T' }, selfArmys: self, enemyArmys: [], items: items.map(([id, count]) => ({ id, count })) };
  if (enemy) Object.defineProperty(player, 'enemyArmys', { get: enemy });
  const lv = { ...techs };
  const running = {};                        // castleId -> { typeId, startTime, endTime }
  const byId = (id) => castles.find((c) => Number(c.id) === Number(id));
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
    const run = runOf(x.typeId);
    return {
      typeId: x.typeId, level: lv[x.typeId] || 0,
      avalevel: top(castle, TY.academy),
      permition: top(castle, TY.academy) >= (RS.ACADEMY_FOR[x.typeId] || 1),
      upgradeing: !!run, castleId: run ? Number(run[0]) : 0,
      startTime: run ? run[1].startTime : 0, endTime: run ? run[1].endTime : 0,
      conditionBean: cond({}, castle),
    };
  });
  const atPos = (castle, pos) => castle.buildings.find((b) => b.positionId === pos);
  let pending = null;
  const order = (castle, o) => { sent.push(o); pending = { castle, o }; return { ok: 1 }; };
  const game = {
    castles, player,
    castleId: (c) => Number(c.id), castle: (id) => byId(id), castleXY: (c) => C.fieldIdToCoords(c.fieldId),
    now: () => (clock ? clock() : Date.now()),
    lane: (_k, fn) => fn(),
    req: async (cmd, data) => {
      reads.push([cmd, data]);
      const castle = byId(data && data.castleId);
      if (cmd === 'tech.getResearchList') return { ok: 1, academyCount: 1, acailableResearchBeans: beansFor(castle) };
      if (cmd === 'tech.research') {
        sent.push(['research', Number(data.castleId), data.techId]);
        if (running[data.castleId]) return { ok: -1, errorMsg: 'One academy can only conduct one research at a time.' };
        const b = beansFor(castle).find((x) => x.typeId === data.techId);
        if (!b.permition || b.level >= b.avalevel || b.level >= 10) return { ok: -1, errorMsg: 'Not allowed to research.' };
        const now = Date.now(), end = now + 3600 * 1000;
        running[data.castleId] = { typeId: data.techId, startTime: now, endTime: end };
        return { ok: 1, tech: { ...b, upgradeing: true, castleId: Number(data.castleId), startTime: now, endTime: end } };
      }
      if (cmd === 'castle.checkOutUpgrade') {
        const b = atPos(castle, data.positionId);
        return b ? { ok: 1, conditionBean: cond(buildRule(`up:${b.typeId}:${b.level}`), castle) } : { ok: -1, errorMsg: 'no building there' };
      }
      if (cmd === 'castle.getAvailableBuildingBean') {
        return { ok: 1, builingList: [{ typeId: data.typeId, conditionBean: cond(buildRule(`new:${data.typeId}`), castle) }] };
      }
      if (cmd === 'fortifications.getProduceQueue' || cmd === 'troop.getProduceQueue') return { ok: 1, allProduceQueue: [] };
      if (cmd === 'troop.getTroopProduceList') return { ok: 1, troopList: [] };
      return { ok: 1 };
    },
    upgradeBuilding: async (cid, pos) => order(byId(cid), ['upgrade', pos]),
    newBuilding: async (cid, pos, type) => order(byId(cid), ['new', pos, type]),
    destructBuilding: async (cid, pos) => order(byId(cid), ['demolish', pos]),
    produceTroop: async (_cid, type, num) => { sent.push(['troop', type, num]); return { ok: 1 }; },
    produceWall: async (_cid, type, num) => { sent.push(['wall', type, num]); return { ok: 1 }; },
    useDefenceItem: async (cid, itemId) => { sent.push(['item', Number(cid), itemId]); return { ok: 1 }; },
    promoteToChief: async () => ({ ok: 1 }),
    dischargeChief: async (cid) => { sent.push(['discharge', Number(cid)]); return { ok: 1 }; },
    buildArmyBean: (o) => o,
    newArmy: async (cid, b) => { sent.push(['march', Number(cid), b]); return { ok: 1 }; },
  };
  // the real bookkeeping of what runs where (game.js)
  for (const k of ['research', 'noteResearch', 'noteResearchList', 'runningResearch', 'applyResearchComplete']) {
    game[k] = Game.prototype[k];
  }
  const e = new Engine(game, (m) => lines.push(String(m)));
  e.dryRun = false;
  e.state = {};
  const goals = (src) => { e.goalsFor = () => parseGoals(`config hero:0\n${src}`); };
  // the construction placed last, finished
  const finish = () => {
    if (!pending) return false;
    const { castle, o: [kind, pos, type] } = pending;
    pending = null;
    if (kind === 'new') { castle.buildings.push(bean(type, pos, 1)); return true; }
    const b = atPos(castle, pos);
    b.level += kind === 'upgrade' ? 1 : -1;
    if (b.level <= 0) castle.buildings.splice(castle.buildings.indexOf(b), 1);
    return true;
  };
  const finishResearch = (cid = castles[0].id) => {
    const run = running[cid];
    if (!run) return false;
    lv[run.typeId] = (lv[run.typeId] || 0) + 1;
    delete running[cid];
    game.applyResearchComplete({ castleId: cid });
    return true;
  };
  const researched = () => sent.filter((s) => s[0] === 'research').map((s) => s[2]);
  const builds = () => sent.filter((s) => s[0] === 'upgrade' || s[0] === 'new' || s[0] === 'demolish');
  const listReads = () => reads.filter(([cmd]) => cmd === 'tech.getResearchList').length;
  // focus, finish what it started, again — until two slices in a row start
  // nothing and have nothing left to read
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
  return { game, e, sent, reads, lines, lv, running, goals, finish, finishResearch, researched, builds, listReads, settle, player, castle: castles[0] };
}
const indexOf = (list, pred) => list.findIndex(pred);
const lastIndexOf = (list, pred) => { for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i; return -1; };

(async () => {
  // ================================================================ plan: the line
  section('plan: reading the line (goals.js, goal-plan.js)');

  await t('plan c:4:9,i:4:40,b:4:14,mi:4 — the wiki\'s line: three building targets and one research, blue', () => {
    const p = parseGoals('plan c:4:9,i:4:40,b:4:14,mi:4');
    eq(p.errors, []);
    const g = p.goals[0];
    eq(g.buildings.map((x) => [x.typeId, x.level, x.quantity]), [[TY.cottage, 4, 9], [TY.iron, 4, 40], [TY.barracks, 4, 14]]);
    eq(g.research.map((x) => [x.techId, x.level]), [[T.mi, 4]]);
    eq(p.lines[0], { n: 1, status: 'ok', msg: null });
    const d = describe(parseGoals('plan c:4:9,i:4:40,b:4:14,mi:4\nplan ar:8,mt:7,ho:5')).join('\n');
    has(d, 'plan: 2 line(s), each finished — buildings and research — before the next begins');
    has(d, '1. 9 x Cottage to L4, 40 x Ironmine to L4, 14 x Barracks to L4, Mining to L4');
    has(d, '2. Archery to L8, Military Tradition to L7, Horseback Riding to L5');
  });

  await t('on a plan line st is the Stable and sp Stockpile (wiki Plan); full names work; spaces separate too', () => {
    const g = parseGoals('plan st:1,sp:2').goals[0];
    eq([g.buildings.map((x) => x.typeId), g.research.map((x) => x.techId)], [[TY.stable], [T.sp]]);
    const names = parseGoals('plan stable:2 stockpile:3,stockpiling:4 horseback riding:5 iron mine:4:2 t:5 th:6').goals[0];
    eq(names.buildings.map((x) => [x.typeId, x.level, x.quantity]), [[TY.stable, 2, 1], [TY.iron, 4, 2], [TY.th, 5, 1], [TY.th, 6, 1]]);
    eq(names.research.map((x) => [x.techId, x.level]), [[T.sp, 3], [T.sp, 4], [T.ho, 5]]);
    // every research code the research line takes, but st
    const codes = 'ag:1,lu:1,mas:1,mi:1,met:1,in:1,ms:1,mt:1,ir:1,lo:1,com:1,ho:1,ar:1,sp:1,med:1,con:1,en:1,mac:1,pr:1';
    eq(parseGoals(`plan ${codes}`).goals[0].research.map((x) => x.techId), [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    // and every building code
    const bcodes = 'a:1,b:1,be:1,c:1,e:1,fh:1,fo:1,f:1,s:1,q:1,i:1,inn:1,rs:1,m:1,st:1,ws:1,w:1,wh:1,r:1,t:1';
    eq(parseGoals(`plan ${bcodes}`).goals[0].buildings.length, 20);
    eq(parseGoals(`plan ${bcodes}`).errors, []);
  });

  await t('mistakes are errors on the line, never guesses; what reads still runs', () => {
    const cases = {
      'plan xx:4': 'unknown building or research "xx"',
      'plan mi:4:2': 'Mining is research, which takes research:level — no quantity',
      'plan mi:11': 'a research level is 1 to 10',
      'plan mi:0': 'a research level is 1 to 10',
      'plan c:11': 'buildings go to level 10 at most',
      'plan c:x:2': 'level "x" is not a whole number',
      'plan t:0:0': 'never demolishes or takes down the Town Hall',
      'plan a:10:3': 'a city has one Academy, so this reads as quantity 1',
      plan: 'needs at least one building or research target',
      'plan ?w:10?q:0:0': 'a plan line takes no ?condition?',
      'plan c:4:9 q:0:0?w:10?': 'a plan line takes no ?condition?',
    };
    for (const [src, want] of Object.entries(cases)) {
      const p = parseGoals(src);
      assert.ok(p.errors.length, `${src}: no error`);
      has(p.errors.map((e) => e.error).join(' | '), want);
      assert.strictEqual(p.lines[0].status, 'error', src);
    }
    eq(parseGoals('plan c:4:9,xx:2,mi:3').goals[0].targets.map((x) => x.raw), ['c:4:9', 'mi:3']);
    // a line with a ?condition? is left out whole: no conditional demolition runs without it
    eq(parseGoals('plan c:4:9 ?w:10?q:0:0').goals[0].targets, []);
  });

  await t('config plan:0 and :1 are read, anything else is red; plan is off the NOT_IMPLEMENTED table', () => {
    eq(parseGoals('config plan:0').config.plan, 0);
    eq(parseGoals('config plan:1').lines[0], { n: 1, status: 'ok', msg: null });
    has(parseGoals('config plan:2').errors[0].error, 'plan is 0 (plan lines paused) or 1');
    has(parseGoals('config plan:on').errors[0].error, 'plan is 0 (plan lines paused) or 1');
    assert.ok(!('plan' in G.NOT_IMPLEMENTED.config));
    assert.ok(!('plan' in G.NOT_IMPLEMENTED.goals));
  });

  // ============================================================= plan: progress
  section('plan: which line is in work (goal-plan.js progress / expand)');

  const planOf = (src, castle, levels = null, config = {}) => {
    const p = parseGoals(src);
    return PL.expand({ goals: p.goals, config: { ...p.config, ...config } }, castle, levels);
  };

  await t('the first line not finished is in work; its buildings and research say what is left', () => {
    const c = town({ academy: 10, inside: [[TY.cottage, 4], [TY.cottage, 4], [TY.cottage, 2]] });
    const x = planOf('plan c:4:3,mi:2\nplan ag:1', c, { [T.mi]: 1 });
    eq(x.plan.current, 1);
    has(x.plan.note, 'plan: line 1/2 in work — buildings: Cottage 2/3 at L4; research: Mining L2 (L1 now)');
    has(x.plan.note, 'line 2 begins once all of it is finished');
  });

  await t('a building still going up is not finished: it counts once it stands at its level', () => {
    const c = town({ academy: 10, inside: [[TY.cottage, 4], [TY.cottage, 3]] });
    c.buildings.find((b) => b.level === 3).status = 1;            // L3 -> L4 under way
    eq(planOf('plan c:4:2\nplan ag:1', c, {}).plan.current, 1);
    c.buildings.forEach((b) => { if (b.typeId === TY.cottage) { b.level = 4; b.status = 0; } });
    eq(planOf('plan c:4:2\nplan ag:1', c, {}).plan.current, 2);
  });

  await t('research never read is not finished; read at its level, it is', () => {
    const c = town({ academy: 10 });
    const unread = planOf('plan mi:1\nplan ag:1', c, null);
    eq(unread.plan.current, 1);
    has(unread.plan.note, 'Mining L1 (research levels not read yet)');
    eq(planOf('plan mi:1\nplan ag:1', c, { [T.mi]: 1 }).plan.current, 2);
    eq(planOf('plan mi:1\nplan ag:1', c, { [T.mi]: 3, [T.ag]: 1 }).plan, { total: 2, current: null, paused: false, note: 'plan: all 2 line(s) finished' });
  });

  await t('expand: the finished lines and the one in work become build lines ahead of the city\'s own; its research a research line', () => {
    const c = town({ academy: 10, inside: [[TY.cottage, 2]] });
    const src = 'plan c:2:1,mi:1\nplan c:3:1,ag:1\nplan c:4:1,lu:1\nbuild f:1:1\nresearch ar:1';
    const x = planOf(src, c, { [T.mi]: 1 });
    eq(x.goals.map((g) => [g.name, g.plan || null, g.tag || null]), [
      ['build', 1, 'plan line 1/3'], ['build', 2, 'plan line 2/3'], ['research', 2, 'plan line 2/3'],
      ['plan', null, null], ['plan', null, null], ['plan', null, null], ['build', null, null], ['research', null, null]]);
    eq(x.goals[2].targets.map((r) => r.techId), [T.ag]);
    eq(x.plan.current, 2);
    // no plan lines: the goals are left as they are
    const none = parseGoals('build f:1:1').goals;
    assert.strictEqual(PL.expand({ goals: none, config: {} }, c, null).goals, none);
  });

  await t('with every line finished all the plan\'s buildings stay build lines (a building lost later is raised again), no research line', () => {
    const c = town({ academy: 10, inside: [[TY.cottage, 3]] });
    const x = planOf('plan c:2:1,mi:1\nplan c:3:1', c, { [T.mi]: 1 });
    eq(x.plan.current, null);
    eq(x.goals.filter((g) => g.plan).map((g) => [g.name, g.plan]), [['build', 1], ['build', 2]]);
    // the cottage lost (down to L1): line 1 is back in work, line 2 waits again
    c.buildings.find((b) => b.typeId === TY.cottage).level = 1;
    eq(planOf('plan c:2:1,mi:1\nplan c:3:1', c, { [T.mi]: 1 }).plan.current, 1);
  });

  await t('config plan:0: the plan lines are paused, the goals are left as they are, the note says so', () => {
    const c = town({ academy: 10 });
    const p = parseGoals('config plan:0\nplan c:2:1\nplan ag:1\nbuild f:1:1');
    const x = PL.expand(p, c, null);
    assert.strictEqual(x.goals, p.goals);
    eq(x.plan, { total: 2, current: null, paused: true, note: 'plan: 2 line(s) paused by config plan:0' });
  });

  await t('building:0 or research:0 keeps the line from finishing, and the note says why', () => {
    const c = town({ academy: 10 });
    has(planOf('plan c:2:1', c, {}, { building: 0 }).plan.note, 'construction is paused by config building:0, so it cannot finish');
    has(planOf('plan mi:1', c, {}, { research: 0 }).plan.note, 'research is paused by config research:0, so it cannot finish');
  });

  await t('a later line never undoes an earlier one: the builder keeps the first line\'s buildings and says so', () => {
    const c = town({ academy: 10, inside: [[TY.cottage, 4], [TY.cottage, 4], [TY.cottage, 4]] });
    const p = parseGoals('plan c:4:3\nplan c:0:1');
    const x = PL.expand(p, c, {});
    eq(x.plan.current, null, 'line 2 reads as met: its cap is held at the first line\'s 3');
    const b = buildPlan({ castle: c, goals: x.goals, config: {} });
    eq(b.ranked, []);
    has(b.note, 'c:0:1 would undo c:4:3: 3 kept');
  });

  // =============================================================== plan: engine
  section('plan: the engine works its line with the builder and the research goal');

  await t('plan lines finish in order: line 2\'s research starts only once line 1\'s cottages AND Mining are done', async () => {
    const castle = town({ academy: 10, inside: [[TY.cottage, 1]] });
    const w = world(castle);
    w.goals('plan c:2:2,mi:1\nplan ag:1');
    const r = await w.settle();
    eq(levelsOf(castle, TY.cottage), [2, 2]);
    eq([w.lv[T.mi], w.lv[T.ag]], [1, 1]);
    const iAg = indexOf(w.sent, (s) => s[0] === 'research' && s[2] === T.ag);
    const iMi = indexOf(w.sent, (s) => s[0] === 'research' && s[2] === T.mi);
    const lastBuild = lastIndexOf(w.sent, (s) => s[0] === 'upgrade' || s[0] === 'new');
    assert.ok(iMi >= 0 && iAg > iMi && iAg > lastBuild, `Agriculture went at ${iAg}, before line 1 was done (Mining ${iMi}, last build ${lastBuild})`);
    eq(r.plan.note, 'plan: all 2 line(s) finished');
  });

  await t('the plan\'s notes: the build and research notes name the plan line, the plan note what is left', async () => {
    const castle = town({ academy: 10, inside: [[TY.cottage, 1]] });
    const w = world(castle);
    w.goals('plan c:2:1,mi:1\nplan ag:1\nbuild f:1:1');
    const r = await w.e.focus(castle);
    has(r.build.note, 'plan line 1/2:');
    has(r.research.note, 'plan line 1/2:');
    has(r.plan.note, 'plan: line 1/2 in work — buildings: Cottage 0/1 at L2; research: Mining L1');
    // the build line is "line 1/1", not counted with the plan's
    w.finish();
    const r2 = await w.e.focus(castle);
    has(r2.build.note, 'line 1/1:');
    hasNot(r2.build.note, 'line 2/2');
  });

  await t('side by side: while line 1\'s research runs the builder goes on with the build lines; line 2 waits', async () => {
    const castle = town({ academy: 10, inside: [[TY.cottage, 1]] });
    const w = world(castle);
    w.goals('plan c:2:1,mi:3\nplan c:3:1\nbuild f:1:1');
    await w.e.focus(castle);                             // cottage L1->L2, Mining L0->L1 starts
    eq(w.builds().map((s) => s.slice(0, 2)), [['upgrade', 1]]);
    eq(w.researched(), [T.mi]);
    w.finish();                                          // the cottage stands at L2; Mining still runs
    await w.e.focus(castle);
    eq(w.builds().slice(-1)[0][0], 'new', 'the farm of the build line goes now');
    eq(w.builds().slice(-1)[0][2], TY.farm);
    w.finish();
    w.finishResearch();                                  // Mining 1: line 1 still wants Mining 3
    await w.e.focus(castle);
    eq(w.researched(), [T.mi, T.mi]);
    assert.ok(!w.builds().some((s) => s[0] === 'upgrade' && s[1] === 1 && w.builds().indexOf(s) > 0), 'no cottage L3 while line 1 is open');
    w.finishResearch(); await w.e.focus(castle); w.finishResearch();    // Mining 3
    // this slice's research list read shows Mining 3; the next slice begins line 2
    await w.e.focus(castle);
    eq(w.builds().slice(-1)[0][0], 'new', 'nothing of line 2 before the engine has read Mining 3');
    const r = await w.e.focus(castle);                   // line 1 finished: line 2's cottage L2->L3
    eq(w.builds().slice(-1)[0].slice(0, 2), ['upgrade', 1]);
    eq(levelsOf(castle, TY.cottage), [2]);
    has(r.plan.note, 'plan: line 2/2 in work');
  });

  await t('side by side: the plan\'s research goes before the research lines, one research at a time', async () => {
    const castle = town({ academy: 10 });
    const w = world(castle);
    w.goals('research ag:1\nplan mi:1');
    await w.settle();
    eq(w.researched(), [T.mi, T.ag]);
  });

  await t('sp and st on a plan line in the engine: a Stable is built and Stockpile researched', async () => {
    const castle = town({ academy: 10 });
    const w = world(castle);
    w.goals('plan st:1,sp:1');
    await w.settle();
    eq(top(castle, TY.stable), 1);
    eq(w.lv[T.sp], 1);
  });

  await t('the plan\'s research gets its buildings the research goal\'s way: no Academy, so one is built first', async () => {
    const castle = town({ academy: 0 });
    const w = world(castle);
    w.goals('plan ms:1');
    await w.settle();
    eq(top(castle, TY.academy), 1);
    eq(w.lv[T.ms], 1);
    const iAcademy = indexOf(w.sent, (s) => s[0] === 'new' && s[2] === TY.academy);
    const iMs = indexOf(w.sent, (s) => s[0] === 'research' && s[2] === T.ms);
    assert.ok(iAcademy >= 0 && iMs > iAcademy);
  });

  await t('config plan:0: no plan work, no research list read; the build lines run as before', async () => {
    const castle = town({ academy: 10, inside: [[TY.cottage, 1]] });
    const w = world(castle);
    w.goals('config plan:0\nplan c:2:1,mi:1\nbuild f:1:1');
    const r = await w.e.focus(castle);
    eq(w.builds().map((s) => [s[0], s[2]]), [['new', TY.farm]]);
    eq(w.listReads(), 0);
    eq(r.plan.note, 'plan: 1 line(s) paused by config plan:0');
  });

  await t('a city with plan lines researches what its buildings need, as one with a research line does', () => {
    const p = parseGoals('plan c:9:1');
    const wants = { researchWants: [{ techId: T.con, level: 1 }] };
    assert.ok(RS.listNeeded(p, wants));
    assert.ok(!RS.listNeeded(parseGoals('plan c:9:1\nconfig plan:0'), wants));
    assert.ok(!RS.listNeeded(parseGoals('build c:9:1'), wants));
  });

  await t('the console\'s Buildings tab shows what the plan line has the builder do next', () => {
    const castle = town({ academy: 10, inside: [[TY.cottage, 1]] });
    const o = buildOutlook({ castle, goals: parseGoals('plan c:3:1\nbuild f:1:1').goals, config: {} });
    has(o.next, 'upgrade Cottage (pos 1) L1->L2, goal L3');
    has(o.note, 'plan line 1/1:');
  });

  // ============================================================== schedulepolicy
  section('schedulepolicy: the hours a city acts in (processing.js, engine.js offHours)');

  await t('start/end pairs, several windows, one past midnight; mistakes are red; a later line replaces an earlier one', () => {
    const p = parseGoals('schedulepolicy 06:00 12:00 17:00 23:00');
    eq(p.errors, []);
    eq(p.goals[0].windows.map((x) => x.text), ['06:00-12:00', '17:00-23:00']);
    eq(parseGoals('schedulepolicy 22:00 02:00').goals[0].windows.map((x) => x.text), ['22:00-02:00']);
    eq(parseGoals('schedulepolicy 00:00 24:00').errors, []);
    for (const [src, want] of [['schedulepolicy 06:00', 'pairs'], ['schedulepolicy 6 12', 'not a time'],
      ['schedulepolicy 06:00 25:00', 'not a time'], ['schedulepolicy 06:00 06:00', 'same time'], ['schedulepolicy', 'expected: schedulepolicy']]) {
      has(parseGoals(src).errors.map((e) => e.error).join(' | '), want);
      eq(parseGoals(src).lines[0].status, 'error');
    }
    const two = parseGoals('schedulepolicy 06:00 12:00\nschedulepolicy 08:00 10:00');
    eq(two.goals.filter((g) => g.name === 'schedulepolicy').map((g) => g.windows[0].text), ['08:00-10:00']);
    eq(two.lines.map((l) => l.status), ['error', 'ok']);
    has(describe(p).join('\n'), 'schedulepolicy: goals act only during 06:00-12:00, 17:00-23:00 on this machine\'s clock; defence');
    // wartownpolicy reads its hours the same way, and its messages stand
    has(W.parsers.wartownpolicy.parse(['06:00']).errors[0], 'pairs');
    has(W.parsers.wartownpolicy.parse([]).errors[0], 'expected: wartownpolicy');
  });

  await t('in and out of the hours, the next window named; a window past midnight holds at 23:30 and 01:00, not 03:00', () => {
    const goals = parseGoals('schedulepolicy 06:00 12:00 17:00 23:00').goals;
    const s = (h, m) => P.scheduleAt(goals, at(h, m));
    eq([s(6, 0).on, s(11, 59).on, s(12, 0).on, s(16, 59).on, s(17, 0).on, s(23, 0).on, s(3, 0).on], [true, true, false, false, true, false, false]);
    has(s(8, 0).note, 'schedulepolicy: acting until 12:00 (hours 06:00-12:00, 17:00-23:00)');
    has(s(13, 0).note, 'until 17:00');
    has(s(23, 30).note, 'until 06:00');
    has(s(13, 0).note, 'only defence acts (hiding, the gate, defence items, the war town recall, warrules, the embassy)');
    const night = parseGoals('schedulepolicy 22:00 02:00').goals;
    eq([P.scheduleAt(night, at(23, 30)).on, P.scheduleAt(night, at(1, 0)).on, P.scheduleAt(night, at(3, 0)).on], [true, true, false]);
    eq(P.scheduleAt(parseGoals('build c:1').goals, at(3)), null, 'no line: no schedule');
  });

  const wave = (castle, now, inMs = 5 * MIN) => ({
    armyId: 900, direction: 1, missionType: C.MISSION.attack, king: 'Raider', startPosName: '1,1',
    targetFieldId: castle.fieldId, reachTime: now + inMs, troop: { archer: '200000' },
  });

  await t('outside the hours nothing but defence acts: no construction or research; the defence item and the gate still go', async () => {
    let NOW = at(3);
    const castle = town({ academy: 10, inside: [[TY.cottage, 1]] });
    castle.goOutForBattle = true;                     // the gate is open
    const w = world(castle, { clock: () => NOW, enemy: () => [wave(castle, NOW)], items: [[C.DEFENSE_ITEMS.warhorn, 2]] });
    w.goals('schedulepolicy 06:00 12:00\nbuild c:2:1\nresearch ag:1\nconfig gate:10\ndefensepolicy /usewarhorn:1');
    const r = await w.e.focus(castle);
    eq(w.builds(), []);
    eq(w.researched(), []);
    eq(w.listReads(), 0, 'nothing is read for the goals that wait');
    assert.ok(w.sent.some((s) => s[0] === 'item' && s[2] === C.DEFENSE_ITEMS.warhorn), 'the War Horn went');
    assert.ok(w.reads.some(([cmd, d]) => cmd === 'army.setArmyGoOut' && d.isArmyGoOut === false), 'the gate closed before impact');
    has(r.schedule.note, 'schedulepolicy: outside its hours (06:00-12:00)');
    has(r.schedule.note, 'until 06:00');
    assert.strictEqual(r.build, undefined);
    // inside the hours the city builds and researches as always
    NOW = at(8);
    const r2 = await w.e.focus(castle);
    eq(w.builds().map((s) => s.slice(0, 2)), [['upgrade', 1]]);
    eq(w.researched(), [T.ag]);
    has(r2.schedule.note, 'schedulepolicy: acting until 12:00');
  });

  await t('the console\'s Buildings tab says the builder waits for the city\'s hours', () => {
    const castle = town({ academy: 10, inside: [[TY.cottage, 1]] });
    const goals = parseGoals('schedulepolicy 06:00 12:00\nbuild c:2:1').goals;
    const off = buildOutlook({ castle, goals, config: {}, now: at(3) });
    has(off.next, 'upgrade Cottage (pos 1) L1->L2');
    eq(off.wait, 'the city is outside its schedulepolicy hours (06:00-12:00) until 06:00');
    eq(buildOutlook({ castle, goals, config: {}, now: at(8) }).wait, null);
  });

  await t('the war town recall is defence too: it goes outside the hours', async () => {
    const NOW = at(3);
    const castle = town({ academy: 10 });
    const out = { armyId: 55, startFieldId: castle.fieldId, targetFieldId: C.coordsToFieldId(1, 1), missionType: C.MISSION.attack, direction: 1 };
    const w = world(castle, { clock: () => NOW, self: [out] });
    w.goals('schedulepolicy 06:00 12:00\nconfig wartown:1\nbuild c:1:2');
    const r = await w.e.focus(castle);
    assert.ok(w.reads.some(([cmd, d]) => cmd === 'army.callBackArmy' && d.armyId === 55), 'the march was recalled');
    has(r.wartown.note, 'wartown 1');
    eq(w.builds(), []);
  });

  await t('a schedule past midnight: acting at 23:30, holding at 03:00', async () => {
    let NOW = at(23, 30);
    const castle = town({ academy: 10, inside: [[TY.cottage, 1]] });
    const w = world(castle, { clock: () => NOW });
    w.goals('schedulepolicy 22:00 02:00\nbuild c:3:1');
    await w.e.focus(castle);
    eq(w.builds().length, 1);
    w.finish();
    NOW = at(3);
    const r = await w.e.focus(castle);
    eq(w.builds().length, 1, 'nothing new at 03:00');
    has(r.schedule.note, 'until 22:00');
  });

  await t('the emergency walls are defence too: under attack outside the hours, 1 of each on the first line goes', async () => {
    const NOW = at(3);
    const castle = town({ academy: 10 });
    const w = world(castle, { clock: () => NOW, enemy: () => [wave(castle, NOW)] });
    w.goals('schedulepolicy 06:00 12:00\nfortification ab:5000,tra:100');
    const r = await w.e.focus(castle);
    eq(w.sent.filter((s) => s[0] === 'wall').map((s) => s[2]), [1, 1]);
    has(r.fort.note, 'the emergency walls go, outside the hours too');
  });

  await t('the traininghero does not leave a city outside its hours', async () => {
    const NOW = at(3);
    const a = town({ academy: 10 }), b = town({ academy: 10 });
    a.heros = [{ id: 7, name: 'OTTO', status: 0, level: 50, power: 100, management: 10, stratagem: 10 }];
    const w = world([a, b], { clock: () => NOW });
    w.goals('schedulepolicy 06:00 12:00\ntraininghero OTTO 0');
    await w.e.tick();
    assert.ok(!w.sent.some((s) => s[0] === 'march'), 'no move');
    assert.ok(w.lines.some((l) => /move OTTO to .* — held: City\d+ is outside its schedulepolicy hours \(06:00-12:00\) until 06:00/.test(l)), w.lines.join('\n'));
  });

  // ============================================================ processingpolicy
  section('processingpolicy: reading the line (processing.js)');

  const ppOf = (src) => { const p = parseGoals(src); eq(p.errors, [], src); return p.goals.filter((g) => g.name === 'processingpolicy'); };
  const prioAt = (src, when = at(12)) => P.policyAt(parseGoals(src).goals, when).prio;

  await t('the default: every task 10; n:10 m:20 *:5 as the wiki reads it', () => {
    eq(prioAt(''), { q: 10, b: 10, v: 10, n: 10, s: 10, a: 10, m: 10, t: 10, r: 10 });
    eq(prioAt('processingpolicy q:10 b:10 a:10 v:10 s:10 m:10 t:10 r:10 n:10'), prioAt(''));
    eq(prioAt('processingpolicy n:10 m:20 *:5'), { q: 5, b: 5, v: 5, n: 10, s: 5, a: 5, m: 20, t: 5, r: 5 });
    eq(prioAt('processingpolicy n:2.5 b'), { ...prioAt(''), n: 2.5, b: 10 });
  });

  await t('!x, x:0, x:off, x:false and x:no all turn a task off; !* every task the line does not name', () => {
    for (const src of ['processingpolicy !b', 'processingpolicy b:0', 'processingpolicy b:off', 'processingpolicy b:false', 'processingpolicy b:no']) {
      eq(prioAt(src).b, 0, src);
      eq(prioAt(src).n, 10, src);
    }
    eq(prioAt('processingpolicy m:10 n:20 a:30 !*'), { q: 0, b: 0, v: 0, n: 20, s: 0, a: 30, m: 10, t: 0, r: 0 });
    eq(prioAt('processingpolicy n:on').n, 10);
  });

  await t('= stands for : everywhere, /start and /end included; the wiki\'s /end:1400 reads as 14:00', () => {
    eq(prioAt('processingpolicy n=10 b=20 a=30'), { ...prioAt(''), n: 10, b: 20, a: 30 });
    const [g] = ppOf('processingpolicy /start=13:00 /end=14:00 !n');
    eq(g.window, { from: 13 * 3600, to: 14 * 3600, text: '13:00-14:00' });
    eq(ppOf('processingpolicy /start:13:00 /end:1400 !n')[0].window.text, '13:00-14:00');
    eq(ppOf('processingpolicy /start:13:00:30 /end:13:45:15 !n')[0].window.text, '13:00:30-13:45:15');
    eq(ppOf('processingpolicy /start:22:00 !n')[0].window.text, '22:00-24:00', '/start alone runs to midnight');
    eq(ppOf('processingpolicy /end:06:00 !n')[0].window.text, '00:00-06:00', '/end alone from midnight');
  });

  await t('a timed line holds only in its window, over the untimed ones, and may run past midnight', () => {
    const src = 'processingpolicy n:10 m:20 *:5\nprocessingpolicy /start:13:00 /end:1400 !n';
    eq(prioAt(src, at(12, 59)).n, 10);
    eq(prioAt(src, at(13, 0)).n, 0);
    eq(prioAt(src, at(13, 59)).n, 0);
    eq(prioAt(src, at(14, 0)).n, 10);
    eq(prioAt(src, at(13, 30)).m, 20, 'the rest of the untimed line stands');
    const night = 'processingpolicy /start:23:00 /end:02:00 b:50';
    eq([prioAt(night, at(23, 30)).b, prioAt(night, at(1)).b, prioAt(night, at(3)).b], [50, 50, 10]);
    eq(P.allowed(parseGoals(src).goals, 'n', at(13, 30)),
      { on: false, priority: 0, why: 'processingpolicy turns npc farming (n) off from 13:00 to 14:00' });
    eq(P.allowed(parseGoals('processingpolicy !r').goals, 'r', at(13)).why, 'processingpolicy turns sendresources (r) off');
    eq(P.allowed(parseGoals('').goals, 'r', at(13)), { on: true, priority: 10, why: null });
  });

  await t('mistakes are red: an unknown task, an unreadable priority, !x:5, a bad time, a line naming nothing', () => {
    for (const [src, want] of [['processingpolicy z:10', 'unknown task "z"'], ['processingpolicy n:soon', '"soon" is not a priority'],
      ['processingpolicy !n:5', 'write !n to turn it off, or n:<priority>'], ['processingpolicy /start:25:00 !n', '/start:25:00 needs a time of day'],
      ['processingpolicy /start:13:00 /end:13:00 !n', 'the same time'], ['processingpolicy /from:13:00 !n', 'unknown switch "/from"'],
      ['processingpolicy', 'names no task'], ['processingpolicy /start:13:00', 'names no task'], ['processingpolicy n:1 n:2', 'n is written twice']]) {
      const p = parseGoals(src);
      has(p.errors.map((e) => e.error).join(' | '), want);
      eq(p.lines[0].status, 'error', src);
    }
  });

  await t('every task is registered now (Step 20\'s valleys too) but rescue, which is accepted and noted', () => {
    eq(P.CODES.filter((c) => P.registered(c)), ['b', 'v', 'n', 's', 'a', 'm', 't', 'r']);
    eq(parseGoals('processingpolicy n:10 m:20 *:5').lines[0], { n: 1, status: 'ok', msg: null });
    const q = parseGoals('processingpolicy q:10 b:10 a:10 v:10 s:10 m:10 t:10 r:10 n:10').lines[0];
    eq(q.status, 'ok');
    has(q.msg, 'q (rescue — the NEAT wiki itself is unsure what it is) is accepted, but nothing here runs it yet');
    const only = parseGoals('processingpolicy q:5').lines[0];
    eq(only.status, 'idle', 'a line naming only a task nothing runs does nothing');
    has(only.msg, 'processingpolicy does nothing yet: q (rescue');
    eq(parseGoals('processingpolicy q:5 *:3').lines[0].status, 'ok', 'its * reaches tasks that run');
  });

  await t('describe says what each line does', () => {
    const d = describe(parseGoals('processingpolicy n:10 m:20 *:5\nprocessingpolicy /start:13:00 /end:1400 !n')).join('\n');
    has(d, 'processingpolicy: npc farming 10, medal hunting 20, every other task 5');
    has(d, 'processingpolicy: from 13:00 to 14:00, npc farming off');
    has(d, 'each mission sent adds 10/priority points to its task, and the fewest points go first');
  });

  section('processingpolicy: points, and the order the engine sends missions in');

  await t('the registry: each mission kind to its task (Step 20\'s valley marches by what they are for)', () => {
    const va = (purpose) => ({ kind: 'valleyAttack', purpose });
    eq([P.taskOf({ kind: 'npcAttack' }), P.taskOf({ kind: 'claimFlat' }), P.taskOf({ kind: 'foundCity' }),
      P.taskOf({ kind: 'transport' }), P.taskOf({ kind: 'reinforceTroops' }), P.taskOf({ kind: 'valleyScout' })], ['n', 'b', 'b', 'r', 't', 's']);
    eq(['capture', 'farm', 'safe', 'hunt', 'flat', 'build'].map((p) => P.taskOf(va(p))), ['a', 'v', 's', 'm', 'b', 'b']);
    eq([P.taskOf({ kind: 'abandonCity' }), P.taskOf({ kind: 'releaseFields' }), P.taskOf({ kind: 'recallArmy' }), P.taskOf({ kind: 'defenceItem' }),
      P.taskOf(null)], [null, null, null, null, null]);
    eq(P.taskOf({ kind: 'somethingNew', task: 'q' }), 'q', 'an action may name its task itself');
    assert.throws(() => P.register('x', { kinds: ['k'] }), /no task "x"/);
  });

  await t('points: a mission adds 10/priority, and they halve every two hours', () => {
    const st = {};
    P.record(st, 'n', 10, at(12));
    P.record(st, 'n', 10, at(12));
    P.record(st, 'm', 20, at(12));
    eq([P.points(st, 'n', at(12)), P.points(st, 'm', at(12)), P.points(st, 'r', at(12))], [2, 0.5, 0]);
    eq(P.points(st, 'n', at(14)), 1);
    eq(P.points(st, 'n', at(16)), 0.5);
    eq(st.processing.sent, { n: 2, m: 1 });
    eq(P.record(st, 'n', 0, at(12)), 0, 'a task turned off records nothing');
  });

  // An engine over one or two cities, for runPlanActions alone: a report made
  // by hand, with npc runs and resource transports in it.
  function queueWorld(src = '', { other = null, otherSrc = '' } = {}) {
    const castle = town({ id: 501, name: 'Here' });
    const o = other ? town({ id: 502, name: 'There' }) : null;
    const w = world(o ? [castle, o] : [castle], { clock: () => at(12) });
    w.goals(src);
    const goalsOf = (c) => parseGoals(c === castle ? src : otherSrc).goals;
    const book = w.e.rallyBook(goalsOf);
    const npc = (i) => ({ kind: 'npcAttack', heroId: i, fieldId: 1000 + i, level: 5, troops: { ballista: 1 }, label: `npc ${i}` });
    const tr = (i, from = castle) => ({ kind: 'transport', from, to: castle, resources: { food: 1 }, troops: { carriage: 1 }, label: `transport ${i}`,
      rally: { from, kind: 'r', missionType: C.MISSION.transport, targetFieldId: castle.fieldId, troops: { carriage: 1 } } });
    const run = async (report, budget = 3) => {
      report.acted = report.acted || [];
      const left = await w.e.runPlanActions(report, { castle, cityState: w.e.state['501'] = w.e.state['501'] || {}, book, budget,
        goals: parseGoals(src).goals, goalsOf });
      return { acted: report.acted, left };
    };
    return { w, castle, other: o, npc, tr, run, book };
  }
  const labels = (acted) => acted.map((s) => s.replace(/ -> .*$/, ''));

  await t('with the default priorities the task with the fewest points goes first; ties keep the report\'s order', async () => {
    const q = queueWorld();
    q.w.e.state['501'] = { processing: { points: { n: { v: 3, at: at(12) } } } };
    // book.check wants a rally spot: take the transports' rally away for this one
    const t1 = q.tr(1), t2 = q.tr(2);
    delete t1.rally; delete t2.rally;
    const r = await q.run({ city: 'Here', npc: { note: '', actions: [q.npc(1), q.npc(2)] }, push: { note: '', actions: [t1, t2] } });
    eq(labels(r.acted), ['transport 1', 'transport 2', 'npc 1']);
    assert.ok(r.left <= 0, 'the three actions are spent');
    const pts = q.w.e.state['501'].processing.points;
    eq([Math.round(pts.n.v), Math.round(pts.r.v)], [4, 2]);
  });

  await t('n:20 r:10 sends about twice as many npc runs as transports, interleaved', async () => {
    const q = queueWorld('processingpolicy n:20 r:10');
    const npcs = Array.from({ length: 30 }, (_, i) => q.npc(i));
    const trs = Array.from({ length: 30 }, (_, i) => { const x = q.tr(i); delete x.rally; return x; });
    const r = await q.run({ city: 'Here', npc: { note: '', actions: npcs }, push: { note: '', actions: trs } }, 30);
    const n = labels(r.acted).filter((l) => l.startsWith('npc')).length;
    eq([n, 30 - n], [20, 10]);
    eq(labels(r.acted).slice(0, 6), ['npc 0', 'transport 0', 'npc 1', 'npc 2', 'transport 1', 'npc 3']);
  });

  await t('a task turned off is held, with the reason on its plan, even if its plan sent it', async () => {
    const q = queueWorld('processingpolicy !r');
    const t1 = q.tr(1); delete t1.rally;
    const report = { city: 'Here', npc: { note: 'npc', actions: [q.npc(1)] }, push: { note: 'send', actions: [t1] } };
    const r = await q.run(report);
    eq(labels(r.acted), ['npc 1']);
    has(report.push.note, 'held back: transport 1: processingpolicy turns sendresources (r) off');
  });

  await t('a pull from another city counts that city\'s policy and points', async () => {
    const q = queueWorld('', { other: true, otherSrc: 'processingpolicy r:5' });
    const t1 = q.tr(1, q.other); delete t1.rally;
    Object.defineProperty(t1, 'rally', { value: { from: q.other }, enumerable: false });
    q.book.check = () => null;
    await q.run({ city: 'Here', transfer: { note: '', actions: [t1] } });
    eq(q.w.e.state['502'].processing.points.r.v, 2, 'r:5 adds 2 points, in the sending city');
    assert.ok(!(q.w.e.state['501'].processing && q.w.e.state['501'].processing.points && q.w.e.state['501'].processing.points.r));
    const off = queueWorld('', { other: true, otherSrc: 'processingpolicy !r' });
    const t2 = off.tr(2, off.other); delete t2.rally;
    Object.defineProperty(t2, 'rally', { value: { from: off.other }, enumerable: false });
    off.book.check = () => null;
    const report = { city: 'Here', transfer: { note: '', actions: [t2] } };
    const r = await off.run(report);
    eq(r.acted, []);
    has(report.transfer.note, 'processingpolicy turns sendresources (r) off');
  });

  await t('a dry run plans in the same order, and records no points', async () => {
    const q = queueWorld('processingpolicy n:20 r:10');
    q.w.e.dryRun = true;
    const trs = [0, 1].map((i) => { const x = q.tr(i); delete x.rally; return x; });
    const r = await q.run({ city: 'Here', npc: { note: '', actions: [q.npc(0), q.npc(1), q.npc(2)] }, push: { note: '', actions: trs } }, 5);
    eq(r.acted, ['[plan] npc 0', '[plan] transport 0', '[plan] npc 1', '[plan] npc 2', '[plan] transport 1']);
    assert.ok(!q.w.e.state['501'].processing);
  });

  await t('a city\'s engine report carries the processingpolicy note; a city without the line has none', async () => {
    const castle = town({ academy: 10 });
    const w = world(castle, { clock: () => at(13, 30) });
    w.goals('processingpolicy n:10 m:20\nprocessingpolicy /start:13:00 /end:14:00 !n');
    const r = await w.e.focus(castle);
    has(r.processing.note, 'processingpolicy: b 10, v 10, n off, s 10, a 10, m 20, t 10, r 10; now in 13:00-14:00');
    w.goals('build c:1:1');
    eq((await w.e.focus(castle)).processing, undefined);
  });

  await t('the engine\'s note names each task\'s priority and points', () => {
    const st = {};
    P.record(st, 'n', 10, at(13, 30));
    const note = P.processingNote(parseGoals('processingpolicy n:10 m:20 *:5\nprocessingpolicy /start:13:00 /end:1400 !r').goals, st, at(13, 30));
    has(note, 'processingpolicy: b 5, v 5, n 10 (1.0 pts), s 5, a 5, m 20, t 5, r off');
    has(note, 'now in 13:00-14:00');
    eq(P.processingNote(parseGoals('build c:1').goals, st, at(12)), null);
  });

  section('processingpolicy: each goal that sends a mission asks first');

  // NPC camps around a city, all level 5, nearest first (test-wartown.js's fixture)
  function npcPlan(src, NOW = at(12)) {
    const castle = town({ id: 601, name: 'Farmer' });
    castle.buildings.push(bean(TY.rally, 5, 10));
    castle.troop = { carriage: 20000, ballista: 5000 };
    castle.heros = [{ id: 1, name: 'Strong', power: 150, powerAdded: 0, management: 10, stratagem: 10, level: 20, status: 0 }];
    const home = C.fieldIdToCoords(castle.fieldId);
    const castles = {};
    for (const [dx, dy] of [[1, 0], [0, 2]]) {
      const x = home.x + dx, y = home.y + dy, id = C.coordsToFieldId(x, y);
      castles[id] = { id, x, y, level: 5, kind: 'npc', npc: true, name: "Barbarian's city", seen: NOW };
    }
    const p = parseGoals(src);
    const game = { castles: [castle], now: () => NOW, castleId: (c) => c.id, castleXY: (c) => C.fieldIdToCoords(c.fieldId), player: { selfArmys: [] } };
    const ctx = { game, castle, goals: p.goals, config: p.config, controls: {}, selfArmies: [], mapCache: { updatedAt: NOW, castles }, now: NOW,
      techs: { levels: { 9: 10, 13: 10, 14: 10 } } };
    return NPC.plans.npc(ctx, {}, game);
  }

  await t('npc farming: !n sends no run, and a timed !n only inside its hours', () => {
    assert.ok(npcPlan('config npc:5').actions.length > 0);
    const off = npcPlan('config npc:5\nprocessingpolicy !n');
    eq(off.actions, []);
    has(off.note, 'npc:5 — held: processingpolicy turns npc farming (n) off');
    const timed = 'config npc:5\nprocessingpolicy /start:13:00 /end:1400 !n';
    eq(npcPlan(timed, at(13, 30)).actions, []);
    assert.ok(npcPlan(timed, at(14, 30)).actions.length > 0);
  });

  await t('buildnpc: !b stands the whole goal down (no capture, no founding, no abandon)', () => {
    const castle = town({ id: 602 });
    const p = parseGoals('config buildnpc:5\nprocessingpolicy !b');
    const game = { castles: [castle], now: () => at(12), castleId: (c) => c.id, castleXY: (c) => C.fieldIdToCoords(c.fieldId) };
    const r = B.plans.buildnpc({ game, castle, goals: p.goals, config: p.config, accountId: 'acct', controls: {} }, {}, game);
    eq(r.actions, []);
    has(r.note, 'buildnpc — standing down: processingpolicy turns buildnpc (b) off');
  });

  // the push and pull fixtures of test-resources-market.js / test-neat-compat.js
  const city = (name, x, y, food, extra = {}) => ({
    castleId: nextCity++, name, fieldId: C.coordsToFieldId(x, y),
    resource: { food: { amount: food }, wood: { amount: 0 }, stone: { amount: 0 }, iron: { amount: 0 }, gold: 1e9 },
    troop: { carriage: 20000 }, buildings: [{ typeId: 29, level: 10, positionId: 5 }], heros: [], fortification: {}, ...extra,
  });
  const fakeGame = (castles) => {
    const g = {
      castles, player: { playerInfo: { userName: 'T' }, selfArmys: [], enemyArmys: [], items: [] },
      castleId: (c) => c.castleId, castleXY: (c) => C.fieldIdToCoords(c.fieldId), now: () => at(12),
      req: async () => ({ ok: 1 }), buildArmyBean: (o) => Game.prototype.buildArmyBean.call(g, o), newArmy: async () => ({ ok: 1 }),
    };
    return g;
  };

  await t('sendresources / keepresources: !r sends nothing from this city, and says so', () => {
    const here = city('Here', 100, 100, 5e9), there = city('There', 104, 100, 0);
    const game = fakeGame([here, there]);
    const run = (src) => { const p = parseGoals(src); return TR.plans.push({ castle: here, goals: p.goals, config: p.config, goalsOf: () => [], game }, {}, game); };
    eq(run('sendresources There food 1b 2b').actions.length, 1);
    const off = run('sendresources There food 1b 2b\nprocessingpolicy !r');
    eq(off.actions, []);
    has(off.note, 'sendresources: held — processingpolicy turns sendresources (r) off');
    eq(run('sendresources There food 1b 2b\nprocessingpolicy !t').actions.length, 1, 'troops off leaves resources alone');
  });

  await t('requestresources: a city whose processingpolicy turns r off is not asked to send', () => {
    const here = city('Here', 100, 100, 1e6), donor = city('Donor', 104, 100, 5e9);
    const game = fakeGame([here, donor]);
    const run = (donorSrc) => {
      const p = parseGoals('requestresources Donor food 100m 1b');
      const goalsOf = (c) => (c === donor ? parseGoals(donorSrc).goals : p.goals);
      return TR.plans.transfer({ castle: here, goals: p.goals, config: p.config, goalsOf }, {}, game);
    };
    eq(run('').actions.length, 1);
    const off = run('processingpolicy !r');
    eq(off.actions, []);
    has(off.note, 'Donor: processingpolicy turns sendresources (r) off');
  });

  await t('valley marches ask for the task their purpose is (Step 20: capture a, farm v, safe s, hunt m, flats b)', () => {
    const castle = town({ id: 603 });
    const want = { capture: 'valley acquisition (a)', farm: 'valley farming (v)', safe: 'safe valley farming (s)',
      hunt: 'medal hunting (m)', flat: 'buildnpc (b)', build: 'buildnpc (b)' };
    for (const [purpose, task] of Object.entries(want)) {
      const code = task.slice(-2, -1);
      const p = parseGoals(`processingpolicy !${code}`);
      const ctx = { game: { now: () => at(12) }, castle, goals: p.goals, config: p.config };
      const r = V.planAttack({ ctx, state: {}, game: ctx.game, castle, home: { x: 1, y: 1 }, st: {}, target: { id: 1, x: 2, y: 2, level: 5, kind: 'forest' }, purpose });
      eq(r, { why: `processingpolicy turns ${task} off` }, purpose);
    }
  });

  // ================================================================== obsolete
  section('NEAT\'s obsolete goals, read as what replaced them (wiki Obsolete, CapturedFireLimit)');

  const line1 = (src) => parseGoals(src).lines[0];

  await t('ballsused 25,50,170,250,500: an npctroops line for each of levels 1 to 5, and the troop load uses it', () => {
    const p = parseGoals('ballsused 25,50,170,250,500');
    eq(p.errors, []);
    eq(p.goals.map((g) => [g.name, g.level, g.troops]), [1, 2, 3, 4, 5].map((l, i) => ['npctroops', l, { ballista: [25, 50, 170, 250, 500][i] }]));
    eq(line1('ballsused 25,50,170,250,500'), { n: 1, status: 'ok',
      msg: 'obsolete in NEAT — read as "npctroops 1 b:25", "npctroops 2 b:50", "npctroops 3 b:170", "npctroops 4 b:250", "npctroops 5 b:500"' });
    const ctx = { goals: p.goals, config: {} };
    const hero = { power: 150, powerAdded: 0 };
    eq(NPC._internals.troopLoadFor(ctx, 3, hero, null, { loot: 0 }).troops.ballista, 170);
    has(describe(p).join('\n'), 'note: line 1 obsolete in NEAT — read as "npctroops 1 b:25"');
    has(describe(p).join('\n'), 'npctroops: npctroops 3 b:170');
  });

  await t('ballsused mistakes: a 0 would send transports alone and is refused; more than five, or nothing, is red', () => {
    const z = parseGoals('ballsused 25,0,170');
    eq(z.goals.map((g) => g.level), [1, 3]);
    has(z.errors[0].error, 'BALLSUSED: level 2: 0 ballistas would send the transports alone');
    has(parseGoals('ballsused 1,2,3,4,5,6').errors[0].error, 'ballsused covers levels 1 to 5');
    has(parseGoals('ballsused').errors[0].error, 'needs the ballistas for levels 1 to 5');
    has(parseGoals('ballsused 25,lots').errors[0].error, 'level 2: "lots" is not a whole number');
  });

  await t('npc10troops, npc10limit(s), npc10list and npc10heroes are the level-10 lines they became', () => {
    const p = parseGoals('npc10troops a:90000,wo:2000,w:2000,s:4000,t:2000\nnpc10limit a:390000,s:50000\nnpc10limits a:1k\nnpc10list 111,222 111,333\nnpc10heroes Strong');
    eq(p.errors, []);
    eq(p.goals.map((g) => [g.name, g.level]), [['npctroops', 10], ['npclimits', 10], ['npclimits', 10], ['npclist', 10], ['npc10heroes', 10]]);
    eq(p.goals[0].troops, { archer: 90000, peasants: 2000, militia: 2000, scouter: 4000, carriage: 2000 });
    const ctx = { goals: p.goals, config: {} };
    eq(NPC._internals.limitsFor(ctx, 10).troops, { archer: 390000, scouter: 50000 });
    eq(NPC._internals.rangeFor(ctx, 10).rule, 'npclist');
    eq(NPC._internals.heroSpecFor(ctx, 10), 'Strong');
    eq(p.lines.map((l) => l.msg), [
      'obsolete in NEAT — read as "npctroops 10 a:90000,wo:2000,w:2000,s:4000,t:2000"',
      'obsolete in NEAT — read as "npclimits 10 a:390000,s:50000"',
      'obsolete in NEAT — read as "npclimits 10 a:1k"',
      'obsolete in NEAT — read as "npclist 10 111,222 111,333"',
      'obsolete in NEAT — read as "npcheroes 10 Strong"']);
    assert.ok(p.lines.every((l) => l.status === 'ok'));
  });

  await t('npcexcludelist, npc10excludelist and noabandonflats are the excludelist; Step 20\'s abandonflats keeps those flats', () => {
    const p = parseGoals('npcexcludelist 111,222\nnpc10excludelist 111,333\nnoabandonflats 120,130');
    eq(p.errors, []);
    eq(p.goals.map((g) => [g.name, g.coords]), [['excludelist', [{ x: 111, y: 222 }]], ['excludelist', [{ x: 111, y: 333 }]], ['excludelist', [{ x: 120, y: 130 }]]]);
    eq(p.lines.map((l) => l.status), ['ok', 'ok', 'ok']);
    eq(p.lines[2].msg, 'obsolete in NEAT — read as "excludelist 120,130"');
    const ids = V.excludedIds({ goals: p.goals });
    assert.ok(ids.has(C.coordsToFieldId(120, 130)) && ids.has(C.coordsToFieldId(111, 222)));
    // an npc camp on the list is never farmed
    const home = { x: 110, y: 222 };
    const cache = { npcs: [{ id: C.coordsToFieldId(111, 222), x: 111, y: 222, level: 5 }, { id: C.coordsToFieldId(112, 222), x: 112, y: 222, level: 5 }] };
    eq(NPC._internals.targetsFor({ goals: p.goals, config: {} }, cache, home, 5).map((x) => x.x), [112]);
    // while flats are not built, noabandonflats would say it does nothing: the table is the one switch
    G.NOT_IMPLEMENTED.config.abandonflats = 'a reason put here by this test only';
    try { eq(line1('noabandonflats 120,130').status, 'idle'); }
    finally { delete G.NOT_IMPLEMENTED.config.abandonflats; }
  });

  await t('capturedfirelimit 100 is keepcapturedheroes any:level>=100 (wiki CapturedFireLimit)', () => {
    const p = parseGoals('capturedfirelimit 100');
    eq(p.errors, []);
    eq([p.goals[0].name, p.goals[0].readAs], ['keepcapturedheroes', 'keepcapturedheroes any:level>=100']);
    eq(line1('capturedfirelimit 100').msg, 'obsolete in NEAT — read as "keepcapturedheroes any:level>=100"');
    const heroes = [
      { id: 1, name: 'Big', level: 120, status: 4, power: 80, management: 80, stratagem: 80 },
      { id: 2, name: 'Small', level: 80, status: 4, power: 80, management: 80, stratagem: 80 },
    ];
    const k = H.keepRules({ goals: p.goals, castle: { heros: heroes } }, {});
    assert.ok(k.protectedBy(heroes[0]), 'L120 is kept');
    eq(k.protectedBy(heroes[1]), null, 'L80 is not: the line replaces the default');
    has(parseGoals('capturedfirelimit').errors[0].error, 'needs one hero level');
    has(parseGoals('capturedfirelimit lots').errors[0].error, 'needs one hero level');
  });

  await t('every page on the wiki\'s Obsolete list reads, and a script layer takes them too', () => {
    for (const name of ['ballsused', 'noabandonflats', 'npc10heroes', 'npc10list', 'npc10troops', 'npc10limit', 'npc10excludelist', 'npcexcludelist', 'capturedfirelimit']) {
      assert.ok(G.OBSOLETE[name], name);
    }
    const GL = require('./goallayers');
    const out = GL.setScriptLayer('acct-obs', 77, 'ballsused 30,60\nnpc10troops a:1k');
    eq(out.errors, []);
    const running = GL.parseLayered({ script: GL.getScriptLayer('acct-obs', 77) });
    eq(running.goals.map((g) => [g.name, g.level]), [['npctroops', 1], ['npctroops', 2], ['npctroops', 10]]);
    GL.clearScriptLayer('acct-obs', 77);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
