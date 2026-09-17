'use strict';
// The city and troop commands (script-cmd-city.js), offline, through the real VM:
// script.parse + script.run on a real Game whose game.req is stubbed by a small
// fake server. It changes the castle the way session.js applies the pushes (a
// construction starts, then lands a moment later; a research ends with a
// server.ResearchCompleteUpdate), so the waits are real. Every Usage and Example
// line of the wiki pages the module covers is read here, and each command runs
// against a fake city: what was sent, $error and $result, dry runs sending
// nothing, the waits, the guards on destructive lines and the coins switch.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const { EventEmitter } = require('events');
process.env.EVONY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ev-sc-')), 't.db');   // goals.js opens it
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');
const CITY = require('./script-cmd-city');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const F = (x, y) => C.coordsToFieldId(x, y);
const P = (line) => script.parseLine(line);
const parseErr = (line) => { try { script.parseLine(line); } catch (e) { return e.message; } return null; };
const errs = (src) => script.parse(src).filter((x) => x.cmd === 'error').map((x) => x.error);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCRIPT = 'consume.blueprint.1';      // Michelangelo's Script
const DYNAMITE = 'player.destroy.1.a';
const PIONEER = 'player.move.castle.1.b';
// the module's waits, shrunk (run() opts it reads)
const FAST = { cityPollMs: 3, cityGraceMs: 60, cityRecheckMs: 5, cityPlotWaitMs: 120, cityPushWaitMs: 40 };

// ---------------------------------------------------------------- the fake world
const B = (typeId, positionId, level, o = {}) => ({ typeId, positionId, level, status: 0, name: (C.BUILDING_BY_ID[typeId] || {}).name, ...o });
const hero = (id, name, status, power, o = {}) => ({ id, name, status, power, level: 50, management: 20, stratagem: 20, ...o });
const resOf = ({ gold = 5e6, each = 5e6, rate = 100000, max = 50e6, pop = 50000, work = 5000, build = 0 } = {}) => ({
  gold, curPopulation: pop, maxPopulation: pop * 2, workPeople: work, buildPeople: build, texRate: 10, support: 80, complaint: 3, troopCostFood: 0,
  food: { amount: each, increaseRate: rate, max, workPeople: 1000 }, wood: { amount: each, increaseRate: rate, max, workPeople: 1000 },
  stone: { amount: each, increaseRate: rate, max, workPeople: 1000 }, iron: { amount: each, increaseRate: rate, max, workPeople: 1000 },
});
const cost = (o = {}) => ({ food: 100, wood: 200, stone: 300, iron: 50, gold: 0, time: 600, buildings: [], techs: [], items: [], ...o });
// research beans (AvailableResearchListBean) of Home
const techs = () => [
  { typeId: 14, level: 3, avalevel: 6, permition: true, upgradeing: false, conditionBean: cost({ time: 3000, food: 900 }) },   // archery
  { typeId: 12, level: 1, avalevel: 6, permition: true, upgradeing: false, conditionBean: cost({ time: 1000, food: 5000 }) },  // compass
  { typeId: 17, level: 0, avalevel: 6, permition: true, upgradeing: false, conditionBean: cost({ time: 2000, food: 100 }) },   // construction
  { typeId: 7, level: 0, avalevel: 6, permition: true, upgradeing: false, conditionBean: cost({ time: 300, food: 50 }) },      // informatics
  { typeId: 8, level: 2, avalevel: 6, permition: false, upgradeing: false, conditionBean: cost() },                            // military science
  { typeId: 11, level: 4, avalevel: 6, permition: true, upgradeing: false,                                                    // logistics
    conditionBean: cost({ buildings: [{ typeId: 25, level: 7, curLevel: 6, successFlag: false }] }) },
  { typeId: 5, level: 0, avalevel: 6, permition: true, upgradeing: false,                                                     // metal casting
    conditionBean: cost({ techs: [{ id: 4, level: 1, curLevel: 0, successFlag: false }] }) },
];

// o: items {id: count} (null: inventory never loaded), jobMs, replies {cmd: fn|reply},
// itemFinishes (a speed-up item ends the job), push (items spent leave the list), buildings
function world(o = {}) {
  const g = new Game();
  g.serverOffset = 0;
  g.c = new EventEmitter();
  const jobMs = o.jobMs ?? 25;
  g.player = {
    playerInfo: { userName: 'Tester', titleId: 5 }, selfArmys: [], buffs: [],
    items: o.items === null ? undefined : Object.entries(o.items || {}).map(([id, count]) => ({ id, count })),
  };
  const home = {
    id: 1, name: 'Home', fieldId: F(100, 100), logUrl: 'images/icon/cityLogo/citylogo_02.png', buffs: [],
    buildings: o.buildings || [
      B(31, -1, 8), B(32, -2, 5), B(25, 0, 6), B(22, 1, 10), B(26, 10, 2),
      B(2, 11, 5), B(2, 18, 6), B(2, 20, 7), B(2, 21, 8),
      B(1, 12, 3), B(1, 13, 9), B(1, 14, 10), B(1, 15, 1),
      B(7, 1001, 2), B(7, 1002, 4), B(4, 1038, 6), B(4, 1003, 9), B(5, 1039, 3), B(6, 1040, 7), B(6, 1004, 9),
    ],
    resource: resOf(o.res),
    troop: { peasants: 1000, militia: 30000, scouter: 60000, pikemen: 10, swordsmen: 10, archer: 100000, carriage: 0, lightCavalry: 5000,
      heavyCavalry: 0, ballista: 0, batteringRam: 0, catapult: 0, ...(o.troop || {}) },
    heros: [hero(11, 'Ken', 0, 120), hero(12, 'Queen', 1, 50), hero(13, 'Ace', 0, 300), hero(14, 'Away', 3, 500)],
    fields: [{ id: F(101, 100), type: 1, level: 5, name: 'Forest' }, { id: F(102, 100), type: 10, level: 3, name: 'Flat' }],
    fortification: { trap: 100, abatis: 50, arrowTower: 20000, rollingLogs: 10, rockfall: 30000 },
  };
  const fla = { id: 2, name: 'Fla', fieldId: F(120, 100), buffs: [], buildings: [B(31, -1, 5)], heros: [hero(21, 'Dee', 0, 80)],
    resource: resOf(), troop: { archer: 10 }, fields: [{ id: F(121, 100), type: 5, level: 2, name: 'Grassland' }] };
  const empty = { id: 3, name: 'Empty', fieldId: F(700, 700), buffs: [], buildings: [B(31, -1, 1)], heros: [], resource: resOf(), troop: {}, fields: [] };
  g.castles = [home, fla, empty];
  const research = new Map([[1, techs()]]);
  const sent = [];
  const timers = new Set();
  const later = (ms, f) => { const x = setTimeout(() => { timers.delete(x); f(); }, ms); timers.add(x); return x; };
  const cityOf = (d) => g.castles.find((c) => c.id === Number(d.castleId));
  const beanAt = (c, pos) => c.buildings.find((b) => b.positionId === pos);

  // a construction: the plot's bean shows it under way, and it lands after jobMs
  const jobs = new Map();
  function start(c, pos, dir, typeId) {
    let b = beanAt(c, pos);
    if (!b) { b = B(typeId, pos, 0); c.buildings.push(b); }
    Object.assign(b, { status: dir === 'up' ? 1 : 2, startTime: g.now(), endTime: g.now() + jobMs });
    jobs.set(`${c.id}:${pos}`, later(jobMs, () => land(c, pos)));
  }
  function land(c, pos, whole = false) {
    const key = `${c.id}:${pos}`;
    clearTimeout(jobs.get(key)); timers.delete(jobs.get(key)); jobs.delete(key);
    const b = beanAt(c, pos);
    if (!b) return;
    if (b.status === 1) b.level++;
    else if (b.status === 2) b.level = whole ? 0 : b.level - 1;
    Object.assign(b, { status: 0, endTime: 0 });
    if (b.level === 0) c.buildings.splice(c.buildings.indexOf(b), 1);    // a finished demolition is dropped
  }
  const spend = (id) => {
    if (o.push === false || !g.player.items) return;
    const it = g.player.items.find((x) => x.id === id);
    if (it) it.count--;
  };
  // a research: marked on the list, ended by the push
  function finishResearch(cid) {
    const bean = (research.get(cid) || []).find((b) => b.upgradeing && b.castleId === cid);
    if (!bean) return;
    clearTimeout(bean.timer); timers.delete(bean.timer);
    Object.assign(bean, { upgradeing: false, level: bean.level + 1, endTime: 0, timer: undefined });
    g.c.emit('cmd', 'server.ResearchCompleteUpdate', { castleId: cid });
  }
  const DEF = {
    'castle.getAvailableBuildingBean': (d) => ({ ok: 1, builingList: [{ typeId: d.typeId, conditionBean: (o.newCond || cost)({}) }] }),
    'castle.checkOutUpgrade': (d) => {
      const b = beanAt(cityOf(d), d.positionId);
      const items = b && b.level === 9 ? [{ id: SCRIPT, num: 1, curNum: 1, successFlag: true }] : [];
      return { ok: 1, conditionBean: (o.upCond || ((x) => x))(cost({ items }), b) };
    },
    'castle.newBuilding': (d) => { start(cityOf(d), d.positionId, 'up', d.buildingType); return { ok: 1 }; },
    'castle.upgradeBuilding': (d) => { start(cityOf(d), d.positionId, 'up'); return { ok: 1 }; },
    'castle.destructBuilding': (d) => { start(cityOf(d), d.positionId, 'down'); return { ok: 1 }; },
    'castle.speedUpBuildCommand': (d) => {
      const c = cityOf(d);
      if (d.itemId === DYNAMITE) { spend(d.itemId); land(c, d.positionId, true); return { ok: 1 }; }
      if (d.itemId === 'free.speed' || d.itemId === 'coins.speed' || o.itemFinishes !== false) land(c, d.positionId);
      else { const b = beanAt(c, d.positionId); if (b) b.endTime -= 1; }
      spend(d.itemId);
      return { ok: 1 };
    },
    'castle.cancleBuildCommand': (d) => {
      const c = cityOf(d), b = beanAt(c, d.positionId);
      clearTimeout(jobs.get(`${c.id}:${d.positionId}`));
      if (b) { if (b.status === 1 && b.level === 0) c.buildings.splice(c.buildings.indexOf(b), 1); else Object.assign(b, { status: 0, endTime: 0 }); }
      return { ok: 1 };
    },
    'castle.getCoinsNeed': { ok: 1, coinsNeed: 42 },
    'tech.getCoinsNeed': { ok: 1, coinsNeed: 17 },
    'tech.getResearchList': (d) => ({ ok: 1, acailableResearchBeans: (research.get(d.castleId) || []).map(({ timer, ...b }) => ({ ...b })) }),
    'tech.research': (d) => {
      const bean = (research.get(d.castleId) || []).find((b) => b.typeId === d.techId);
      Object.assign(bean, { upgradeing: true, castleId: d.castleId, startTime: g.now(), endTime: g.now() + jobMs });
      bean.timer = later(jobMs, () => finishResearch(d.castleId));
      const { timer, ...tech } = bean;
      return { ok: 1, tech };
    },
    'tech.speedUpResearch': (d) => {
      if (d.itemId === 'free.speed' || d.itemId === 'coins.speed' || o.itemFinishes !== false) finishResearch(d.castleId);
      spend(d.itemId);
      const bean = (research.get(d.castleId) || []).find((b) => b.typeId);
      return { ok: 1, tech: { typeId: bean.typeId, upgradeing: o.itemFinishes === false, endTime: g.now() + jobMs } };
    },
    'tech.cancelResearch': (d) => {
      const bean = (research.get(d.castleId) || []).find((b) => b.upgradeing);
      if (bean) { clearTimeout(bean.timer); Object.assign(bean, { upgradeing: false, endTime: 0 }); }
      return { ok: 1 };
    },
    'army.getInjuredTroop': (d) => {
      if (o.camp !== undefined) later(2, () => g.c.emit('cmd', 'server.InjuredTroopUpdate', { castleId: d.castleId, ...o.camp }));
      return { ok: 1 };
    },
    'army.callBackArmy': (d) => {
      const a = g.player.selfArmys.find((x) => x.armyId === d.armyId);
      if (a) { a.direction = 2; later(o.homeMs ?? 10, () => { g.player.selfArmys = g.player.selfArmys.filter((x) => x !== a); }); }
      return { ok: 1 };
    },
    'hero.promoteToChief': (d) => {
      const c = cityOf(d);
      for (const h of c.heros) if (h.status === 1) h.status = 0;
      c.heros.find((h) => h.id === d.heroId).status = 1;
      return { ok: 1 };
    },
    'hero.dischargeChief': (d) => { for (const h of cityOf(d).heros) if (h.status === 1) h.status = 0; return { ok: 1 }; },
    'common.zoneInfo': { ok: 1, zones: C.ZONES.map((name, i) => ({ id: i, name, playerCount: 10, castleCount: 20, rate: 5 })) },
    'city.moveCastle': (d) => {
      const zone = C.ZONES[d.zoneId];
      // somewhere in that state: the first tile of it the map has
      let to = null;
      for (let y = 0; y < 800 && !to; y += 50) for (let x = 0; x < 800 && !to; x += 50) if (C.zoneOf(x, y) === zone) to = F(x, y);
      setImmediate(() => g.c.emit('cmd', 'server.CastleUpdate', { updateType: 2, castleBean: { id: d.castleId, fieldId: to } }));
      return { ok: 1 };
    },
    // an exact-tile move lands there (the push teleport.js waits for)
    'city.advMoveCastle': (d) => { setImmediate(() => g.c.emit('cmd', 'server.CastleUpdate', { updateType: 2, castleBean: { id: d.castleId, fieldId: d.targetId } })); return { ok: 1 }; },
    'city.WarMoveCastle': (d) => { setImmediate(() => g.c.emit('cmd', 'server.CastleUpdate', { updateType: 2, castleBean: { id: d.castleId, fieldId: d.targetId } })); return { ok: 1 }; },
    'city.giveupCastle': (d) => { g.castles = g.castles.filter((c) => c.id !== d.castleId); return { ok: 1 }; },
    'army.getTroopParam': { ok: 1, marchSkillParam: 0, loadSkillParam: 0 },
  };
  // a reply given in o.replies wins; a function there gets (data, the defaults)
  const R = { ...DEF, ...(o.replies || {}) };
  g.req = async (cmd, data) => {
    sent.push({ cmd, data });
    const r = R[cmd];
    const v = typeof r === 'function' ? r(data, DEF) : r;
    return v === undefined ? { ok: 1 } : v;
  };
  // the three calls game.js sends on its own socket
  let nextArmy = 900;
  g.newArmy = async (castleId, bean) => {
    sent.push({ cmd: 'army.newArmy', data: { castleId, newArmyBean: bean } });
    const r = o.armyReply || { ok: 1 };
    if (r.ok === 1) {
      const c = g.castles.find((x) => x.id === castleId);
      g.player.selfArmys = [...g.player.selfArmys, { armyId: nextArmy++, direction: 1, missionType: bean.missionType, startFieldId: c.fieldId,
        targetFieldId: bean.targetPoint, reachTime: g.now() + 1000, troop: bean.troops, resource: bean.resource }];
      if (bean.heroId !== undefined) c.heros.find((h) => h.id === bean.heroId).status = 3;
    }
    return r;
  };
  g.produceWall = async (castleId, wallProtectType, num) => { sent.push({ cmd: 'fortifications.produceWallProtect', data: { castleId, wallProtectType, num } }); return { ok: 1 }; };
  g.produceTroop = async (castleId, troopType, num, positionId = 4) => {
    sent.push({ cmd: 'troop.produceTroop', data: { castleId, positionId, troopType, num, isShare: false, toIdle: false } });
    return { ok: 1 };
  };
  const close = () => { for (const x of timers) clearTimeout(x); timers.clear(); };
  return { g, sent, home, fla, empty, research, land, start, close, jobs };
}

const cmds = (w) => w.sent.map((s) => s.cmd);
const reads = new Set(['castle.getAvailableBuildingBean', 'castle.checkOutUpgrade', 'tech.getResearchList', 'castle.getCoinsNeed',
  'tech.getCoinsNeed', 'army.getInjuredTroop', 'common.zoneInfo', 'army.getTroopParam', 'troop.checkIdleBarrack',
  'troop.getProduceQueue', 'fortifications.getProduceQueue']);
const writes = (w) => w.sent.filter((s) => !reads.has(s.cmd));
const only = (w, cmd) => w.sent.filter((s) => s.cmd === cmd).map((s) => s.data);

// `see($error, $result)` hands the pair to the test as it is
async function runIn(w, src, opts = {}) {
  const out = [], seen = [];
  const globals = { see: (e, r) => { seen.push([e, r]); } };
  const acts = script.parse(src, { globals });
  const bad = acts.filter((a) => a.cmd === 'error');
  if (bad.length) throw new Error('parse: ' + bad.map((b) => `line ${b.line}: ${b.error}`).join('; '));
  let done;
  try {
    done = await script.run(w.g, acts, (m) => out.push(m), { castle: 'Home', repeatGapMs: 0, globals, ...FAST, ...opts });
  } finally { if (!opts.keepTimers) w.close(); }
  return { done, out, text: out.join('\n'), seen };
}
const SEE = '\nsee($error, $result)';
const last = (r) => r.seen[r.seen.length - 1];

// ---------------------------------------------------------------------------
section('the wiki lines read');

t('Create: every example, a position, NEAT\'s building codes and the switches', () => {
  assert.deepStrictEqual(P('create cottage'), { cmd: 'create', at: null, policy: null, building: C.BUILDING_BY_ID[1] });
  assert.strictEqual(P('create fo').building.typeId, 22);
  assert.strictEqual(P('create barrack').building.typeId, 2);
  assert.deepStrictEqual([P('create a 0').building.typeId, P('create a 0').at], [25, 0]);
  assert.deepStrictEqual([P('create embassy 2').building.typeId, P('create embassy 2').at], [28, 2]);
  const codes = { a: 25, b: 2, be: 30, c: 1, e: 28, fh: 27, fo: 22, f: 7, s: 4, q: 5, i: 6, inn: 21, m: 23, r: 29, rs: 24, st: 20, t: 31, w: 32, wh: 3, ws: 26 };
  for (const [code, id] of Object.entries(codes)) assert.strictEqual(P('create ' + code).building.typeId, id, code);
  for (const [name, id] of [['beacon tower', 30], ['feasting hall', 27], ['iron mine', 6], ['rally spot', 29], ['relief station', 24], ['town hall', 31], ['house', 1], ['saw', 4]]) {
    assert.strictEqual(P('create ' + name).building.typeId, id, name);
  }
  assert.deepStrictEqual(P('create cottage @14 /nowait /speedup=consume.2.a'),
    { cmd: 'create', at: 14, policy: null, building: C.BUILDING_BY_ID[1], nowait: true, speedup: [{ kind: 'item', id: 'consume.2.a', name: 'Beginner Guidelines' }] });
  assert.match(parseErr('create'), /create: usage {2}create <type> \[plot\]/);
  assert.match(parseErr('create castle'), /unknown building "castle" — NEAT's a b be c e fh fo f s q i inn m r rs st t w wh ws/);
  assert.match(parseErr('create t 5'), /the Town Hall has its own place/);
  assert.match(parseErr('create cottage /fast'), /unknown switch \/fast — it takes \/speedup \/nowait/);
});

t('Build: OTTObot\'s build keeps its word; NEAT\'s build goal lines go to the goals', () => {
  assert.deepStrictEqual(P('build cottage at 12'), { cmd: 'build', at: 12, policy: null, quick: true, building: C.BUILDING_BY_ID[1] });
  for (const l of ['build feastinghall', 'build feasting_hall', 'build Feasting-Hall', 'build feasting hall', 'build fh']) assert.strictEqual(P(l).building.typeId, 27, l);
  for (const l of ['build barracks', 'build ironmine at 1005', 'build academy', 'build walls']) assert.strictEqual(P(l).cmd, 'build', l);
  for (const l of ['build b:9:15', 'build ?w:10?q:0:0,ws:0:0', 'build c:10:9', 'build c:0:8', 'build b:4:15,b:9:2',
    'build ?w:10?q:0:0,ws:0:0 w:10', 'build ?met:10,w:10?q:0:0,ws:0:0', 'build q:0:0,ws:0:0?w:10?', 'build ?i:4:0?s:9:40',
    'build inn:2:0', 'build i:5:0', 'build i:0:0']) {
    assert.deepStrictEqual([P(l).cmd, P(l).text], ['goal', l], l);
  }
  const page = 'build b:9:15\nbuild c:0:9\nbuild st:0:0\nbuild fo:0:0\nbuild ws:0:0\nbuild s:9:40\nbuild f:0:0\nbuild q:0:0\nbuild i:0:0';
  assert.deepStrictEqual(errs(page), []);
});

t('Upgrade: the examples, the level policies and their short forms, OTTObot\'s at N', () => {
  assert.deepStrictEqual([P('upgrade cottage').building.typeId, P('upgrade cottage').policy], [1, null]);
  assert.deepStrictEqual(P('upgrade barrack level8').policy, { kind: 'level', level: 8 });
  assert.deepStrictEqual(P('upgrade farm lowestlevel').policy, { kind: 'lowest', level: null });
  assert.strictEqual(P('upgrade iron').building.typeId, 6);
  assert.deepStrictEqual([P('upgrade iron level9').building.typeId, P('upgrade iron level9').policy], [6, { kind: 'level', level: 9 }]);
  assert.strictEqual(P('upgrade iron mine').building.typeId, 6, 'a two-word name');
  assert.deepStrictEqual(P('upgrade cottage !lowestlevel').policy, { kind: 'lowest', level: null }, 'the wiki\'s ! is its escape');
  assert.deepStrictEqual(P('upgrade cottage !highestlevel').policy, { kind: 'highest', level: null });
  assert.deepStrictEqual(P('upgrade c lo 5').policy, { kind: 'lowest', level: 5 });
  assert.deepStrictEqual(P('upgrade c hi').policy, { kind: 'highest', level: null });
  assert.deepStrictEqual(P('upgrade c le 9').policy, { kind: 'level', level: 9 });
  assert.deepStrictEqual(P('upgrade c highestlevel5').policy, { kind: 'highest', level: 5 });
  assert.deepStrictEqual([P('upgrade academy at 12').at, P('upgrade academy @12').at], [12, 12]);
  assert.deepStrictEqual(P('upgrade /speedup=consume.2.a cottage /nowait').speedup[0].id, 'consume.2.a');
  assert.match(parseErr('upgrade cottage level'), /level needs the level with it/);
  assert.match(parseErr('upgrade cottage level11'), /levels are 1 to 10/);
  assert.match(parseErr('upgrade cottage lowestlevel level9'), /one level policy per line/);
  assert.match(parseErr('upgrade cottage /dynamite'), /unknown switch \/dynamite/);
  const page = 'upgrade iron\nrepeat';
  assert.deepStrictEqual(errs(page), []);
});

t('Demo: every example, @plots, dynamite, and the page\'s repeat block', () => {
  assert.deepStrictEqual([P('demo cottage').building.typeId, P('demo cottage').policy], [1, null]);
  assert.deepStrictEqual(P('demo forge level10').policy, { kind: 'level', level: 10 });
  assert.deepStrictEqual([P('demo s highestlevel').building.typeId, P('demo s highestlevel').policy], [4, { kind: 'highest', level: null }]);
  assert.deepStrictEqual([P('demo /dynamite ws').building.typeId, P('demo /dynamite ws').dynamite], [26, true]);
  assert.deepStrictEqual([P('demo any @15').any, P('demo any @15').at], [true, 15]);
  assert.deepStrictEqual([P('demo b @20').building.typeId, P('demo b @20').at], [2, 20]);
  assert.deepStrictEqual([P('demo /dynamite any @13').any, P('demo /dynamite any @13').at, P('demo /dynamite any @13').dynamite], [true, 13, true]);
  assert.deepStrictEqual(P('demo cottage highestlevel 10').policy, { kind: 'highest', level: 10 });
  assert.deepStrictEqual(P('demo forge /nowait /speedup="Primary Guidelines,Beginner Guidelines"').speedup.map((s) => s.id), ['consume.2.b', 'consume.2.a']);
  assert.strictEqual(P('demolish cottage').cmd, 'demo');
  assert.deepStrictEqual(errs('demo c level10\nrepeat 5\ndemo c\nrepeat 45'), []);
  assert.match(parseErr('demo any'), /demo any: say which plot — demo any @15/);
});

t('DemoSite: both examples; the wiki\'s NPC plot table reads as plots', () => {
  assert.deepStrictEqual(P('demosite 36'), { cmd: 'demosite', at: 36, policy: null, any: true, anyLevel: true });
  assert.deepStrictEqual(P('demosite /dynamite 36'), { cmd: 'demosite', at: 36, policy: null, dynamite: true, any: true, anyLevel: true });
  for (const p of [0, 11, 31, 1001, 1040]) assert.strictEqual(P('demosite ' + p).at, p);
  assert.match(parseErr('demosite'), /demosite: usage {2}demosite \[\/dynamite\] <plot>/);
  assert.match(parseErr('demosite cottage'), /demosite: usage/);
});

t('Speedups: every example line; coins is refused while ALLOW_COINS_SPEEDUP is off', () => {
  assert.strictEqual(CITY.settings.allowCoins, false, 'the user kept coins off');
  assert.deepStrictEqual(P('upgrade cottage /speedup="Beginner Guidelines"').speedup, [{ kind: 'item', id: 'consume.2.a', name: 'Beginner Guidelines' }]);
  assert.deepStrictEqual(P('upgrade cottage /speedup=consume.2.a').speedup, [{ kind: 'item', id: 'consume.2.a', name: 'Beginner Guidelines' }]);
  assert.deepStrictEqual(P('demo forge /nowait /speedup="Primary Guidelines,Beginner Guidelines" // nowait is added').speedup.length, 2);
  assert.deepStrictEqual(P('buildingspeedup Senior Guidelines'), { cmd: 'buildingspeedup', at: null, items: [{ kind: 'item', id: 'consume.2.c', name: 'Senior Guidelines' }] });
  assert.deepStrictEqual(P('buildingspeedup @20 Beginner Guidelines').at, 20);
  assert.deepStrictEqual(P('researchspeedup Senior Guidelines').items[0].id, 'consume.2.c');
  for (const [w, id] of [['Intermediate Guidelines', 'consume.2.b.1'], ['Master Guidelines', 'consume.2.c.1'], ['Ultimate Guidelines', 'consume.2.d'], ['consume.2.d', 'consume.2.d'], ['free', 'free.speed']]) {
    assert.strictEqual(P('researchspeedup ' + w).items[0].id, id, w);
  }
  for (const l of ['upgrade /speedup=coins barrack', 'upgrade /speedup="Ultimate Guidelines,coins" barrack', 'researchspeedup coins',
    'buildingspeedup coins', 'startresearch compass /speedup=coins']) {
    assert.match(parseErr(l), /coins would spend cents \(the Instant Finish\) — scripts spend cents only through buyitem/, l);
  }
  // the page's example blocks, with coins taken out
  const blocks = ['r = city.getActiveResearch()', 'if r && TimeDiff(r.endTime)/1000 >= 8*3600 researchspeedup Senior Guidelines',
    'active = city.getActiveBuilding()', 'if active && TimeDiff(active.endTime)/1000 >= 8*3600 buildingspeedup Senior Guidelines',
    'pos = 20', 'b = city.getBuildingByPosId(pos)',
    'if b && b.status != 0 && TimeDiff(b.endTime)/1000 >= 10*60 execute "buildingspeedup @{pos} Beginner Guidelines"'].join('\n');
  assert.deepStrictEqual(errs(blocks), []);
  assert.match(errs('r = city.getActiveResearch()\nif r researchspeedup coins')[0], /coins would spend cents/);
  assert.match(parseErr('upgrade cottage /speedup'), /\/speedup needs the items/);
  assert.match(parseErr('researchspeedup Magic Guidelines'), /unknown speed-up "Magic Guidelines"/);
});

t('the coins switch on: coins reads as the Instant Finish', () => {
  CITY.settings.allowCoins = true;
  try {
    assert.deepStrictEqual(P('upgrade /speedup=coins barrack').speedup, [{ kind: 'coins', id: 'coins.speed', name: 'coins' }]);
    assert.deepStrictEqual(P('upgrade /speedup="Ultimate Guidelines,coins" barrack').speedup.map((s) => s.id), ['consume.2.d', 'coins.speed']);
    assert.strictEqual(P('researchspeedup coins').items[0].kind, 'coins');
  } finally { CITY.settings.allowCoins = false; }
});

t('StartResearch: the examples, every abbreviation, quickest/cheapest/dearest, /nowait', () => {
  assert.deepStrictEqual(P('startresearch compass'), { cmd: 'startresearch', tech: C.TECH_BY_ID[12], nowait: false });
  assert.deepStrictEqual(P('startresearch quickest'), { cmd: 'startresearch', pick: 'quickest', nowait: false });
  assert.strictEqual(P('startresearch construction').tech.typeId, 17);
  assert.strictEqual(P('startresearch dearest').pick, 'dearest');
  assert.strictEqual(P('startresearch cheapest /nowait').nowait, true);
  const abbr = { ag: 1, lu: 2, mas: 3, mi: 4, met: 5, in: 7, ms: 8, mt: 9, ir: 10, lo: 11, com: 12, ho: 13, ar: 14, st: 15, sp: 15, med: 16, con: 17, en: 18, mac: 19, pr: 20 };
  for (const [w, id] of Object.entries(abbr)) assert.strictEqual(P('startresearch ' + w).tech.typeId, id, w);
  assert.strictEqual(P('startresearch metal casting').tech.typeId, 5);
  assert.match(parseErr('startresearch alchemy'), /unknown tech "alchemy" — NEAT's ag lu mas/);
  assert.match(parseErr('startresearch'), /startresearch: usage/);
});

t('Research: research <tech> stays OTTObot\'s; research lo:5 and the conditions are the research goal', () => {
  assert.deepStrictEqual(P('research archery'), { cmd: 'research', tech: C.TECH_BY_ID[14] });
  assert.strictEqual(P('research military science').tech.typeId, 8);
  for (const l of ['research lo:5', 'research lo:5,ho:5,com:4', 'research ?a:10?pr:10']) {
    assert.deepStrictEqual([P(l).cmd, P(l).text, P(l).via], ['goal', l, 'research'], l);
  }
  // The wiki's `research ?ho:10?st:0:0` / `research st:0:0?ho:10?` demolish the
  // Stable from a research line. The research goal takes research:level only
  // (goal-research.js), so the line is refused where it is written, with the
  // build line to put it on — a script error like any other bad argument.
  for (const l of ['research ?ho:10?st:0:0', 'research st:0:0?ho:10?']) {
    assert.match(parseErr(l), /^research: "st:0:0" reads as a building target \(type:level:quantity\) — a research line takes research:level; put it on a build line \(build st:0:0\)$/, l);
    assert.strictEqual(script.parse(l)[0].cmd, 'error', l);
  }
  assert.deepStrictEqual([P('build ?ho:10?st:0:0').cmd, P('build ?ho:10?st:0:0').via], ['goal', 'build']);
});

t('CancelResearch, CheckResearch, CancelBuilding: bare words', () => {
  assert.deepStrictEqual(P('cancelresearch'), { cmd: 'cancelresearch' });
  assert.deepStrictEqual(P('checkresearch'), { cmd: 'checkresearch' });
  assert.deepStrictEqual(P('cancelbuilding'), { cmd: 'cancelbuilding', at: null });
  assert.deepStrictEqual(P('cancelbuilding @20'), { cmd: 'cancelbuilding', at: 20 });
  assert.match(parseErr('cancelresearch now'), /nothing goes after it/);
  assert.match(parseErr('checkresearch all'), /nothing goes after it/);
});

t('WallDefense: every line on the page, and OTTObot\'s wall', () => {
  const W = (code) => C.WALLS.find((x) => x.code === code);
  const it = (l) => P(l).items.map((x) => [x.wall.code, x.qty]);
  assert.deepStrictEqual([P('walldefense at 1000').action, it('walldefense at 1000')], ['build', [['tower', 1000]]]);
  assert.deepStrictEqual([P('walldefense ab 1000 demo').action, it('walldefense ab 1000 demo')], ['demo', [['abatis', 1000]]]);
  for (const l of ['walldefense at:5k,ab:1k,tra:1k demo', 'walldefense demo at:5k,ab:1k,tra:1k', 'walldefense /demo at:5k,ab:1k,tra:1k']) {
    assert.deepStrictEqual([P(l).action, it(l)], ['demo', [['tower', 5000], ['abatis', 1000], ['trap', 1000]]], l);
  }
  assert.deepStrictEqual([P('walldefense /keep at:15k,ab:1k,tra:1k').action, it('walldefense /keep at:15k,ab:1k,tra:1k')], ['keep', [['tower', 15000], ['abatis', 1000], ['trap', 1000]]]);
  assert.deepStrictEqual([P('walldefense').action, it('walldefense')], ['build', [['trap', 1]]]);
  for (const l of ['walldefense at 100', 'walldefense at:100', 'walldefense build at:100', 'walldefense /build at:100', 'walldefense at 100 produce']) {
    assert.deepStrictEqual([P(l).action, it(l)], ['build', [['tower', 100]]], l);
  }
  assert.deepStrictEqual([P('walldefense demo').action, it('walldefense demo')], ['demo', [['trap', 1]]]);
  assert.deepStrictEqual([P('walldefense destruct tra 10').action, it('walldefense destruct tra 10')], ['demo', [['trap', 10]]]);
  assert.deepStrictEqual([P('walldefense at demo').action, it('walldefense at demo')], ['demo', [['tower', 1]]]);
  assert.deepStrictEqual([P('walldefense at').action, it('walldefense at')], ['build', [['tower', 1]]]);
  assert.deepStrictEqual([P('walldefense at keep').action, it('walldefense at keep')], ['keep', [['tower', 1]]]);
  assert.deepStrictEqual([P('walldefense demo tra:100,at:10k').action, it('walldefense demo tra:100,at:10k')], ['demo', [['trap', 100], ['tower', 10000]]]);
  assert.deepStrictEqual([P('walldefense keep tra:100,at:1k').action, it('walldefense /keep tra:100,at:1k')], ['keep', [['trap', 100], ['tower', 1000]]]);
  assert.deepStrictEqual([P('walldefense /keep tre:0').action, it('walldefense /keep tre:0')], ['keep', [['rocks', 0]]]);
  assert.deepStrictEqual(it('walldefense r 50000 demo'), [['logs', 50000]]);
  assert.deepStrictEqual(it('walldefense tre 11k build'), [['rocks', 11000]]);
  assert.deepStrictEqual(P('wall abatis 1000'), { cmd: 'wall', wall: W('abatis'), amount: 1000 });
  assert.deepStrictEqual(P('walls tre 5k').wall, W('rocks'));
  assert.match(parseErr('walldefense demo keep at:1'), /one action per line/);
  assert.match(parseErr('walldefense zz:5'), /types are tra \(trap\), ab \(abatis\), at \(archer tower\), r \(rolling logs\), tre \(trebuchet\)/);
});

t('Train: every example, train help, and OTTObot\'s forms', () => {
  const a = C.BY_KEY.archer, w = C.BY_KEY.militia;
  assert.deepStrictEqual(P('train a:5000'), { cmd: 'train', neat: true, troop: a, amount: 5000, hero: null, barracks: 'all', min: null });
  assert.deepStrictEqual(P('train w:25000 atk'), { cmd: 'train', neat: true, troop: w, amount: 25000, hero: 'atk', barracks: 'all', min: null });
  assert.deepStrictEqual(P('train a:999999 ace idle 20000'), { cmd: 'train', neat: true, troop: a, amount: 999999, hero: 'ace', barracks: 'idle', min: 20000 });
  assert.deepStrictEqual(P('train w:25000 atk 18 25000'), { cmd: 'train', neat: true, troop: w, amount: 25000, hero: 'atk', barracks: 18, min: 25000 });
  assert.deepStrictEqual(P('train arch:2500 Ken'), { cmd: 'train', neat: true, troop: a, amount: 2500, hero: 'Ken', barracks: 'all', min: null });
  assert.deepStrictEqual(P('train help'), { cmd: 'train', help: true });
  assert.deepStrictEqual(P('train a 10k'), { cmd: 'train', troop: a, amount: 10000 });
  assert.deepStrictEqual(P('train arch 2500'), { cmd: 'train', troop: a, amount: 2500 });
  assert.match(parseErr('train a:5000,w:100'), /troop types cannot be combined/);
  assert.match(parseErr('train a:5000 20000'), /20000 is no barracks plot \(0-31\) — to give a minimum, name the barracks first/);
  assert.match(parseErr('train a:500 any all 1000'), /the minimum \(1,000\) is more than the 500 asked for/);
  assert.match(parseErr('train a 10k Ken'), /for a hero or barracks write NEAT's form: train a:10k atk idle/);
});

t('Disband, DumpTroop, HealTroops', () => {
  assert.deepStrictEqual(P('disband w:25k'), { cmd: 'disband', keep: false, troops: { militia: 25000 } });
  assert.deepStrictEqual(P('disband /keep w:25k'), { cmd: 'disband', keep: true, troops: { militia: 25000 } });
  assert.deepStrictEqual(P('dumptroop 111,222 a:99000,s:50000 a:20000,s:15000'),
    { cmd: 'dumptroop', target: { x: 111, y: 222 }, when: { archer: 99000, scouter: 50000 }, send: { archer: 20000, scouter: 15000 } });
  assert.deepStrictEqual(P('healtroops'), { cmd: 'healtroops' });
  assert.match(parseErr('disband'), /disband: which troops\?/);
  assert.match(parseErr('dumptroop 111,222 a:1'), /give two troop strings/);
  assert.match(parseErr('healtroops all'), /nothing goes after it/);
});

t('Comfort, Levy, Production, SetTaxRate: every example; comfort and levy are this module\'s words', () => {
  for (const [l, type, typeId] of [['comfort pray', 'pray', 2], ['comfort 1', 'relief', 1], ['comfort bless', 'bless', 3], ['comfort 4', 'popraise', 4],
    ['comfort relief', 'relief', 1], ['comfort popraise', 'popraise', 4], ['comfort 2', 'pray', 2], ['comfort 3', 'bless', 3]]) {
    assert.deepStrictEqual(P(l), { cmd: 'comfort', type, typeId }, l);
  }
  for (const [l, type, typeId] of [['levy 1', 'gold', 1], ['levy food', 'food', 2], ['levy 3', 'wood', 3], ['levy stone', 'stone', 4], ['levy 5', 'iron', 5], ['levy gold', 'gold', 1]]) {
    assert.deepStrictEqual(P(l), { cmd: 'levy', type, typeId }, l);
  }
  assert.deepStrictEqual(P('production 100 100 100 100'), { cmd: 'production', rates: { food: 100, wood: 100, stone: 100, iron: 100 } });
  assert.deepStrictEqual(P('produce 0 50% 0 0').rates.wood, 50);
  assert.deepStrictEqual(P('settaxrate 20'), { cmd: 'tax', rate: 20 });
  assert.deepStrictEqual(P('tax 20'), { cmd: 'tax', rate: 20 });
  assert.match(parseErr('comfort'), /comfort: usage {2}comfort <1-4 \| relief \| pray \| bless \| popraise>/);
  assert.match(parseErr('comfort 5'), /comfort: usage/);
  assert.match(parseErr('levy 6'), /levy: usage {2}levy <1-5/);
  assert.match(parseErr('settaxrate 101'), /settaxrate: usage {2}settaxrate <0-100>/);
  // the goals branch reads a bare `comfort pray` as config comfort:pray: these words must be commands
  for (const word of ['comfort', 'levy', 'healtroops', 'settaxrate']) {
    assert.ok(CITY.commands[word] || Object.values(CITY.commands).some((s) => (s.aliases || []).includes(word)), word);
  }
  assert.notStrictEqual(script.parse('comfort pray')[0].cmd, 'goal');
});

t('RenameCity: both examples (the wiki\'s ! is its escape); the length is judged when it runs', () => {
  assert.deepStrictEqual(P('renamecity !BottingRulz'), { cmd: 'renamecity', name: 'BottingRulz', picture: null });
  assert.deepStrictEqual(P('renamecity !BottingRulz 3'), { cmd: 'renamecity', name: 'BottingRulz', picture: 3 });
  assert.deepStrictEqual(P('renamecity "New Home"'), { cmd: 'renamecity', name: 'New Home', picture: null });
  assert.match(parseErr('renamecity New Home'), /the picture is 1, 2, 3 or 4, not "Home" — a name with spaces goes in quotes/);
  assert.match(parseErr('renamecity'), /renamecity: usage/);
});

// abandontown is off unless the console starts with OTTO_ALLOW_ABANDON_TOWN=1;
// the tests that run it switch it on for their own lines only.
const withAbandon = async (f) => {
  const was = CITY.settings.allowAbandonTown;
  CITY.settings.allowAbandonTown = true;
  try { return await f(); } finally { CITY.settings.allowAbandonTown = was; }
};

t('AbandonTown is off unless the console was started with OTTO_ALLOW_ABANDON_TOWN=1, however the line is made', async () => {
  assert.strictEqual(CITY.settings.allowAbandonTown, process.env.OTTO_ALLOW_ABANDON_TOWN === '1');
  const was = CITY.settings.allowAbandonTown;
  CITY.settings.allowAbandonTown = false;
  try {
    for (const l of ['abandontown 111,222 confirm', 'abandontown Fla confirm anyway', 'abandontown Fla']) {
      assert.match(parseErr(l), /abandontown is off in this console: .* started with OTTO_ALLOW_ABANDON_TOWN=1/, l);
    }
    assert.match(errs('set t Empty\nabandontown %t% confirm')[0], /abandontown is off in this console/);
    // built while the script runs (execute, {expr}): refused then, and nothing goes out
    const w = world();
    w.g.c.passwordHash = () => 'HASH';
    const r = await runIn(w, 'x = "Fla"\nexecute "abandontown " + x + " confirm anyway"' + SEE
      + '\nwd = "con" + "firm"\nabandontown Empty {wd}' + SEE, { session: { account: { id: 'a1' } } });
    assert.deepStrictEqual(only(w, 'city.giveupCastle'), []);
    assert.strictEqual(r.seen.length, 2);
    for (const [e] of r.seen) assert.match(e, /abandontown is off in this console/);
  } finally { CITY.settings.allowAbandonTown = was; }
});

t('Abandon, AbandonTown, EvacuateTown: NEAT\'s lines, and the extra word a whole town needs', () => withAbandon(() => {
  assert.deepStrictEqual(P('abandon 111,222'), { cmd: 'abandon', target: { x: 111, y: 222 } });
  assert.match(parseErr('abandontown 111,222'), /this gives 111,222 up for good — heroes and troops in it or marching from it are lost\. To do it, end the line with the word confirm: abandontown 111,222 confirm/);
  assert.match(parseErr('abandontown !OtherCity'), /end the line with the word confirm: abandontown !OtherCity confirm/);
  assert.deepStrictEqual(P('abandontown 111,222 confirm'), { cmd: 'abandontown', ref: { xy: { x: 111, y: 222 } }, anyway: false });
  assert.deepStrictEqual(P('abandontown !OtherCity confirm anyway'), { cmd: 'abandontown', ref: { name: '!OtherCity' }, anyway: true });
  assert.deepStrictEqual(P('abandontown "Home City" confirm').ref, { name: 'Home City' });
  assert.match(parseErr('evacuatetown 111,222'), /sends every troop in the city, with all the resources they can carry, to 111,222 \(heroes stay\)\. To do it, end the line with the word confirm/);
  assert.deepStrictEqual(P('evacuatetown 111,222 confirm'), { cmd: 'evacuatetown', target: { x: 111, y: 222 } });
  assert.deepStrictEqual(P('endevacuate'), { cmd: 'endevacuate', target: null });
  assert.deepStrictEqual(P('endevacuate 111,222'), { cmd: 'endevacuate', target: { x: 111, y: 222 } });
  assert.match(parseErr('abandon 900,1'), /off the map/);
  assert.match(parseErr('abandon Home'), /abandon: usage {2}abandon 111,222/);
}));

t('AbandonAllValleys: both example scripts read whole', () => {
  const one = 'label abandonAllValleys\nif city.fields.length = 0 goto done\nexecute "abandon " + city.fields[0].coords\nif !$error goto abandonAllValleys\n\nlabel done';
  const all = ['cs = cities.concat()', 'label nextcity', 'c = cs.shift()', 'if c fs = c.cityManager.fields.toArray()', 'label nextfield',
    'if c f = fs.shift()', 'if c if f execute "abandon " + f.coords', 'if c if f if !$error goto nextfield', 'if c goto nextcity', 'echo "Finished"'].join('\n');
  assert.deepStrictEqual(errs(one), []);
  assert.deepStrictEqual(errs(all), []);
});

t('BuildCity, CancelBuildcity, Teleport, WarTeleport, AutoTeleporter, the queue cancels', () => {
  assert.deepStrictEqual(P('buildcity 111,222'), { cmd: 'buildcity', target: { x: 111, y: 222 }, hero: null, troops: null });
  assert.deepStrictEqual(P('newcity 111,222 Ken a:200'), { cmd: 'buildcity', target: { x: 111, y: 222 }, hero: 'Ken', troops: { archer: 200 } });
  assert.deepStrictEqual(P('cancelbuildcity'), { cmd: 'cancelbuildcity', target: null });
  assert.deepStrictEqual(P('cancelbuildcity 123,456'), { cmd: 'cancelbuildcity', target: { x: 123, y: 456 } });
  assert.deepStrictEqual([P('teleport saxony').kind, P('teleport saxony').zone], ['state', 'Saxony']);
  assert.deepStrictEqual([P('teleport 111,222').kind, P('teleport 111,222').target], ['adv', { x: 111, y: 222 }]);
  assert.deepStrictEqual([P('teleport random').kind, P('teleport random').zone], ['state', null]);
  assert.deepStrictEqual([P('warteleport 123,45').kind, P('warteleport 123,456').target], ['war', { x: 123, y: 456 }]);
  for (const s of C.ZONES) assert.strictEqual(P('teleport ' + s.toLowerCase()).zone, s, s);
  assert.deepStrictEqual(P('autoteleport tuscany all confirm /tries=3 /every=1:00'), { cmd: 'autoteleport', zone: 'Tuscany', random: false, all: true, tries: 3, every: 60, norecall: false });
  assert.match(parseErr('autoteleport tuscany all'), /"all" recalls every city's armies and spends a City Teleporter on each city not there yet — end the line with confirm to mean it: autoteleport tuscany all confirm/);
  assert.match(parseErr('autoteleport all'), /autoteleport tuscany all confirm/);
  assert.match(parseErr('autoteleport tuscany confirm'), /confirm goes with all/);
  assert.deepStrictEqual(P('autoteleport'), { cmd: 'autoteleport', zone: null, random: false, all: false, tries: 5, every: 300, norecall: false });
  assert.match(parseErr('autoteleport atlantis'), /"atlantis" is no state/);
  assert.deepStrictEqual([P('canceltroopqueues').cmd, P('canceltroopqueues 2').cmd, P('cancelfortifications').cmd, P('cancelfortifications 2').cmd],
    ['cancelqueue', 'cancelqueue', 'cancelqueue', 'cancelqueue']);
});

t('the AutoTeleporter page\'s script reads whole', () => {
  assert.deepStrictEqual(errs(AUTO_TELEPORTER), []);
});

// ---------------------------------------------------------------------------
section('create, build, upgrade');

t('create cottage: the first free plot, the free speed-up (75 s preset), and the line waits for it', async () => {
  const w = world();
  const r = await runIn(w, 'create cottage' + SEE);
  assert.deepStrictEqual(writes(w).map((s) => [s.cmd, s.data.positionId, s.data.buildingType ?? s.data.itemId]),
    [['castle.newBuilding', 2, 1], ['castle.speedUpBuildCommand', 2, 'free.speed']]);
  assert.match(r.text, /build Cottage \(type 1\) at position 2/);
  assert.match(r.text, /free speed-up \(preset time 1m 15s\) -> ok/);
  assert.deepStrictEqual(last(r), [null, 2], '$result is the plot');
  assert.deepStrictEqual(w.home.buildings.find((b) => b.positionId === 2), { ...B(1, 2, 1), startTime: w.home.buildings.find((b) => b.positionId === 2).startTime, endTime: 0 });
});

t('create fo / create barrack: new ones on free plots, each finished free (180 s / 300 s presets)', async () => {
  const w = world({ jobMs: 1000 });
  const r = await runIn(w, 'create fo' + SEE + '\ncreate barrack' + SEE);
  assert.deepStrictEqual(writes(w).map((s) => [s.cmd, s.data.positionId, s.data.buildingType ?? s.data.itemId]),
    [['castle.newBuilding', 2, 22], ['castle.speedUpBuildCommand', 2, 'free.speed'], ['castle.newBuilding', 3, 2], ['castle.speedUpBuildCommand', 3, 'free.speed']]);
  assert.deepStrictEqual(r.seen, [[null, 2], [null, 3]]);
});

t('create a 0 / create embassy 2: the plot given; an academy has no free finish, so the line waits for the job', async () => {
  const w = world({ jobMs: 30 });
  w.home.buildings = w.home.buildings.filter((b) => b.positionId !== 0);
  const t0 = Date.now();
  const r = await runIn(w, 'create a 0' + SEE + '\ncreate embassy 2' + SEE);
  assert.ok(Date.now() - t0 >= 55, 'both lines waited for their job');
  assert.deepStrictEqual(only(w, 'castle.newBuilding').map((d) => [d.positionId, d.buildingType]), [[0, 25], [2, 28]]);
  assert.ok(!cmds(w).includes('castle.speedUpBuildCommand'));
  assert.match(r.text, /waiting for it to finish \(\d+s; \/nowait skips this\)/);
  assert.deepStrictEqual(r.seen, [[null, 0], [null, 2]]);
  assert.strictEqual(w.home.buildings.find((b) => b.positionId === 2).level, 1);
});

t('create ... /nowait goes on at once; a taken plot or a missing prerequisite is refused before anything is sent', async () => {
  let w = world({ jobMs: 500 });
  const t0 = Date.now();
  let r = await runIn(w, 'create embassy 2 /nowait' + SEE);
  assert.ok(Date.now() - t0 < 300);
  assert.deepStrictEqual(last(r), [null, 2]);
  w = world();
  r = await runIn(w, 'create embassy 12' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'plot 12 is taken: Cottage on plot 12 (level 3)');
  w = world({ newCond: () => cost({ buildings: [{ typeId: 31, level: 9, curLevel: 8, successFlag: false }], techs: [{ id: 17, level: 2, curLevel: 1, successFlag: false }] }) });
  r = await runIn(w, 'create embassy' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'BLOCKED - needs Town Hall level 9 (you have 8); Construction level 2 (you have 1)');
});

t('create waits while the builder is busy (NEAT: "sleep until that construction is done")', async () => {
  const w = world({ jobMs: 40 });
  w.start(w.home, 12, 'up');                       // cottage 3 -> 4 under way
  const r = await runIn(w, 'create embassy 2 /nowait' + SEE);
  assert.match(r.text, /the builder is busy \(Cottage on plot 12, L3->L4, \d+s left\) — waiting for it/);
  assert.strictEqual(w.home.buildings.find((b) => b.positionId === 12).level, 4, 'the job ended before the new one went in');
  assert.deepStrictEqual(only(w, 'castle.newBuilding').map((d) => d.positionId), [2]);
});

t('create waits for resources that are coming in, and refuses ones that never will', async () => {
  let w = world({ newCond: () => cost({ wood: 150 }) });
  Object.assign(w.home.resource.wood, { amount: 100, increaseRate: 1800000 });     // 50 more wood in 0.1 s
  setTimeout(() => { w.home.resource.wood.amount = 200; }, 30);
  let r = await runIn(w, 'create embassy 2 /nowait' + SEE);
  assert.match(r.text, /short of wood 150 \(have 100\) — waiting about 0s for it/);
  assert.deepStrictEqual(only(w, 'castle.newBuilding').length, 1);
  w = world({ res: { gold: 10 }, newCond: () => cost({ gold: 5000 }) });
  r = await runIn(w, 'create embassy 2' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'short of gold 5,000 (have 10)');
  w = world({ res: { pop: 100, work: 90 }, newCond: () => cost({ population: 50 }) });
  r = await runIn(w, 'create embassy 2' + SEE);
  assert.strictEqual(last(r)[0], 'short of idle population 50 (have 10) — and idle population is not going up');
});

t('create with no free plot looks again, and builds once one frees', async () => {
  const w = world();
  const full = []; for (let p = 0; p <= 31; p++) if (!w.home.buildings.some((b) => b.positionId === p)) full.push(B(1, p, 1));
  w.home.buildings.push(...full);
  setTimeout(() => { w.home.buildings = w.home.buildings.filter((b) => b.positionId !== 5); }, 30);
  const r = await runIn(w, 'create embassy /nowait' + SEE);
  assert.match(r.text, /no free city plot — looking again every/);
  assert.deepStrictEqual(only(w, 'castle.newBuilding').map((d) => d.positionId), [5]);
  const w2 = world();
  w2.home.buildings.push(...full);
  const r2 = await runIn(w2, 'create embassy' + SEE);
  assert.strictEqual(last(r2)[0], 'no free city plot');
});

t('build cottage at 12 (OTTObot\'s): sent at once, no waiting; its old messages and $result stay', async () => {
  let w = world({ jobMs: 500 });
  const t0 = Date.now();
  let r = await runIn(w, 'build embassy at 2' + SEE);
  assert.ok(Date.now() - t0 < 300, 'no wait for the job');
  assert.deepStrictEqual(only(w, 'castle.newBuilding'), [{ castleId: 1, positionId: 2, buildingType: 28 }]);
  assert.match(r.text, /Embassy: costs wood 200, stone 300, iron 50, food 100, 600s\n {2}build Embassy \(type 28\) at position 2\n {2}-> ok/);
  assert.strictEqual(last(r)[0], null);
  assert.match(last(r)[1], /build Embassy \(type 28\) at position 2/, '$result: what it logged, as before');
  w = world({ jobMs: 500 });
  w.start(w.home, 12, 'up');
  r = await runIn(w, 'build cottage' + SEE);
  assert.doesNotMatch(r.text, /builder is busy/, 'build never waits for the builder');
  assert.deepStrictEqual(only(w, 'castle.newBuilding').map((d) => d.positionId), [2]);
  assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand').map((d) => d.itemId), ['free.speed'], 'a cottage still gets its free finish');
});

t('build c:10:9 and research lo:5 go to the goal layer, not to the server', async () => {
  const w = world();
  const added = [];
  const GL = { SCRIPT_MAX_LINES: 100, addScriptLine: (a, c, line) => { added.push([c, line]); return { errors: [], lines: [], layer: null }; }, getScriptLayer: () => null };
  const r = await runIn(w, 'build c:10:9' + SEE + '\nbuild ?w:10?q:0:0,ws:0:0' + SEE + '\nresearch lo:5,ho:5,com:4' + SEE, { goalLayers: GL });
  assert.deepStrictEqual(added, [[1, 'build c:10:9'], [1, 'build ?w:10?q:0:0,ws:0:0'], [1, 'research lo:5,ho:5,com:4']]);
  assert.deepStrictEqual(w.sent, []);
  assert.ok(r.seen.every((s) => s[0] === null));
});

t('build with autoReq queues an existing prerequisite one level (the legacy page), as before', async () => {
  const w = world({ newCond: () => cost({ buildings: [{ typeId: 31, level: 9, curLevel: 8, successFlag: false }] }) });
  const r = await runIn(w, 'build embassy' + SEE, { autoReq: true });
  assert.deepStrictEqual(only(w, 'castle.upgradeBuilding'), [{ castleId: 1, positionId: -1 }]);
  assert.match(r.text, /queued upgrade of Town Hall \(pos -1\) -> ok\n {4}prerequisite queued - re-run this line once it finishes/);
  assert.strictEqual(last(r)[0], 'BLOCKED - needs Town Hall level 9 (you have 8)');
});

t('upgrade iron + repeat takes every iron mine to 9 and stops there (the Upgrade page)', async () => {
  const w = world({ jobMs: 4 });
  const r = await runIn(w, 'upgrade iron\nrepeat\necho "after"');
  assert.deepStrictEqual(w.home.buildings.filter((b) => b.typeId === 6).map((b) => b.level).sort(), [9, 9]);
  assert.strictEqual(only(w, 'castle.upgradeBuilding').length, 2, '7 -> 9 on plot 1040; the other was 9 already');
  assert.match(r.text, /every Ironmine is at level 9 or higher \(9, 9\) — upgrade ironmine level9 takes one to 10 with a Michelangelo's Script/);
  assert.match(r.text, /repeat ends — line 1 did not go through/);
  assert.match(r.text, / {2}after/);
});

t('upgrade iron level9: a level-9 one to 10, spending a Michelangelo\'s Script that is held', async () => {
  const w = world({ items: { [SCRIPT]: 2 } });
  const r = await runIn(w, 'upgrade iron level9' + SEE);
  assert.deepStrictEqual(only(w, 'castle.upgradeBuilding'), [{ castleId: 1, positionId: 1004 }]);
  assert.match(r.text, /Ironmine on plot 1004 \(level 9\) -> 10 spends a Michelangelo's Script \(2 held\)/);
  assert.strictEqual(w.home.buildings.find((b) => b.positionId === 1004).level, 10);
  assert.strictEqual(last(r)[0], null);
});

t('upgrade never takes a 9 to 10 without level9/level10/highestlevel, nor without a Script held', async () => {
  let w = world({ items: { [SCRIPT]: 5 } });
  let r = await runIn(w, 'upgrade cottage at 13' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'Cottage on plot 13 (level 9) would go to 10, which spends a Michelangelo\'s Script — write level9, level10 or highestlevel on the line to allow it');
  w = world({ items: {} });
  r = await runIn(w, 'upgrade cottage level9' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.match(last(r)[0], /needs a Michelangelo's Script \(consume\.blueprint\.1\) to reach 10 — none held, and it is never bought/);
  // inventory never loaded: the game's own check must say one is there
  w = world({ items: null });
  r = await runIn(w, 'upgrade cottage level10' + SEE);
  assert.deepStrictEqual(only(w, 'castle.upgradeBuilding'), [{ castleId: 1, positionId: 13 }]);
  w = world({ items: null, upCond: (c) => ({ ...c, items: [] }) });
  r = await runIn(w, 'upgrade cottage level10' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.match(last(r)[0], /neither the inventory nor the game's check says one is held — not sent/);
  w = world();
  r = await runIn(w, 'upgrade cottage at 14' + SEE);
  assert.strictEqual(last(r)[0], 'Cottage on plot 14 (level 10) is at the top level');
});

t('upgrade policies: level8 picks a level-8 one, lowestlevel the lowest, highestlevel the highest below 10', async () => {
  let w = world({ items: { [SCRIPT]: 1 } });
  await runIn(w, 'upgrade barrack level8\nupgrade farm lowestlevel\nupgrade s highestlevel\nupgrade c hi 5\nupgrade c lo');
  assert.deepStrictEqual(only(w, 'castle.upgradeBuilding').map((d) => d.positionId), [21, 1001, 1003, 12, 15]);
  w = world();
  const r = await runIn(w, 'upgrade barrack level9' + SEE);
  assert.strictEqual(last(r)[0], 'no Barracks at level 9 to upgrade (levels 5, 6, 7, 8)');
});

t('upgrade waits for the builder, then picks again (the busy one may be done by then)', async () => {
  const w = world({ jobMs: 30 });
  w.start(w.home, 1001, 'up');                     // the farm at 2 -> 3
  const r = await runIn(w, 'upgrade farm lowestlevel /nowait' + SEE);
  assert.match(r.text, /the builder is busy \(Farm on plot 1001, L2->L3/);
  assert.deepStrictEqual(only(w, 'castle.upgradeBuilding').map((d) => d.positionId), [1001], 'still the lowest farm, now at 3');
});

// The console reconnects while a line waits: the order goes out on the
// session's new Game (same lord), never on the old one, whose socket is closed.
async function reconnectMidWait(src, { lord = 'Tester', setup = (w) => w.start(w.home, 11, 'up') } = {}) {
  const w1 = world({ jobMs: 120 });
  const w2 = world({ jobMs: 5 });
  w2.g.player.playerInfo.userName = lord;
  setup(w1);
  const session = { connected: true, game: w1.g, account: { id: 'a1' } };
  const swap = setTimeout(() => { session.game = w2.g; }, 30);
  let r;
  try { r = await runIn(w1, src + SEE, { session, keepTimers: true }); } finally { clearTimeout(swap); w1.close(); w2.close(); }
  return { r, old: writes(w1).map((s) => s.cmd), now: writes(w2).map((s) => s.cmd) };
}

t('a reconnect during create / upgrade / demo / startresearch\'s wait: the order goes out on the new connection', async () => {
  for (const [src, cmd] of [['upgrade farm /nowait', 'castle.upgradeBuilding'], ['create embassy 2 /nowait', 'castle.newBuilding'],
    ['demo cottage /nowait', 'castle.destructBuilding']]) {
    const x = await reconnectMidWait(src);
    assert.match(x.r.text, /the builder is busy/, src);
    assert.deepStrictEqual(x.old, [], `${src}: nothing on the old connection`);
    assert.ok(x.now.includes(cmd), `${src}: ${x.now.join(', ')}`);
  }
  // a research under way in the city, then startresearch waits for it
  const x = await reconnectMidWait('startresearch informatics /nowait', {
    setup: (w) => { const b = w.research.get(1).find((t2) => t2.typeId === 12); Object.assign(b, { upgradeing: true, castleId: 1, endTime: w.g.now() + 60 }); },
  });
  assert.deepStrictEqual(x.old, []);
  assert.ok(x.now.includes('tech.research'), x.now.join(', '));
  // another lord on the console: never sent there
  const y = await reconnectMidWait('upgrade farm /nowait', { lord: 'SomeoneElse' });
  assert.deepStrictEqual(y.now, [], 'nothing on another lord\'s connection');
});

t('upgrade with a check-out refusal or an unmet prerequisite says why and sends nothing', async () => {
  let w = world({ replies: { 'castle.checkOutUpgrade': { ok: -5, errorMsg: 'building busy' } } });
  let r = await runIn(w, 'upgrade farm' + SEE);
  assert.strictEqual(last(r)[0], 'BLOCKED - FAILED (ok=-5) - building busy');
  w = world({ upCond: (c) => ({ ...c, buildings: [{ typeId: 31, level: 9, curLevel: 8, successFlag: false }] }) });
  r = await runIn(w, 'upgrade farm' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'BLOCKED - needs Town Hall level 9 (you have 8)');
});

// ---------------------------------------------------------------------------
section('speed-ups');

t('upgrade barrack /speedup="Beginner Guidelines": a held item goes in, and the job is done', async () => {
  const w = world({ items: { 'consume.2.a': 3 }, jobMs: 1000 });
  const t0 = Date.now();
  const r = await runIn(w, 'upgrade barrack /speedup="Beginner Guidelines"' + SEE);
  assert.ok(Date.now() - t0 < 600);
  assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand'), [{ castleId: 1, positionId: 11, itemId: 'consume.2.a' }]);
  assert.match(r.text, /speed up Barracks on plot 11 with Beginner Guidelines -> ok/);
  assert.strictEqual(w.home.buildings.find((b) => b.positionId === 11).level, 6);
  assert.strictEqual(last(r)[0], null);
});

t('a job the game finishes free takes the free speed-up first, and the item is then not needed', async () => {
  const w = world({ items: { 'consume.2.a': 3 }, jobMs: 1000 });
  const r = await runIn(w, 'upgrade cottage /speedup="Beginner Guidelines"' + SEE);
  assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand').map((d) => d.itemId), ['free.speed'], 'cottage 1 -> 2 is 150 s');
  assert.match(r.text, /Cottage on plot 15 is finished — Beginner Guidelines not needed/);
});

t('a speed-up item not held, or an inventory never loaded, is never sent (the game would buy it with cents)', async () => {
  let w = world({ items: {}, jobMs: 20 });
  let r = await runIn(w, 'upgrade barrack /speedup=consume.2.c' + SEE);
  assert.ok(!cmds(w).includes('castle.speedUpBuildCommand'));
  assert.match(r.text, /no Senior Guidelines held \(consume\.2\.c\) — not sent: it is never bought/);
  assert.strictEqual(last(r)[0], null, 'the upgrade itself went through');
  w = world({ items: null, jobMs: 20 });
  r = await runIn(w, 'upgrade barrack /speedup=consume.2.c' + SEE);
  assert.ok(!cmds(w).includes('castle.speedUpBuildCommand'));
  assert.match(r.text, /the inventory is not loaded, so whether a Senior Guidelines is held cannot be checked — not sent \(the game buys a missing one with cents\)/);
});

t('items used this run count off before the inventory push lands: one held goes once', async () => {
  const w = world({ items: { 'consume.2.a': 1 }, itemFinishes: false, push: false, jobMs: 1000 });
  const r = await runIn(w, 'upgrade barrack /nowait /speedup="Beginner Guidelines,Beginner Guidelines"' + SEE);
  assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand').map((d) => d.itemId), ['consume.2.a']);
  assert.match(r.text, /no Beginner Guidelines held \(consume\.2\.a\) — not sent/);
  // once the push lands the list is right again
  const w2 = world({ items: { 'consume.2.a': 2 }, itemFinishes: false, jobMs: 1000 });
  await runIn(w2, 'upgrade barrack /nowait /speedup="Beginner Guidelines,Beginner Guidelines,Beginner Guidelines"');
  assert.deepStrictEqual(only(w2, 'castle.speedUpBuildCommand').map((d) => d.itemId), ['consume.2.a', 'consume.2.a']);
});

t('buildingspeedup Senior Guidelines / buildingspeedup @20 ...: what is under way now', async () => {
  let w = world({ items: { 'consume.2.c': 1, 'consume.2.a': 1 }, jobMs: 1000 });
  w.start(w.home, 20, 'up');
  let r = await runIn(w, 'buildingspeedup Senior Guidelines' + SEE);
  assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand'), [{ castleId: 1, positionId: 20, itemId: 'consume.2.c' }]);
  assert.deepStrictEqual(last(r), [null, 1]);
  w = world({ items: { 'consume.2.a': 1 }, jobMs: 1000 });
  w.start(w.home, 20, 'up');
  r = await runIn(w, 'pos = 20\nb = city.getBuildingByPosId(pos)\nif b && b.status != 0 execute "buildingspeedup @{pos} Beginner Guidelines"' + SEE);
  assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand').map((d) => [d.positionId, d.itemId]), [[20, 'consume.2.a']]);
  w = world({ items: { 'consume.2.c': 1 } });
  r = await runIn(w, 'buildingspeedup Senior Guidelines' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'nothing is under construction in Home');
  w = world({ items: {}, jobMs: 1000 });
  w.start(w.home, 20, 'up');
  r = await runIn(w, 'buildingspeedup Senior Guidelines' + SEE);
  assert.match(last(r)[0], /no Senior Guidelines held/);
});

t('buildingspeedup free: only a job the game finishes free (5 minutes\' preset or less, not a demolition)', async () => {
  let w = world({ jobMs: 1000 });
  w.start(w.home, 15, 'up');                       // cottage 1 -> 2: 150 s
  let r = await runIn(w, 'buildingspeedup free' + SEE);
  assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand').map((d) => [d.positionId, d.itemId]), [[15, 'free.speed']]);
  assert.deepStrictEqual(last(r), [null, 1]);
  w = world({ jobMs: 1000 });
  w.start(w.home, 20, 'up');                       // barracks 7 -> 8
  r = await runIn(w, 'buildingspeedup free' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'the free speed-up is only for a job of 5m or less (not a demolition) — not sent');
  w = world({ jobMs: 1000 });
  w.start(w.home, 15, 'down');
  r = await runIn(w, 'buildingspeedup free' + SEE);
  assert.deepStrictEqual(writes(w), []);
});

t('coins while the switch is off: a script with it never loads; with it on the price is read and logged first', async () => {
  assert.match(errs('echo "a"\nupgrade /speedup=coins barrack')[0], /scripts spend cents only through buyitem/);
  assert.match(script.lineStatus('buildingspeedup coins').lines[0].msg, /coins would spend cents/);
  CITY.settings.allowCoins = true;
  try {
    let w = world({ jobMs: 1000 });
    let r = await runIn(w, 'upgrade /speedup=coins barrack' + SEE);
    assert.deepStrictEqual(cmds(w).filter((c) => /Coins|speedUp/.test(c)), ['castle.getCoinsNeed', 'castle.speedUpBuildCommand']);
    assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand').map((d) => d.itemId), ['coins.speed']);
    assert.match(r.text, /finishing Barracks on plot 11 with coins spends 42 cents/);
    w = world({ jobMs: 1000 });
    r = await runIn(w, 'upgrade /speedup=coins barrack', { dryRun: true });
    assert.deepStrictEqual(writes(w), []);
    assert.match(r.text, /finishing Barracks on plot 11 with coins spends 42 cents\n {2}speed up Barracks on plot 11 with coins — \[dry run\] not sent/);
    w = world({ jobMs: 1000 });
    w.start(w.home, 20, 'up');
    r = await runIn(w, 'buildingspeedup coins' + SEE);
    assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand').map((d) => d.itemId), ['coins.speed']);
    // "upgrade barrack by first applying Ultimate Guidelines and then finish using coins"
    w = world({ items: { 'consume.2.d': 1 }, itemFinishes: false, jobMs: 1000 });
    r = await runIn(w, 'upgrade /speedup="Ultimate Guidelines,coins" barrack' + SEE);
    assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand').map((d) => d.itemId), ['consume.2.d', 'coins.speed']);
    assert.strictEqual(w.home.buildings.find((b) => b.positionId === 11).level, 6);
    // researchspeedup coins: tech.getCoinsNeed first
    w = world({ jobMs: 1000 });
    await w.g.req('tech.research', { castleId: 1, techId: 12 });
    r = await runIn(w, 'r = city.getActiveResearch()\nif r researchspeedup coins' + SEE);
    assert.deepStrictEqual(cmds(w).slice(1).filter((c) => !/getResearchList/.test(c)), ['tech.getCoinsNeed', 'tech.speedUpResearch']);
    assert.match(r.text, /finishing Compass research with coins spends 17 cents/);
  } finally { CITY.settings.allowCoins = false; }
});

t('the Speedups page\'s research block: Senior Guidelines only while 8 hours or more are left', async () => {
  const block = 'r = city.getActiveResearch()\nif r && TimeDiff(r.endTime)/1000 >= 8*3600 researchspeedup Senior Guidelines';
  let w = world({ items: { 'consume.2.c': 1 }, jobMs: 9 * 3600 * 1000 });
  await w.g.req('tech.research', { castleId: 1, techId: 12 });
  await runIn(w, block);
  assert.deepStrictEqual(only(w, 'tech.speedUpResearch').map((d) => d.itemId), ['consume.2.c']);
  w = world({ items: { 'consume.2.c': 1 }, jobMs: 3600 * 1000 });
  await w.g.req('tech.research', { castleId: 1, techId: 12 });
  await runIn(w, block);
  assert.deepStrictEqual(only(w, 'tech.speedUpResearch'), []);
});

// ---------------------------------------------------------------------------
section('demo, demosite, cancelbuilding');

t('demo cottage: one level off the lowest one under 10; the line waits for it', async () => {
  const w = world({ jobMs: 20 });
  const r = await runIn(w, 'demo cottage' + SEE);
  assert.deepStrictEqual(only(w, 'castle.destructBuilding'), [{ castleId: 1, positionId: 15 }]);
  assert.ok(!w.home.buildings.some((b) => b.positionId === 15), 'level 1 -> gone');
  assert.deepStrictEqual(last(r), [null, 15]);
});

t('demo forge level10 takes a level-10 building down; demo forge alone refuses it', async () => {
  let w = world({ jobMs: 5 });
  let r = await runIn(w, 'demo forge' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'every Forge is level 10 — only level10 or highestlevel 10 takes one down');
  w = world({ jobMs: 5 });
  r = await runIn(w, 'demo forge level10' + SEE);
  assert.deepStrictEqual(only(w, 'castle.destructBuilding'), [{ castleId: 1, positionId: 1 }]);
  assert.strictEqual(w.home.buildings.find((b) => b.positionId === 1).level, 9);
  w = world({ jobMs: 5 });
  r = await runIn(w, 'demo c highestlevel 10' + SEE);
  assert.deepStrictEqual(only(w, 'castle.destructBuilding').map((d) => d.positionId), [14]);
});

t('demo s highestlevel: the highest sawmill at or below 9', async () => {
  const w = world({ jobMs: 5 });
  await runIn(w, 'demo s highestlevel');
  assert.deepStrictEqual(only(w, 'castle.destructBuilding').map((d) => d.positionId), [1003]);
});

t('demo /dynamite ws: the order, then Dynamite finishes it; never without one held', async () => {
  let w = world({ items: { [DYNAMITE]: 1 }, jobMs: 1000 });
  let r = await runIn(w, 'demo /dynamite ws' + SEE);
  assert.deepStrictEqual(writes(w).map((s) => [s.cmd, s.data.positionId, s.data.itemId]),
    [['castle.destructBuilding', 10, undefined], ['castle.speedUpBuildCommand', 10, DYNAMITE]]);
  assert.ok(!w.home.buildings.some((b) => b.typeId === 26), 'the workshop is gone');
  assert.deepStrictEqual(last(r), [null, 10]);
  w = world({ items: {} });
  r = await runIn(w, 'demo /dynamite ws' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'no Dynamite held (player.destroy.1.a) — not sent: it is never bought; without /dynamite one level comes down');
  w = world({ items: null });
  r = await runIn(w, 'demo /dynamite ws' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.match(last(r)[0], /the inventory is not loaded/);
});

t('demo any @15 / demo b @20: whatever stands there, or that type only', async () => {
  let w = world({ jobMs: 5 });
  await runIn(w, 'demo any @15\ndemo b @20');
  assert.deepStrictEqual(only(w, 'castle.destructBuilding').map((d) => d.positionId), [15, 20]);
  w = world();
  const r = await runIn(w, 'demo b @12' + SEE + '\ndemo any @14' + SEE + '\ndemo any @3' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.deepStrictEqual(r.seen.map((s) => s[0]), [
    'plot 12 holds Cottage on plot 12 (level 3), not a Barracks — demo any @12 takes whatever is there',
    'Cottage on plot 14 (level 10) is level 10 — only demo ... level10 or highestlevel 10 takes a level-10 building down',
    'nothing stands on plot 3 in Home']);
});

t('the Demo page\'s block: demo c level10 / repeat 5 / demo c / repeat 45 takes five level-10 cottages down to nothing', async () => {
  const w = world({ jobMs: 1, buildings: [B(31, -1, 10), ...[12, 13, 14, 15, 16].map((p) => B(1, p, 10))] });
  const r = await runIn(w, 'demo c level10\nrepeat 5\ndemo c\nrepeat 45\necho "left " + city.countBuilding(1)');
  assert.strictEqual(only(w, 'castle.destructBuilding').length, 50);
  assert.ok(!w.home.buildings.some((b) => b.typeId === 1));
  assert.match(r.text, / {2}left 0/);
});

t('demosite 36 / demosite /dynamite 36: any type, any level, level 10 included', async () => {
  let w = world({ jobMs: 5 });
  w.home.buildings.push(B(3, 36, 10));
  let r = await runIn(w, 'demosite 36' + SEE);
  assert.deepStrictEqual(only(w, 'castle.destructBuilding'), [{ castleId: 1, positionId: 36 }]);
  assert.deepStrictEqual(last(r), [null, 36]);
  w = world({ items: { [DYNAMITE]: 2 }, jobMs: 1000 });
  w.home.buildings.push(B(3, 36, 10));
  r = await runIn(w, 'demosite /dynamite 36' + SEE);
  assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand').map((d) => [d.positionId, d.itemId]), [[36, DYNAMITE]]);
  assert.ok(!w.home.buildings.some((b) => b.positionId === 36));
});

t('the Town Hall and the Walls are never demolished: by type, by plot, with or without /dynamite', async () => {
  for (const l of ['demosite -1', 'demosite @-2', 'demosite /dynamite -2', 'demo any @-1', 'demo any at -2', 'demo townhall', 'demo th /dynamite',
    'demo walls', 'demo w level5', 'demolish t @-1', 'walldefense walls demo', 'walldefense /demo w:1', 'walldefense th keep']) {
    assert.match(parseErr(l) || '', /(the Town Hall|the Walls).* never demolished/, l);
  }
  assert.strictEqual(P('walldefense /keep at:0').action, 'keep', 'the defenses on the Walls are still walldefense\'s');
  // an action that never went through parse (a list from elsewhere) is refused when it runs
  const w = world({ items: { [DYNAMITE]: 5 }, jobMs: 5 });
  const out = [];
  await script.run(w.g, [
    { cmd: 'demo', any: true, anyLevel: true, at: -1, policy: null, line: 1, raw: 'demosite -1' },
    { cmd: 'demo', any: true, anyLevel: true, at: -2, policy: null, dynamite: true, line: 2, raw: 'demosite /dynamite -2' },
    { cmd: 'demo', building: C.BUILDING_BY_ID[31], at: null, policy: null, line: 3, raw: 'demo townhall' },
  ], (m) => out.push(m), { castle: 'Home', repeatGapMs: 0, ...FAST });
  w.close();
  assert.deepStrictEqual(writes(w), [], out.join('\n'));
  assert.strictEqual(out.filter((l) => /never demolished/.test(l)).length, 3, out.join('\n'));
});

t('demo forge /nowait /speedup="Primary Guidelines,Beginner Guidelines": the held ones in order until it is done', async () => {
  const w = world({ items: { 'consume.2.b': 1, 'consume.2.a': 1 }, jobMs: 1000 });
  const r = await runIn(w, 'demo forge level10 /nowait /speedup="Primary Guidelines,Beginner Guidelines"' + SEE);
  assert.deepStrictEqual(only(w, 'castle.speedUpBuildCommand').map((d) => d.itemId), ['consume.2.b'], 'the first finished it');
  assert.match(r.text, /Forge on plot 1 is finished — Beginner Guidelines not needed/);
});

t('cancelbuilding: the construction under way; nothing under way is no error', async () => {
  let w = world({ jobMs: 1000 });
  w.start(w.home, 20, 'up');
  let r = await runIn(w, 'cancelbuilding' + SEE);
  assert.deepStrictEqual(only(w, 'castle.cancleBuildCommand'), [{ castleId: 1, positionId: 20 }]);
  assert.deepStrictEqual(last(r), [null, 20]);
  w = world();
  r = await runIn(w, 'cancelbuilding' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.deepStrictEqual(last(r), [null, 0]);
  assert.match(r.text, /nothing is under construction in Home/);
});

t('a dry run of every construction line sends nothing and says what it would do', async () => {
  const w = world({ items: { [DYNAMITE]: 1, 'consume.2.a': 1, [SCRIPT]: 1 } });
  w.start(w.home, 20, 'up');
  const r = await runIn(w, ['create cottage', 'create embassy 2', 'build cottage at 3', 'upgrade farm /speedup=consume.2.a', 'upgrade iron level9',
    'demo /dynamite ws', 'demosite 12', 'cancelbuilding', 'buildingspeedup Beginner Guidelines'].join('\n'), { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(r.done, 0);
  assert.match(r.text, /the builder is busy \(Barracks on plot 20, L7->L8, \d+s left\) — \[dry run\] would wait for it/);
  assert.match(r.text, /its preset time is 1m 15s: the free speed-up would finish it — \[dry run\] not sent/);
  assert.match(r.text, /then Dynamite \(player\.destroy\.1\.a\) finishes it — \[dry run\] not sent/);
  assert.match(r.text, /speed up Barracks on plot 20 with Beginner Guidelines — \[dry run\] not sent/);
  assert.match(r.text, /Ironmine on plot 1004 \(level 9\) -> 10 spends a Michelangelo's Script \(1 held\)/);
});

// ---------------------------------------------------------------------------
section('research');

t('startresearch compass: sent, and the line waits for the research-complete push', async () => {
  const w = world({ jobMs: 40 });
  const t0 = Date.now();
  const r = await runIn(w, 'startresearch compass' + SEE);
  assert.ok(Date.now() - t0 >= 35);
  assert.deepStrictEqual(only(w, 'tech.research'), [{ castleId: 1, techId: 12 }]);
  assert.strictEqual(w.research.get(1).find((b) => b.typeId === 12).level, 2);
  assert.deepStrictEqual(last(r), [null, 'Compass']);
});

t('startresearch ... /nowait moves on at once; informatics 0 -> 1 (300 s) takes the free speed-up', async () => {
  let w = world({ jobMs: 1000 });
  const t0 = Date.now();
  let r = await runIn(w, 'startresearch con /nowait' + SEE);
  assert.ok(Date.now() - t0 < 500);
  assert.deepStrictEqual(last(r), [null, 'Construction']);
  w = world({ jobMs: 1000 });
  r = await runIn(w, 'startresearch in' + SEE);
  assert.deepStrictEqual(only(w, 'tech.speedUpResearch'), [{ castleId: 1, itemId: 'free.speed' }]);
  assert.match(r.text, /free speed-up \(preset time 5m\) -> ok/);
});

t('startresearch quickest / cheapest / dearest pick among the techs that can start now', async () => {
  for (const [pick, id] of [['quickest', 7], ['cheapest', 7], ['dearest', 12]]) {
    const w = world({ jobMs: 1 });
    await runIn(w, `startresearch ${pick} /nowait`);
    assert.deepStrictEqual(only(w, 'tech.research').map((d) => d.techId), [id], pick);
  }
});

t('startresearch refuses what cannot start, saying why', async () => {
  const w = world();
  const r = await runIn(w, ['startresearch ms', 'startresearch lo', 'startresearch met', 'startresearch pr'].map((l) => l + SEE).join('\n'));
  assert.deepStrictEqual(only(w, 'tech.research'), []);
  assert.deepStrictEqual(r.seen.map((s) => s[0]), [
    'Military Science cannot be researched in Home yet',
    'BLOCKED - Logistics needs Academy level 7 (you have 6)',
    'BLOCKED - Metal Casting needs Mining level 1 (you have 0)',
    'Privateering is not on Home\'s research list']);
});

t('startresearch waits for the research already running in the city, then starts', async () => {
  const w = world({ jobMs: 30 });
  await w.g.req('tech.research', { castleId: 1, techId: 14 });
  w.sent.length = 0;
  const r = await runIn(w, 'startresearch compass /nowait' + SEE);
  assert.match(r.text, /waiting for Archery \(running\) to finish/);
  assert.deepStrictEqual(only(w, 'tech.research').map((d) => d.techId), [12]);
  assert.strictEqual(w.research.get(1).find((b) => b.typeId === 14).level, 4);
  const w2 = world({ jobMs: 1000 });
  await w2.g.req('tech.research', { castleId: 1, techId: 12 });
  const r2 = await runIn(w2, 'startresearch compass' + SEE);
  assert.strictEqual(last(r2)[0], 'Home is already researching Compass');
});

t('research archery (OTTObot\'s): sent at once, as before', async () => {
  const w = world({ jobMs: 1000 });
  const r = await runIn(w, 'research archery' + SEE);
  assert.deepStrictEqual(only(w, 'tech.research'), [{ castleId: 1, techId: 14 }]);
  assert.match(r.text, /Archery: level 3\/6\n {2}research Archery \(tech 14\) in Home\n {2}-> ok/);
});

t('researchspeedup Senior Guidelines / cancelresearch / checkresearch', async () => {
  let w = world({ items: { 'consume.2.c': 1 }, jobMs: 1000 });
  await w.g.req('tech.research', { castleId: 1, techId: 12 });
  let r = await runIn(w, 'researchspeedup Senior Guidelines' + SEE);
  assert.deepStrictEqual(only(w, 'tech.speedUpResearch'), [{ castleId: 1, itemId: 'consume.2.c' }]);
  assert.deepStrictEqual(last(r), [null, 1]);
  w = world({ jobMs: 1000 });
  await w.g.req('tech.research', { castleId: 1, techId: 12 });
  r = await runIn(w, 'cancelresearch' + SEE);
  assert.deepStrictEqual(only(w, 'tech.cancelResearch'), [{ castleId: 1 }]);
  assert.deepStrictEqual(last(r), [null, 'Compass']);
  w = world();
  r = await runIn(w, 'cancelresearch' + SEE + '\nresearchspeedup Senior Guidelines' + SEE);
  assert.deepStrictEqual(r.seen.map((s) => s[0]), [null, 'nothing is being researched in Home']);
  w = world({ res: { each: 1000 } });
  r = await runIn(w, 'checkresearch' + SEE);
  assert.deepStrictEqual(last(r), [null, ['Archery', 'Construction', 'Informatics']], 'compass needs 5,000 food; ms, logistics and metal casting cannot start');
  assert.match(r.text, /Archery 3 -> 4: 50m, food 900, wood 200, stone 300, iron 50/);
});

t('a dry run of the research lines sends nothing', async () => {
  const w = world({ items: { 'consume.2.a': 1 } });
  const r = await runIn(w, 'startresearch compass /speedup=consume.2.a\nstartresearch in\nresearch archery\ncancelresearch\ncheckresearch', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /research Compass 1 -> 2 \(tech 12\) in Home\n {2}speed up Compass research with Beginner Guidelines — \[dry run\] not sent/);
  assert.match(r.text, /its preset time is 5m: the free speed-up would finish it — \[dry run\] not sent/);
});

// ---------------------------------------------------------------------------
section('walls');

t('walldefense: build, demo (only what stands), keep', async () => {
  const w = world();
  const r = await runIn(w, ['walldefense at 1000', 'walldefense', 'walldefense tre 11k build', 'walldefense at:5k,ab:1k,tra:1k demo',
    'walldefense /keep at:15k,ab:1k,tra:1k', 'walldefense /keep tre:0'].map((l) => l + SEE).join('\n'));
  assert.deepStrictEqual(only(w, 'fortifications.produceWallProtect').map((d) => [d.wallProtectType, d.num]), [[16, 1000], [14, 1], [18, 11000]]);
  assert.deepStrictEqual(only(w, 'fortifications.destructWallProtect').map((d) => [d.typeId, d.num]),
    [[16, 5000], [15, 50], [14, 100], [16, 5000], [18, 30000]]);
  assert.match(r.text, /demolish 50 x Abatis \(only 50 stand\)/);
  assert.match(r.text, /keep 15,000 Arrow Tower: 20,000 stand -> demolish 5,000/);
  assert.match(r.text, /keep 1,000 Abatis: 50 stand -> demolish 0/);
  assert.deepStrictEqual(r.seen.map((s) => s[1]), [1000, 1, 11000, 5150, 5000, 30000]);
  assert.ok(r.seen.every((s) => s[0] === null));
});

t('wall abatis 1000 (OTTObot\'s) builds, as before; a dry run sends nothing', async () => {
  let w = world();
  await runIn(w, 'wall abatis 1000');
  assert.deepStrictEqual(only(w, 'fortifications.produceWallProtect'), [{ castleId: 1, wallProtectType: 15, num: 1000 }]);
  w = world();
  const r = await runIn(w, 'walldefense at:5k,ab:1k demo\nwall trap 5', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /demolish 5,000 x Arrow Tower in Home\n {2}demolish 50 x Abatis \(only 50 stand\) in Home\n {2}\[dry run\] not sent/);
});

// ---------------------------------------------------------------------------
section('troops');

t('train a:5000: every barracks shared, as the client sends it', async () => {
  const w = world();
  const r = await runIn(w, 'train a:5000' + SEE);
  assert.deepStrictEqual(only(w, 'troop.produceTroop'), [{ castleId: 1, positionId: 0, troopType: 7, num: 5000, isShare: true, toIdle: false }]);
  assert.deepStrictEqual(last(r), [null, 5000]);
});

t('train w:25000 atk: the best attack hero is mayor for the order, then the old mayor is back', async () => {
  const w = world();
  await runIn(w, 'train w:25000 atk');
  assert.deepStrictEqual(writes(w).map((s) => [s.cmd, s.data.heroId ?? s.data.num]),
    [['hero.promoteToChief', 13], ['troop.produceTroop', 25000], ['hero.promoteToChief', 12]]);
  assert.strictEqual(w.home.heros.find((h) => h.status === 1).name, 'Queen');
});

t('train a:999999 ace idle 20000: idle barracks, Ace as mayor, as many as fit but at least 20,000', async () => {
  const w = world();
  const r = await runIn(w, 'train a:999999 ace idle 20000' + SEE);
  // 45,000 idle population / 2 = 22,500 archers; food 5m / 300 = 16,666 ... wood 5m / 350 = 14,285
  assert.deepStrictEqual(w.sent, [], 'fewer than 20,000 fit: nothing asked, nothing queued, no mayor changed');
  assert.strictEqual(last(r)[0], 'only 14,285 Archer fit (wood 5,000,000), fewer than the minimum 20,000 — nothing queued');
  const w2 = world({ res: { each: 50e6 } });
  const r2 = await runIn(w2, 'train a:999999 ace idle 20000' + SEE);
  assert.deepStrictEqual(only(w2, 'troop.checkIdleBarrack'), [{ castleId: 1, troopType: 7 }], 'the client asks first (SWEnlist.change_toIdle)');
  assert.deepStrictEqual(only(w2, 'troop.produceTroop'), [{ castleId: 1, positionId: 0, troopType: 7, num: 22500, isShare: true, toIdle: true }]);
  assert.deepStrictEqual(only(w2, 'hero.promoteToChief').map((d) => d.heroId), [13, 12]);
  assert.match(r2.text, /only 22,500 of the 999,999 fit \(idle population 45,000\) — training those/);
  assert.deepStrictEqual(last(r2), [null, 22500]);
});

t('train w:25000 atk 18 25000: that barracks, all of it or nothing', async () => {
  let w = world();
  let r = await runIn(w, 'train w:25000 atk 18 25000' + SEE);
  assert.deepStrictEqual(only(w, 'troop.produceTroop'), [{ castleId: 1, positionId: 18, troopType: 3, num: 25000, isShare: false, toIdle: false }]);
  w = world({ res: { pop: 20000, work: 0 } });
  r = await runIn(w, 'train w:25000 atk 18 25000' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'only 20,000 Warrior fit (idle population 20,000), fewer than the minimum 25,000 — nothing queued');
  w = world();
  r = await runIn(w, 'train w:100 any 19' + SEE);
  assert.strictEqual(last(r)[0], 'no barracks on plot 19 in Home — its barracks are on 11, 18, 20, 21');
});

t('train with no idle barracks, or a hero not at home, says so and changes no mayor', async () => {
  let w = world({ replies: { 'troop.checkIdleBarrack': { ok: -1 } } });
  let r = await runIn(w, 'train a:100 any idle' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'no idle barracks in Home for Archer');
  w = world();
  r = await runIn(w, 'train a:100 Away' + SEE + '\ntrain a:100 Nobody' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.deepStrictEqual(r.seen.map((s) => s[0]), ['Away is not in Home right now', 'no hero named "Nobody" in Home']);
});

t('train help, train a 10k (OTTObot\'s: exactly that many, into the first barracks), and dry runs', async () => {
  let w = world();
  let r = await runIn(w, 'train help\ntrain a 10k' + SEE);
  assert.match(r.text, /train a:999999 ace idle 20000 idle barracks only, Ace as mayor, at least 20,000 or nothing/);
  assert.deepStrictEqual(only(w, 'troop.produceTroop'), [{ castleId: 1, positionId: 11, troopType: 7, num: 10000, isShare: false, toIdle: false }]);
  assert.match(last(r)[1], /train 10,000 x Archer \(type 7\) in Home/, '$result: what it logged, as before');
  w = world();
  r = await runIn(w, 'train w:25000 atk\ntrain a 10k', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /Ace would be mayor for the order, then Queen mayor again/);
});

t('disband w:25k / disband /keep w:25k (troops out on marches count as kept)', async () => {
  let w = world();
  let r = await runIn(w, 'disband w:25k' + SEE);
  assert.deepStrictEqual(only(w, 'troop.disbandTroop'), [{ castleId: 1, troopType: 3, num: 25000 }]);
  assert.deepStrictEqual(last(r), [null, 25000]);
  w = world();
  w.g.player.selfArmys = [{ armyId: 5, direction: 1, startFieldId: w.home.fieldId, targetFieldId: F(1, 1), troop: { militia: 3000 } }];
  r = await runIn(w, 'disband /keep w:25k' + SEE);
  assert.deepStrictEqual(only(w, 'troop.disbandTroop'), [{ castleId: 1, troopType: 3, num: 8000 }]);
  assert.match(r.text, /keep 25,000 Warrior: 30,000 at home \+ 3,000 out on marches = 33,000 -> disband 8,000/);
  w = world();
  r = await runIn(w, 'disband /keep w:40k' + SEE + '\ndisband a:1', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /nothing to disband/);
  assert.match(r.text, /\[dry run\] not sent — 1 Archer would be dismissed for good/);
});

t('dumptroop 111,222 a:99000,s:50000 a:20000,s:15000: only once the city holds the first', async () => {
  let w = world();
  let r = await runIn(w, 'dumptroop 111,222 a:99000,s:50000 a:20000,s:15000' + SEE);
  const bean = only(w, 'army.newArmy')[0].newArmyBean;
  assert.deepStrictEqual([bean.missionType, bean.targetPoint, bean.troops.archer, bean.troops.scouter, bean.heroId], [2, F(111, 222), 20000, 15000, undefined]);
  assert.deepStrictEqual(last(r), [null, 35000]);
  w = world({ troop: { archer: 50000 } });
  r = await runIn(w, 'dumptroop 111,222 a:99000,s:50000 a:20000,s:15000' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'not yet: 50,000 of 99,000 Archer — nothing sent');
});

t('healtroops: the camp from its push, healed for gold; not enough gold or nobody wounded', async () => {
  let w = world({ camp: { goldNeed: 1234, troop: { archer: 500, militia: 20 } } });
  let r = await runIn(w, 'healtroops' + SEE);
  assert.deepStrictEqual(only(w, 'army.cureInjuredTroop'), [{ castleId: 1 }]);
  assert.match(r.text, /heal 500 Archer, 20 Warrior for 1,234 gold/);
  assert.deepStrictEqual(last(r), [null, 520]);
  w = world({ camp: { goldNeed: 9e9, troop: { archer: 5 } } });
  r = await runIn(w, 'healtroops' + SEE);
  assert.ok(!cmds(w).includes('army.cureInjuredTroop'));
  assert.strictEqual(last(r)[0], 'healing needs 9,000,000,000 gold and Home has 5,000,000');
  w = world({ camp: { goldNeed: 0, troop: {} } });
  r = await runIn(w, 'healtroops' + SEE);
  assert.deepStrictEqual(last(r), [null, 0]);
  assert.ok(!cmds(w).includes('army.cureInjuredTroop'));
});

// ---------------------------------------------------------------------------
section('the city');

t('production, tax, settaxrate, comfort, levy: what each sends', async () => {
  const w = world();
  const r = await runIn(w, ['production 100 100 100 100', 'tax 20', 'settaxrate 25', 'comfort pray', 'comfort 4', 'levy 1', 'levy food'].map((l) => l + SEE).join('\n'));
  assert.deepStrictEqual(writes(w).map((s) => [s.cmd, s.data]), [
    ['interior.modifyCommenceRate', { castleId: 1, foodrate: 100, woodrate: 100, stonerate: 100, ironrate: 100 }],
    ['interior.modifyTaxRate', { castleId: 1, tax: 20 }], ['interior.modifyTaxRate', { castleId: 1, tax: 25 }],
    ['interior.pacifyPeople', { castleId: 1, typeId: 2 }], ['interior.pacifyPeople', { castleId: 1, typeId: 4 }],
    ['interior.taxation', { castleId: 1, typeId: 1 }], ['interior.taxation', { castleId: 1, typeId: 2 }]]);
  assert.ok(r.seen.every((s) => s[0] === null));
  assert.match(r.text, /set tax rate to 20% \(now 10%\)/);
  assert.match(r.text, /levy gold in Home: about 5,000, for 20 loyalty \(loyalty 80\)/);
  assert.match(r.text, /comfort: pray in Home \(loyalty 80, grievance 3\)/);
});

t('renamecity: the name and picture sent; the game\'s 10-letter limit and a name another city has are refused', async () => {
  let w = world();
  let r = await runIn(w, 'renamecity !BottingRul 3' + SEE + '\necho city.name');
  assert.deepStrictEqual(only(w, 'city.modifyCastleName'), [{ castleId: 1, name: 'BottingRul', logUrl: 'images/icon/cityLogo/citylogo_03.png' }]);
  assert.deepStrictEqual(last(r), [null, 'BottingRul']);
  assert.match(r.text, / {2}BottingRul$/m, 'the run finds its city by the new name');
  w = world();
  r = await runIn(w, 'renamecity !BottingRulz' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'BottingRulz is 11 letters — the game\'s rename window takes 10 at most; not sent');
  w = world();
  r = await runIn(w, 'renamecity fla' + SEE);
  assert.strictEqual(last(r)[0], 'another of your cities is called Fla already — pick another name');
  w = world();
  await runIn(w, 'renamecity Newer', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
});

// ---------------------------------------------------------------------------
section('valleys, towns, moving');

t('abandon 101,100: a valley of this account; a city\'s tile or one not ours is refused', async () => {
  let w = world();
  let r = await runIn(w, 'abandon 101,100' + SEE + '\nabandon 120,100' + SEE + '\nabandon 5,5' + SEE);
  assert.deepStrictEqual(only(w, 'field.giveUpField'), [{ fieldId: F(101, 100) }]);
  assert.deepStrictEqual(r.seen.map((s) => s[0]), [null,
    '120,100 is your city Fla, not a valley — abandontown 120,100 confirm gives a city up', '5,5 is not a valley of yours']);
  assert.strictEqual(r.seen[0][1], '101,100');
  assert.strictEqual(w.home.fields.length, 1);
  w = world();
  r = await runIn(w, 'abandon 101,100', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /abandon Forest L5 at 101,100 \(held by Home\)\n {2}\[dry run\] not sent/);
});

t('AbandonAllValleys: the one-city script drops every valley of the city', async () => {
  const w = world();
  const r = await runIn(w, 'label abandonAllValleys\nif city.fields.length = 0 goto done\nexecute "abandon " + city.fields[0].coords\nif !$error goto abandonAllValleys\n\nlabel done\necho "valleys " + city.fields.length');
  assert.deepStrictEqual(only(w, 'field.giveUpField').map((d) => d.fieldId), [F(101, 100), F(102, 100)]);
  assert.match(r.text, / {2}valleys 0/);
});

t('AbandonAllValleys: the all-cities script drops every valley in every city', async () => {
  const w = world();
  const src = ['cs = cities.concat()', 'label nextcity', 'c = cs.shift()', 'if c fs = c.cityManager.fields.toArray()', 'label nextfield',
    'if c f = fs.shift()', 'if c if f execute "abandon " + f.coords', 'if c if f if !$error goto nextfield', 'if c goto nextcity', 'echo "Finished"'].join('\n');
  const r = await runIn(w, src);
  assert.deepStrictEqual(only(w, 'field.giveUpField').map((d) => d.fieldId), [F(101, 100), F(102, 100), F(121, 100)]);
  assert.match(r.text, / {2}Finished/);
});

// The goals update's login keeps the password's SHA1 (evony.js passwordHash);
// abandontown signs with that, never with a stored password.
const hashed = (w) => { w.g.c.passwordHash = () => 'SHA1-HASH'; return w; };

t('abandontown ... confirm: refused while heroes, troops or marches would be lost, unless anyway', () => withAbandon(async () => {
  const s = { account: { id: 'a1', password: 'PLAIN-pw' } };
  let w = hashed(world());
  let r = await runIn(w, 'abandontown 120,100 confirm' + SEE, { session: s });
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], 'Fla still has 1 hero (Dee), 10 troops — they would be lost. Evacuate it first (evacuatetown x,y confirm), '
    + 'move the heroes out and wait for the marches; or add the word anyway: abandontown 120,100 confirm anyway');
  w = hashed(world());
  r = await runIn(w, 'abandontown !Fla confirm anyway' + SEE, { session: s });
  assert.deepStrictEqual(only(w, 'city.giveupCastle'), [{ password: 'SHA1-HASH', castleId: 2 }], 'the login\'s hash (GiveupCastle.as:417), never the password');
  assert.deepStrictEqual(last(r), [null, 'Fla']);
  assert.doesNotMatch(r.text, /SHA1-HASH|PLAIN-pw/, 'neither is logged');
  w = hashed(world());
  r = await runIn(w, 'abandontown Empty confirm' + SEE + '\nabandontown Nowhere confirm' + SEE, { session: s });
  assert.deepStrictEqual(only(w, 'city.giveupCastle'), [{ password: 'SHA1-HASH', castleId: 3 }]);
  assert.strictEqual(r.seen[1][0], 'no city of yours is called "Nowhere" — yours are Home, Fla');
}));

t('abandontown: without the goals update\'s hash, the last city, a dry run; the run\'s own city ends the run', () => withAbandon(async () => {
  let w = world();                        // a stored password is no longer enough
  let r = await runIn(w, 'abandontown Empty confirm' + SEE, { session: { account: { id: 'a1', password: 'pw' } } });
  assert.deepStrictEqual(writes(w), []);
  assert.match(last(r)[0], /^abandontown needs the goals update \(goals\/integration\)/);
  w = hashed(world());
  w.g.c.passwordHash = () => null;        // a session that never logged in with a password
  r = await runIn(w, 'abandontown Empty confirm' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.match(last(r)[0], /never logged in with a password/);
  w = hashed(world());
  w.g.castles = [w.empty];
  r = await runIn(w, 'abandontown Empty confirm' + SEE, { castle: 'Empty' });
  assert.strictEqual(last(r)[0], 'Empty is your only city — it cannot be given up');
  w = hashed(world());
  r = await runIn(w, 'abandontown Empty confirm', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /give up Empty \(700,700\) for good\n {2}\[dry run\] not sent/);
  w = world();
  r = await runIn(w, 'abandontown Empty confirm' + SEE, { dryRun: true });
  assert.match(last(r)[0], /needs the goals update/, 'a dry run says it would fail');
  w = hashed(world());
  r = await runIn(w, 'abandontown Empty confirm\necho "not reached"', { castle: 'Empty' });
  assert.match(r.text, /that was the city this script runs in — the run ends here/);
  assert.doesNotMatch(r.text, /not reached/);
}));

t('abandontown: a city the console\'s city registry protects is never given up; a buildnpc throwaway is', () => withAbandon(async () => {
  // session.org.registry as db.js has it: rows by field, abandonable only for buildnpc's own cities
  const rows = new Map([
    [F(120, 100), { fieldId: F(120, 100), castleId: 2, origin: 'pre-existing', state: 'protected', abandonable: false }],
    [F(700, 700), { fieldId: F(700, 700), castleId: 3, origin: 'buildnpc', state: 'built', abandonable: true }],
  ]);
  const asked = [], handedBack = [];
  const registry = { get: (acct, fid) => { asked.push(acct); return rows.get(fid) || null; }, byCastleId: () => null,
    markAbandoned: (acct, fid) => handedBack.push([acct, fid]) };
  const s = { account: { id: 'acct7' }, org: { registry } };
  let w = hashed(world());
  let r = await runIn(w, 'abandontown Fla confirm anyway' + SEE + '\nabandontown Empty confirm' + SEE, { session: s });
  assert.deepStrictEqual(only(w, 'city.giveupCastle'), [{ password: 'SHA1-HASH', castleId: 3 }]);
  assert.match(r.seen[0][0], /the city registry records Fla as a real city \(pre-existing, protected\) — a script never gives one up/);
  assert.strictEqual(r.seen[1][0], null);
  assert.ok(asked.every((a) => a === 'acct7'));
  assert.deepStrictEqual(handedBack, [['acct7', F(700, 700)]], 'the registry row is marked abandoned, as buildnpc does');
  // no row: nothing vouches for it
  rows.delete(F(700, 700));
  w = hashed(world());
  r = await runIn(w, 'abandontown Empty confirm' + SEE, { session: s });
  assert.deepStrictEqual(writes(w), []);
  assert.match(last(r)[0], /the city registry has no record of Empty yet/);
  // a dry run reads the registry too
  w = hashed(world());
  r = await runIn(w, 'abandontown Fla confirm anyway' + SEE, { session: s, dryRun: true });
  assert.match(last(r)[0], /records Fla as a real city/);
}));

// 10,000 archers and 500 transports: a hold of 250,000 + 2,500,000
const EVAC = { peasants: 0, militia: 0, scouter: 0, pikemen: 0, swordsmen: 0, lightCavalry: 0, archer: 10000, carriage: 500 };

t('evacuatetown 120,100 confirm: every troop, carrying what fits, reinforce; endevacuate recalls it', async () => {
  const w = world({ res: { each: 1e6, gold: 2e6 }, troop: EVAC });
  const r = await runIn(w, 'evacuatetown 120,100 confirm' + SEE + '\nendevacuate' + SEE, { keepTimers: true });
  w.close();
  const bean = only(w, 'army.newArmy')[0].newArmyBean;
  assert.strictEqual(bean.missionType, 2);
  assert.strictEqual(bean.targetPoint, F(120, 100));
  assert.deepStrictEqual([bean.troops.archer, bean.troops.carriage, bean.heroId], [10000, 500, undefined]);
  const carried = Object.values(bean.resource).reduce((s, v) => s + v, 0);
  const food = Number(/eats ([\d,]+) food/.exec(r.text)[1].replace(/,/g, ''));
  assert.strictEqual(bean.resource.gold, 2e6, 'gold first');
  assert.strictEqual(carried, 2750000 - food, 'the hold, less the food the march eats');
  assert.match(r.text, /evacuate Home: 10,000 Archer, 500 Transporter with gold 2,000,000, food [\d,]+ to 120,100 — reinforce, no hero \(heroes stay\); march /);
  assert.deepStrictEqual(r.seen[0], [null, 10500]);
  assert.deepStrictEqual(only(w, 'army.callBackArmy').map((d) => d.castleId), [1]);
  assert.deepStrictEqual(r.seen[1], [null, 1]);
});

t('evacuatetown: to itself, with no troops, or more march food than the hold, is refused; a dry run sends nothing', async () => {
  let w = world();
  let r = await runIn(w, 'evacuatetown 100,100 confirm' + SEE);
  assert.strictEqual(last(r)[0], '100,100 is Home itself');
  r = await runIn(w, 'evacuatetown 120,100 confirm' + SEE, { castle: 'Empty' });
  assert.strictEqual(last(r)[0], 'no troops in Empty to evacuate');
  w = world({ res: { each: 50e6 } });
  r = await runIn(w, 'evacuatetown 120,100 confirm' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.match(last(r)[0], /^the march eats [\d,]+ food, more than these troops carry \([\d,]+\) — the game refuses it/);
  w = world({ troop: EVAC });
  r = await runIn(w, 'evacuatetown 120,100 confirm\nendevacuate 120,100', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /\[dry run\] not sent/);
});

t('buildcity on a flat already held: preflight, the founding gate, then city.constructCastle', async () => {
  let w = world();
  let r = await runIn(w, 'buildcity 102,100' + SEE);
  assert.deepStrictEqual(only(w, 'city.constructCastle'), [{ castleId: 1, fieldId: F(102, 100), isTroopBack: false }]);
  assert.strictEqual(last(r)[0], null);
  w = world({ res: { each: 5000 } });
  r = await runIn(w, 'buildcity 102,100' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.match(last(r)[0], /takes 10,000 each of food, wood, stone, iron and gold and 250 workers — short: food 5,000 of 10,000, wood 5,000 of 10,000/);
  w = world();
  r = await runIn(w, 'buildcity 101,100' + SEE + '\nbuildcity 120,100' + SEE);
  assert.deepStrictEqual(r.seen.map((s) => s[0]), ['101,100 is your Forest L5, not a flat — cities go on flats only', '120,100 is already one of your cities']);
});

t('buildcity on a free flat: capture it first with ValleyTroops\' defaults for its level, wait, then found the city', async () => {
  const w = world();
  const s = { connected: true, account: { id: 'a1' }, scanArea: async (x, y) => ({ tiles: [{ x, y, kind: 'flat', level: 4 }] }) };
  // the capture lands: the flat joins Home's fields (server.CastleFieldUpdate)
  const at = F(110, 110);
  setTimeout(() => { w.home.fields.push({ id: at, type: 10, level: 4, name: 'Flat' }); }, 40);
  const r = await runIn(w, 'buildcity 110,110' + SEE, { session: s });
  const bean = only(w, 'army.newArmy')[0].newArmyBean;
  assert.deepStrictEqual([bean.missionType, bean.targetPoint, bean.heroId], [5, at, 11]);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(bean.troops).filter(([, v]) => v > 0)),
    { militia: 1200, scouter: 1, pikemen: 1, swordsmen: 1, archer: 400 });
  assert.match(r.text, /110,110 is not yours yet: capture it first \(flat level 4\) — attack with Ken/);
  assert.match(r.text, / {2}110,110 is yours/);
  assert.deepStrictEqual(only(w, 'city.constructCastle'), [{ castleId: 1, fieldId: at, isTroopBack: false }]);
  assert.strictEqual(last(r)[0], null);
});

t('buildcity: an NPC tile or a held one is refused; troops can be given; a dry run sends nothing', async () => {
  let w = world();
  let s = { connected: true, scanArea: async (x, y) => ({ tiles: [{ x, y, kind: 'npc', level: 5 }] }) };
  let r = await runIn(w, 'buildcity 110,110' + SEE, { session: s });
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual(last(r)[0], '110,110 is an NPC camp — a city goes on a flat');
  w = world();
  r = await runIn(w, 'buildcity 110,110' + SEE);
  assert.strictEqual(last(r)[0], 'could not read 110,110\'s level to size the capture — give the troops: buildcity 110,110 any a:200');
  w = world();
  r = await runIn(w, 'buildcity 110,110 Ace a:200', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /attack with Ace and 200 Archer/);
  w = world();
  r = await runIn(w, 'buildcity 110,110 Away a:200' + SEE);
  assert.strictEqual(last(r)[0], 'capture 110,110: Away is not free in Home to lead it');
});

t('cancelbuildcity (from another run) stops a buildcity waiting on its capture, and recalls the march', async () => {
  const w = world({ homeMs: 5 });
  const s = { connected: true, scanArea: async (x, y) => ({ tiles: [{ x, y, kind: 'flat', level: 1 }] }) };
  const first = runIn(w, 'buildcity 110,110' + SEE, { session: s, keepTimers: true, cityGraceMs: 5000 });
  await sleep(40);
  const second = await runIn(w, 'cancelbuildcity 110,110' + SEE, { keepTimers: true });
  const r = await first;
  w.close();
  assert.deepStrictEqual(last(second), [null, 1]);
  assert.strictEqual(last(r)[0], 'the city build at 110,110 was cancelled');
  assert.deepStrictEqual(only(w, 'army.callBackArmy').length, 1);
  assert.ok(!cmds(w).includes('city.constructCastle'));
  const w2 = world();
  const r2 = await runIn(w2, 'cancelbuildcity' + SEE);
  assert.deepStrictEqual(last(r2), [null, 0]);
});

t('teleport saxony / teleport 111,222 / warteleport 123,45 (teleport.js), and a Pioneer Express Teleport first', async () => {
  let w = world({ items: { 'consume.move.1': 1, 'player.more.castle.1.a': 1, 'player.more.castle.1.c': 1 } });
  await runIn(w, 'teleport saxony\nteleport 111,222\nwarteleport 123,45');
  assert.deepStrictEqual(writes(w).map((s) => s.cmd), ['city.moveCastle', 'city.advMoveCastle', 'city.WarMoveCastle']);
  assert.strictEqual(only(w, 'city.moveCastle')[0].zoneId, 1);
  w = world({ items: { [PIONEER]: 1, 'player.more.castle.1.a': 1 } });
  const r = await runIn(w, 'teleport 111,222' + SEE);
  assert.deepStrictEqual(writes(w).map((s) => [s.cmd, s.data.targetId]), [['city.uniteAdvMoveCastle', F(111, 222)]]);
  assert.match(r.text, /Pioneer Express Teleport: Home 100,100 -> 111,222 .* 1 held \(it goes before an Advanced Teleporter\)/);
  assert.strictEqual(w.home.fieldId, F(111, 222));
  assert.strictEqual(last(r)[0], null);
});

t('autoteleport tuscany: recall the city\'s armies, wait for them home, teleport, and try again after a refusal', async () => {
  let n = 0;
  const w = world({ items: { 'consume.move.1': 3 }, homeMs: 20,
    replies: { 'city.moveCastle': (d, D) => (n++ === 0 ? { ok: -90, errorMsg: 'cooldown' } : D['city.moveCastle'](d)) } });
  w.g.player.selfArmys = [{ armyId: 7, direction: 3, startFieldId: w.home.fieldId, targetFieldId: F(1, 1), reachTime: w.g.now() + 10 },
    { armyId: 8, direction: 2, startFieldId: w.home.fieldId, targetFieldId: F(1, 2), reachTime: w.g.now() + 10 }];
  setTimeout(() => { w.g.player.selfArmys = w.g.player.selfArmys.filter((a) => a.armyId !== 8); }, 15);
  const r = await runIn(w, 'autoteleport tuscany /tries=2 /every=0' + SEE);
  assert.deepStrictEqual(only(w, 'army.callBackArmy').map((d) => d.armyId), [7], 'the one coming home already is not recalled');
  assert.strictEqual(only(w, 'city.moveCastle').length, 2);
  assert.match(r.text, /could not teleport Home \(try 1 of 2\) — trying again in 0s/);
  assert.deepStrictEqual(last(r), [null, '400,600'], '$result: where the city is now');
  assert.strictEqual(C.zoneOf(400, 600), 'Tuscany');
});

t('autoteleport: no state given reads -teleport (Config.teleport); in the state already, or no teleporter, sends nothing', async () => {
  let w = world({ items: { 'consume.move.1': 2 } });
  let r = await runIn(w, 'autoteleport all confirm' + SEE, { config: { teleport: 'friesland' } });
  assert.match(r.text, /Home is in Friesland already\n {2}Fla is in Friesland already\n {2}Empty \(Romagna\) -> Friesland/);
  assert.deepStrictEqual(only(w, 'city.moveCastle').map((d) => [d.castleId, C.ZONES[d.zoneId]]), [[3, 'Friesland']]);
  assert.deepStrictEqual(last(r)[0], null);
  assert.match(r.text, /1 moved, 2 already there/);
  w = world({ items: { 'consume.move.1': 1 } });
  r = await runIn(w, 'autoteleport' + SEE);
  assert.match(last(r)[0], /which state\? \(autoteleport tuscany, autoteleport random, or start the console with -teleport <state>\)/);
  w = world({ items: {} });
  r = await runIn(w, 'autoteleport tuscany' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /no City Teleporter in the inventory \(consume\.move\.1\) — nothing sent/);
  w = world({ items: null });
  r = await runIn(w, 'autoteleport tuscany' + SEE);
  assert.deepStrictEqual(writes(w), []);
  assert.match(r.text, /the inventory is not loaded, so whether a City Teleporter is held cannot be checked — nothing sent/);
});

t('the AutoTeleporter page\'s script runs (its sleeps shortened): recall, wait, teleport, then loadgoals', async () => {
  const w = world({ items: { 'consume.move.1': 2 }, homeMs: 5 });
  w.g.player.selfArmys = [{ armyId: 9, direction: 1, startFieldId: w.home.fieldId, targetFieldId: F(1, 1), reachTime: w.g.now() + 5, troop: { archer: 1 } }];
  const src = AUTO_TELEPORTER.replace(/sleep 30|sleep 10|sleep 5:00/g, 'sleep 0');
  const GL = { SCRIPT_MAX_LINES: 100, addScriptLine: () => ({ errors: [], lines: [], layer: null }), loadScriptGoals: () => ({ errors: [], lines: [], layer: null, cleared: false }),
    getScriptLayer: () => null };
  const r = await runIn(w, src, { config: { teleport: 'tuscany' }, goalLayers: GL, session: { account: { id: 'a1' }, notify() {} } });
  assert.deepStrictEqual(only(w, 'army.callBackArmy').map((d) => d.armyId), [9]);
  assert.deepStrictEqual(only(w, 'city.moveCastle').map((d) => C.ZONES[d.zoneId]), ['Tuscany']);
  assert.strictEqual(C.zoneOf(...Object.values(C.fieldIdToCoords(w.home.fieldId))), 'Tuscany');
  assert.match(r.text, /line \d+: loadgoals/, 'Fla is elsewhere, so the script goes on to loadgoals');
});

t('canceltroopqueues / cancelfortifications route to queue-cancel.js (a dry run cancels nothing)', async () => {
  const w = world({ replies: { 'troop.getProduceQueue': { ok: 1, allProduceQueue: [] }, 'fortifications.getProduceQueue': { ok: 1, fortificationsProduceList: [] } } });
  const r = await runIn(w, 'canceltroopqueues\ncanceltroopqueues 2\ncancelfortifications\ncancelfortifications 2', { dryRun: true });
  assert.deepStrictEqual(writes(w), []);
  assert.strictEqual((r.text.match(/^line \d+: cancel/gm) || []).length, 4);
});

// ---------------------------------------------------------------------------
// The AutoTeleporter page (TELEPORT v0.04), as written.
const AUTO_TELEPORTER = `// TELEPORT v0.04 (c) 2014 NeatPortal.com
// This script will check if all your cities are in the specified state, and do nothing if they are.
// Otherwise it will prepare and teleport cities as needed.
// Once all cities are in the right state the script with close the bot (allowing for clean restart by the director).
//
// Usage example: To teleport all cities to Tuscany run bot with these custom command line parameters:
//    -runscript Teleport.txt -teleport tuscany

if Config.teleport == null goto finish
state = Config.teleport.toUpperCase()

if state == GetZoneName(city.fieldId).toUpperCase() goto finish

config wartown:2,comfort:1
recallall

sleep 30

// sort by reachTime, descending
label checkArmies
army = city.selfArmies.toArray().sortOn("reachTime", 18)[0]
if army == null goto teleport

secondsLeft = ceil(TimeDiff(army.reachTime) / 1000) // time left in seconds, rounded up
if secondsLeft > 0 echo "Waiting for armies to return for " + secondsLeft + " seconds"
if secondsLeft > 0 execute "sleep " + secondsLeft

if city.selfArmies.length > 0 say "Still have armies"
if city.selfArmies.length > 0 goto checkArmies

label teleport
try = 0
say "Trying to teleport " + city.name + " to " + state
sleep 10

label tryteleport
try = try + 1
execute "teleport " + state
if !$error goto finalcheck
if try >= 5 goto giveup
say "Can't teleport " + city.name + " to " + state + ", will retry in 5 minutes"
sleep 5:00
goto tryteleport

label finalcheck
x = 0
label checkCities
if GetZoneName(cities[x].cityManager.fieldId).toUpperCase() != state goto continue
x = x + 1
if x < cities.length goto checkCities
say "All cities are now in " + state + ", will close in 10 seconds"
sleep 10

// assuming the director will restart the bot
exit

label giveup
say "Can't teleport " + city.name + " to " + state

label continue
loadgoals

label finish`;

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  for (const [name, f] of tests) {
    if (!f) { console.log(`\n${name}\n`); continue; }
    try { await f(); pass++; console.log(`  ok    ${name}`); } catch (e) {
      fail++;
      console.log(`  FAIL  ${name}\n        ${String(e && e.stack || e).split('\n').slice(0, 12).join('\n        ')}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
