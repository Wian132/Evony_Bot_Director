'use strict';
// NEAT's own example scripts, end to end: every script on the wiki's
// ScriptExamples page and its sub-pages (AbandonAllValleys, AutoTeleporter,
// MonitorCity, PeacetimeStatusChecker, PromoAddFriend, SortingMemberList,
// TradeScript, TravelInfo, Travelinfo, TroopAndResourceTotals) and the example
// scripts of AutoRunScript, NewCityScript, Scr1ptingForDummies, Config.sol,
// CompleteQuests, CreateFunction, MapFunctions, Arrays, Strings, JSON, XML,
// Heroes, getAvailableTroop, GetItem, GetTechLevel, date and Unsorted. Each is
// copied here word for word, must load with no error (the console refuses a
// script with one), and runs through the real VM (script.parse + script.run)
// against one fake world: a real Game whose socket is a fake server that
// answers every request the commands send and changes the world the way the
// server's pushes would. NEAT's `sleep 300` lines run as written, at
// timeScale speed. The Usage/Example line matrix (compat-matrix.json) is built
// from the same world by the phase-3 scratch script.
const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-compat-'));
process.env.EVONY_DB = path.join(TMP, 't.db');                  // goals.js and the map cache open it
process.env.EVONY_SCRIPTS_DIR = path.join(TMP, 'scripts');       // get/call files
fs.mkdirSync(process.env.EVONY_SCRIPTS_DIR, { recursive: true });
const C = require('./constants');
const { Game } = require('./game');
const script = require('./script');

const tests = [];
const t = (n, f) => tests.push([n, f]);
const section = (s) => tests.push([s, null]);
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);
const F = (x, y) => C.coordsToFieldId(x, y);

// ---------------------------------------------------------------- the map
// Around MyCity at 460,355 (the MapFunctions page's city): the AllCastles
// example's five neighbours, level-10 NPCs and flats for FindField, and the
// PeacetimeStatusChecker's target at 152,605.
const T0 = Date.now() - 60000;
const row = (x, y, o) => ({ id: F(x, y), x, y, seen: T0, state: 1, furlough: false, npc: false, prestige: 0, honor: 0, ...o });
const MAP = [
  row(460, 355, { name: 'MyCity', userName: 'YayMe', allianceName: 'TuffGuys', prestige: 14517826, level: 10, kind: 'player' }),
  row(470, 360, { name: 'Fla', userName: 'YayMe', allianceName: 'TuffGuys', prestige: 14517826, level: 8, kind: 'player' }),
  row(455, 353, { name: 'BobTown', userName: 'Bob', allianceName: null, prestige: 4991, level: 3, kind: 'player' }),
  row(457, 353, { name: 'FredTown', userName: 'Fred', allianceName: null, prestige: 8060, level: 4, kind: 'player' }),
  row(459, 357, { name: 'George1', userName: 'George', allianceName: null, prestige: 10847, level: 5, kind: 'player' }),
  row(457, 358, { name: 'George2', userName: 'George', allianceName: null, prestige: 10847, level: 5, kind: 'player' }),
  row(464, 360, { name: 'HarryTown', userName: 'Harry', allianceName: null, prestige: 0, level: 1, kind: 'player' }),
  row(466, 350, { name: 'RedKeep', userName: 'BadGuy', allianceName: 'SomeReds', prestige: 5026954, honor: 3392049, level: 10, kind: 'player', relation: 3 }),
  row(470, 340, { name: "Barbarian's city", npc: true, level: 10, kind: 'npc' }),
  row(450, 365, { name: "Barbarian's city", npc: true, level: 10, kind: 'npc' }),
  row(462, 357, { name: "Barbarian's city", npc: true, level: 5, kind: 'npc' }),
  row(452, 350, { name: 'Flat', level: 3, kind: 'flat', type: 10 }),
  row(468, 362, { name: 'Flat', level: 9, kind: 'flat', type: 10 }),
  row(152, 605, { name: 'Target', userName: 'Sleepy', allianceName: 'Nappers', prestige: 99, level: 7, kind: 'player', state: 2, stale: true }),
  row(434, 1, { name: 'Desert', level: 1, kind: 'desert', type: 2 }),
  row(142, 255, { name: "Barbarian's city", npc: true, level: 7, kind: 'npc' }),        // Unsorted 2676's list[id]
];
// The map as the last scan left it: every row seen just now (so a rescan's
// ResetMap does not hide it), except a `stale` one, whose news must come from
// the server (GetDetailInfo asks field.getOtherFieldInfo).
const mapSource = {
  tiles(x1, y1, x2, y2, { castles = false } = {}) {
    return MAP.filter((r) => r.x >= x1 && r.x <= x2 && r.y >= y1 && r.y <= y2 && (!castles || r.userName || r.npc))
      .map(({ stale, ...r }) => ({ ...r, seen: stale ? T0 : Date.now() + 1 }));
  },
};
// common.mapInfoSimple: a 20x20 block of grassland with the map's castles in it
function mapBlock({ x1, y1 }) {
  const x2 = x1 + 19, y2 = y1 + 19;
  const cs = MAP.filter((r) => (r.userName || r.npc) && r.x >= x1 && r.x <= x2 && r.y >= y1 && r.y <= y2)
    .map((r) => ({ id: r.id, name: r.name, userName: r.userName, allianceName: r.allianceName, prestige: r.prestige, honor: r.honor, state: r.state, npc: r.npc, furlough: false }));
  return { ok: 1, x1, y1, x2, y2, mapStr: '51'.repeat(400), castles: cs };
}

// ---------------------------------------------------------------- alliance, reports, players
const at = (y, mo, d, h, mi, s) => new Date(y, mo, d, h, mi, s).getTime();
const MEMBERS = [
  ['Member1', 8, 2827841, at(2011, 4, 23, 23, 30, 1)], ['Member2', 6, 13632813, at(2011, 4, 23, 23, 30, 50)],
  ['Member3', 8, 3266061, at(2011, 4, 23, 23, 30, 21)], ['Member4', 8, 9828232, at(2011, 4, 23, 23, 30, 16)],
  ['Member5', 7, 4304876, at(2011, 4, 23, 23, 28, 43)], ['Member6', 8, 1756597, at(2011, 4, 23, 23, 27, 6)],
].map(([userName, levelId, prestige, lastLoginTime], i) => ({ userName, levelId, prestige, honor: i * 10, lastLoginTime, castleCount: i + 1, population: 1000 * (i + 1) }));
const PLAYERS = {
  bob: { userName: 'Bob', alliance: '', castleCount: 1, prestige: 4991, honor: 0, ranking: 9000, office: '0', titleId: 0, population: 0 },
  fred: { userName: 'Fred', alliance: '', castleCount: 1, prestige: 8060, honor: 0, ranking: 8000, office: '0', titleId: 0, population: 1500 },
  george: { userName: 'George', alliance: '', castleCount: 2, prestige: 10847, honor: 0, ranking: 7000, office: '0', titleId: 1, population: 0 },
  harry: { userName: 'Harry', alliance: '', castleCount: 1, prestige: 0, honor: 0, ranking: 99999, office: '0', titleId: 0, population: 0 },
  somedude: { userName: 'SomeDude', alliance: 'TuffGuys', castleCount: 3, prestige: 5, honor: 0, ranking: 5, office: '1', titleId: 2, population: 777 },
  yayme: { userName: 'YayMe', alliance: 'TuffGuys', castleCount: 2, prestige: 14517826, honor: 212942, ranking: 5, office: '3', titleId: 3, population: 38000 },
  badguy: { userName: 'BadGuy', alliance: 'SomeReds', castleCount: 1, prestige: 5026954, honor: 3392049, ranking: 40, office: '1', titleId: 2, population: 70000 },
};
const REPORTS = [
  { id: 42666, title: 'Attack Reports', eventTime: at(2013, 10, 17, 13, 15, 10), startPos: 'City1(111,111)', targetPos: 'Target(111,333)', attack: true, isRead: 0 },
  { id: 42555, title: 'Scout Reports', eventTime: at(2013, 10, 17, 13, 1, 28), startPos: 'City2(111,222)', targetPos: "Barbarian's city(111,444)", attack: true, isRead: 0 },
];

// ---------------------------------------------------------------- the fake server

// The Game's socket: every request is answered from `handlers` (default
// { ok: 1 }), recorded in `sent`, and matched to its reply by command name.
function fakeClient(handlers, sent) {
  const c = new EventEmitter();
  const queue = new Map();
  c.sock = { destroyed: false };
  c.send = (cmd, data) => {
    sent.push({ cmd, data: JSON.parse(JSON.stringify(data === undefined ? {} : data)) });
    const h = handlers[cmd];
    let reply;
    try { reply = typeof h === 'function' ? h(data || {}) : h !== undefined ? h : { ok: 1 }; } catch (e) { reply = e; }
    if (!queue.has(cmd)) queue.set(cmd, []);
    queue.get(cmd).push(reply === undefined ? { ok: 1 } : reply);
  };
  c.await = async (cmds) => {
    const cmd = cmds.find((x) => queue.has(x) && queue.get(x).length);
    if (!cmd) throw new Error('no reply to ' + cmds.join('/'));
    const r = queue.get(cmd).shift();
    if (r instanceof Error) throw r;
    return { data: r };
  };
  c.close = () => {};
  return c;
}

const B = (typeId, positionId, level, o = {}) => ({ typeId, positionId, level, status: 0, name: (C.BUILDING_BY_ID[typeId] || {}).name, ...o });
const H = (id, name, status, o = {}) => ({ id, name, status, level: 50, power: 100, management: 20, stratagem: 20, loyalty: 100, experience: 0, upgradeExp: 1000, remainPoint: 0, ...o });
const res = (o = {}) => ({
  gold: 5000000, curPopulation: 18000, maxPopulation: 20000, workPeople: 2500, buildPeople: 0, support: 90, complaint: 5,
  troopCostFood: 20000, herosSalary: 1500, texRate: 20, taxIncome: 3000,
  food: { amount: 2000000, increaseRate: 50000, max: 50000000, storeRercent: 25, workPeople: 1000 },
  wood: { amount: 3000000, increaseRate: 9000, max: 50000000, storeRercent: 25, workPeople: 500 },
  stone: { amount: 4000000, increaseRate: 8000, max: 50000000, storeRercent: 25, workPeople: 500 },
  iron: { amount: 5000000, increaseRate: 7000, max: 50000000, storeRercent: 25, workPeople: 500 },
  ...o,
});
const TROOPS = { ...C.EMPTY_TROOPS, peasants: 1000, militia: 50000, scouter: 1200000, pikemen: 10000, swordsmen: 10000, archer: 120000,
  carriage: 5000, lightCavalry: 30000, heavyCavalry: 40000, ballista: 100, batteringRam: 50, catapult: 100 };

// MyCity (460,355) is the running city: seven heroes, a full town, two valleys,
// no trades. Fla (470,360) is under attack from BadGuy, low on food and has its
// gates broken (MonitorCity's three alarms); it has one valley.
function world(o = {}) {
  const g = new Game();
  g.serverOffset = 0;
  const sent = [];
  const timers = new Set();
  const later = (ms, f) => { const x = setTimeout(() => { timers.delete(x); f(); }, ms); timers.add(x); return x; };
  g.player = {
    playerInfo: { userName: 'YayMe', id: 777, alliance: 'TuffGuys', allianceLevel: 3, prestige: 14517826, honor: 212942, castleCount: 2, titleId: 3,
      office: '3', medal: 50, sex: 0, flag: 'NEAT', ranking: 5, population: 38000, createrTime: at(2010, 0, 5, 10, 0, 0), accountName: 'secret@example.com' },
    currentTime: Date.now(), currentDateTime: '2026.09.14 11.30.15',
    items: Object.entries(o.items || { 'player.box.gambling.3': 7, 'player.item.chocolatecoin': 3, 'consume.1.a': 5, 'player.peace.1': 1, 'consume.move.1': 2 })
      .map(([id, count]) => ({ id, count })),
    friendBeans: [{ userName: 'Pal' }, { userName: 'Buddy' }, { userName: 'Chum' }],
    blockBeans: [],
    buffs: [],
    selfArmys: [],
    enemyArmys: [
      { armyId: 501, missionType: 5, direction: 1, startFieldId: F(466, 350), targetFieldId: F(470, 360), king: 'BadGuy', alliance: 'SomeReds',
        startPosName: 'RedKeep', targetPosName: 'Fla', troop: { ...C.EMPTY_TROOPS, archer: 50000, ballista: 4000 }, resource: {}, reachTime: Date.now() + 3600000 },
    ],
    friendArmys: [],
    castleSignBean: [],
  };
  const home = {
    id: 1, name: 'MyCity', fieldId: F(460, 355), logUrl: 'images/icon/cityLogo/citylogo_02.png', status: 0, allowAlliance: true, buffs: [],
    heros: [
      H(11, 'Queen', 1, { level: 193, power: 67, management: 254, stratagem: 21, experience: 4737560, upgradeExp: 3724900 }),
      H(12, 'Farmer1', 0, { level: 297, power: 363, management: 27, stratagem: 21, experience: 10180331, upgradeExp: 8820900 }),
      H(13, 'BigGuy', 0, { level: 346, power: 414, management: 21, stratagem: 46, experience: 8467980, upgradeExp: 11971600 }),
      H(14, 'Goliath', 0, { level: 100, power: 250 }),
      H(15, 'Scouty', 0, { level: 60, power: 150 }),
      H(16, 'Trebber', 0, { level: 120, power: 280 }),
      H(17, 'Smarty', 0, { level: 90, power: 40, stratagem: 200 }),
      H(18, 'Spam1', 0, { level: 20, power: 60 }), H(19, 'Spam2', 0, { level: 20, power: 61 }),
      H(20, 'Spam3', 0, { level: 20, power: 62 }), H(22, 'Spam4', 0, { level: 20, power: 63 }),
    ],
    troop: { ...TROOPS },
    resource: res(),
    fortification: { trap: 100, abatis: 200, arrowTower: 300, rollingLogs: 0, rockfall: 11000 },
    buildings: o.buildings || [
      B(31, -1, 10), B(32, -2, 9), B(25, 0, 9), B(22, 1, 8), B(27, 3, 10), B(23, 4, 7), B(29, 8, 10), B(26, 7, 5),
      B(2, 11, 9), B(2, 18, 10), B(1, 12, 9), B(1, 13, 9), B(1, 14, 3),
      B(7, 1001, 9), B(4, 1002, 9), B(5, 1003, 9), B(6, 1004, 9), B(6, 1005, 5),
    ],
    fields: [{ id: F(461, 356), level: 7, name: 'Forest', statu: 0, type: 1 }, { id: F(459, 357), level: 3, name: 'Lake', statu: 0, type: 6 }],
    trades: [], transingTrades: [],
  };
  const fla = {
    id: 2, name: 'Fla', fieldId: F(470, 360), status: 0, buffs: [{ typeId: 'ForceopenclosegateBuff', endTime: Date.now() + 3600000, descName: 'Gates forced open' }],
    heros: [H(21, 'Dee', 0, { level: 30, power: 80 })],
    troop: { ...C.EMPTY_TROOPS, archer: 1000, carriage: 100, scouter: 10 },
    resource: res({ food: { amount: 50000, increaseRate: 100, max: 5000000, storeRercent: 25, workPeople: 10 }, troopCostFood: 20000, gold: 100000, curPopulation: 5000, maxPopulation: 8000 }),
    buildings: [B(31, -1, 5), B(32, -2, 3), B(1, 12, 4)],
    fields: [{ id: F(471, 361), level: 2, name: 'Grassland', statu: 0, type: 5 }],
    trades: [], transingTrades: [],
  };
  g.castles = [home, fla, ...(o.moreCastles || [])];
  // rich: the names the wiki's one-line examples use (the matrix runner's world) —
  // heroes Ken, Henry, Ace..., a prisoner Bob, an army out to 111,222 (army id
  // 100333040, IdRecall's), an attack on MyCity, a trade and one in transit, a
  // valley at 111,222, War Ensigns, buildings on plots 2 and 15
  if (o.rich) {
    for (const [i, n] of ['Ken', 'Henry', 'Ace', 'Hero', 'BigDude', 'Bubba', 'Xavier', 'Biggy', 'Polly', 'billybob', 'Robert1', 'Robert2'].entries()) {
      home.heros.push(H(40 + i, n, 0, { level: 60 + i, power: 150 + i * 10 }));
    }
    home.heros.push(H(60, 'Bob', 4, { level: 90, power: 200 }), H(61, 'Fred', 3, { level: 80, power: 180 }));
    g.player.selfArmys.push({ armyId: 100333040, direction: 1, missionType: 5, startFieldId: home.fieldId, targetFieldId: F(111, 222), startPosName: 'MyCity',
      targetPosName: 'Target', hero: 'Fred', heroLevel: 80, troop: { ...C.EMPTY_TROOPS, archer: 5000, carriage: 10 }, resource: { food: 30000 }, startTime: Date.now() - 60000, reachTime: Date.now() + 600000 });
    g.player.enemyArmys.push({ armyId: 502, missionType: 5, direction: 1, startFieldId: F(466, 350), targetFieldId: home.fieldId, king: 'BadGuy', alliance: 'SomeReds',
      startPosName: 'RedKeep', targetPosName: 'MyCity', troop: { ...C.EMPTY_TROOPS, ballista: 3000 }, resource: {}, reachTime: Date.now() + 1800000 });
    home.trades.push({ id: 7001, resType: 0, tradeType: 1, amount: 100000, price: 1.2, dealedAmount: 0, dealedTotal: 0 });
    home.transingTrades.push({ id: 601, resType: 1, amount: 50000, price: 0.5, endTime: Date.now() + 60000, total: 25000 });
    home.fields.push({ id: F(111, 222), level: 4, name: 'Hill', statu: 0, type: 3 });
    home.buildings.push(B(28, 2, 3), B(1, 15, 5));
    g.player.items.push({ id: 'player.troop.1.a', count: 5 });
    g.player.playerInfo.flag = 'OLD';
  }
  const cityOf = (d) => g.castles.find((c) => c.id === Number(d.castleId ?? d.castleid)) || home;
  const beanAt = (c, pos) => (c.buildings || []).find((b) => b.positionId === pos);
  // constructions land a moment after they start (the pushes session.js applies)
  const jobMs = o.jobMs ?? 5;
  function start(c, pos, dir, typeId) {
    let b = beanAt(c, pos);
    if (!b) { b = B(typeId, pos, 0); c.buildings.push(b); }
    Object.assign(b, { status: dir === 'up' ? 1 : 2, startTime: g.now(), endTime: g.now() + jobMs });
    later(jobMs, () => { if (b.status === 1) b.level++; else if (b.status === 2) b.level--; Object.assign(b, { status: 0, endTime: 0 }); });
  }
  let nextArmy = 900;
  const cond = () => ({ food: 100, wood: 100, stone: 100, iron: 100, gold: 0, time: 100, buildings: [], techs: [] });
  const techs = [
    { typeId: 1, level: 3, avalevel: 10, upgradeing: false, castleId: 1, startTime: 0, endTime: 0, permition: true, conditionBean: cond() },     // agriculture
    { typeId: 12, level: 2, avalevel: 10, upgradeing: false, castleId: 1, startTime: 0, endTime: 0, permition: true, conditionBean: cond() },    // compass
    { typeId: 14, level: 8, avalevel: 10, upgradeing: false, castleId: 1, startTime: 0, endTime: 0, permition: true, conditionBean: cond() },    // archery
    { typeId: 17, level: 1, avalevel: 10, upgradeing: false, castleId: 1, startTime: 0, endTime: 0, permition: true, conditionBean: cond() },    // construction
    { typeId: 11, level: 5, avalevel: 10, upgradeing: true, castleId: 2, startTime: Date.now() - 1000, endTime: Date.now() + 3600000, permition: true, conditionBean: cond() },
  ];
  const members = MEMBERS.map((m) => ({ ...m }));
  const detailCalls = new Map();
  const quests = questBook();
  const market = { food: [4.2, 4.4], wood: [0.9, 1.0], stone: [1.1, 1.2], iron: [2.0, 2.2] };      // bid, ask
  const DEF = {
    // ---- the city
    'castle.getAvailableBuildingBean': (d) => ({ ok: 1, builingList: [{ typeId: d.typeId, conditionBean: { food: 100, wood: 200, stone: 300, iron: 50, gold: 0, time: 30, buildings: [], techs: [], items: [] } }] }),
    'castle.checkOutUpgrade': () => ({ ok: 1, conditionBean: { food: 100, wood: 200, stone: 300, iron: 50, gold: 0, time: 30, buildings: [], techs: [], items: [] } }),
    'castle.newBuilding': (d) => { start(cityOf(d), d.positionId, 'up', d.buildingType); return { ok: 1 }; },
    'castle.upgradeBuilding': (d) => { start(cityOf(d), d.positionId, 'up'); return { ok: 1 }; },
    'castle.destructBuilding': (d) => { start(cityOf(d), d.positionId, 'down'); return { ok: 1 }; },
    // a research runs jobMs, then ResearchCompleteUpdate (the push startresearch waits for)
    'tech.getResearchList': () => ({ ok: 1, acailableResearchBeans: techs.map((b) => ({ ...b })) }),
    'tech.research': (d) => {
      const bean = techs.find((b) => b.typeId === d.techId);
      if (!bean) return { ok: -1, errorMsg: 'no such tech' };
      Object.assign(bean, { upgradeing: true, castleId: Number(d.castleId), startTime: g.now(), endTime: g.now() + jobMs });
      later(jobMs, () => { Object.assign(bean, { upgradeing: false, level: bean.level + 1, endTime: 0 }); g.c.emit('cmd', 'server.ResearchCompleteUpdate', { castleId: Number(d.castleId) }); });
      return { ok: 1, tech: { ...bean } };
    },
    'tech.cancelResearch': () => { for (const b of techs) if (b.upgradeing && b.typeId !== 11) Object.assign(b, { upgradeing: false, endTime: 0 }); return { ok: 1 }; },
    'hero.getHerosListFromTavern': { ok: 1, heros: [{ id: 91, name: 'InnGuy', level: 30, power: 80, management: 20, stratagem: 15, status: 0 },
      { id: 92, name: 'InnBrain', level: 25, power: 30, management: 70, stratagem: 20, status: 0 }] },
    'troop.getProduceQueue': { ok: 1, allProduceQueue: [] },
    'fortifications.getProduceQueue': { ok: 1, allProduceQueue: [] },
    'troop.checkIdleBarrack': { ok: 1, barracks: [] },
    'interior.getResourceProduceData': { ok: 1, resourceProduceDataBean: [{ typeid: 1, commenceRate: 100 }, { typeid: 2, commenceRate: 100 }, { typeid: 3, commenceRate: 100 }, { typeid: 4, commenceRate: 100 }] },
    'field.giveUpField': (d) => {
      for (const c of g.castles) {
        const i = (c.fields || []).findIndex((f) => f.id === d.fieldId);
        if (i >= 0) { c.fields.splice(i, 1); return { ok: 1 }; }
      }
      return { ok: -1, errorMsg: 'not your field' };
    },
    // ---- marches
    'army.getTroopParam': { ok: 1, marchSkillParam: 0, driveSkillParam: 0, loadSkillParam: 0, transportStationParam: 0 },
    'field.getOtherFieldInfo': (d) => {
      const n = (detailCalls.get(d.fieldId) || 0) + 1;
      detailCalls.set(d.fieldId, n);
      const r = MAP.find((m) => m.id === d.fieldId);
      const { x, y } = C.fieldIdToCoords(d.fieldId);
      // PeacetimeStatusChecker's target: no answer the first time (the script's
      // `if !x repeat` asks again), at war the second, in peacetime after that
      if (r && r.name === 'Target' && n === 1) return { ok: 1, bean: null };
      const state = r && r.name === 'Target' ? (n >= 3 ? 1 : 2) : r ? r.state : 1;
      return { ok: 1, bean: r ? { id: r.id, name: r.name, userName: r.userName || null, allianceName: r.allianceName || null, prestige: r.prestige, honor: r.honor,
        state, npc: !!r.npc, relation: r.relation ?? 6, zoneName: C.zoneOf(x, y), canScout: true, canOccupy: false, furlough: false }
        : { id: d.fieldId, name: 'Grassland', userName: null, allianceName: null, prestige: 0, honor: 0, state: 1, npc: false, relation: 6, zoneName: C.zoneOf(x, y), canScout: true, canOccupy: true } };
    },
    'army.newArmy': (d) => {
      const c = cityOf(d);
      const bean = d.newArmyBean;
      const armyId = nextArmy++;
      g.player.selfArmys = [...g.player.selfArmys, { armyId, direction: 1, missionType: bean.missionType, startFieldId: c.fieldId, targetFieldId: bean.targetPoint,
        startPosName: c.name, targetPosName: 'there', reachTime: g.now() + 600000, restTime: bean.restTime, troop: bean.troops, resource: bean.resource,
        hero: bean.heroId !== undefined ? (c.heros.find((h) => h.id === bean.heroId) || {}).name : undefined }];
      if (bean.heroId !== undefined) { const h = c.heros.find((x) => x.id === bean.heroId); if (h) h.status = 3; }
      return { ok: 1 };
    },
    'army.callBackArmy': (d) => {
      const a = g.player.selfArmys.find((x) => x.armyId === d.armyId);
      if (a) {
        a.direction = 2; a.reachTime = g.now() + 20;
        later(o.homeMs ?? 25, () => { g.player.selfArmys = g.player.selfArmys.filter((x) => x !== a); });
      }
      return { ok: 1 };
    },
    // ---- teleports (teleport.js waits for the CastleUpdate push)
    'common.zoneInfo': { ok: 1, zones: C.ZONES.map((name, i) => ({ id: i, name, playerCount: 10, castleCount: 20, rate: 5 })) },
    'city.moveCastle': (d) => {
      const zone = C.ZONES[d.zoneId];
      let to = null;
      for (let y = 0; y < 800 && !to; y += 50) for (let x = 0; x < 800 && !to; x += 50) if (C.zoneOf(x, y) === zone) to = F(x + 7, y + 7);
      setImmediate(() => g.c.emit('cmd', 'server.CastleUpdate', { updateType: 2, castleBean: { id: d.castleId, fieldId: to } }));
      return { ok: 1 };
    },
    // ---- the map
    'common.mapInfoSimple': (d) => mapBlock(d),
    // ---- chat, friends, alliance, players, reports
    'alliance.getAllianceMembers': () => ({ ok: 1, members: members.map((m) => ({ ...m })) }),
    'friend.deleteFriend': (d) => { g.player.friendBeans = g.player.friendBeans.filter((f) => f.userName !== d.userName && f.userName !== d.friendName); return { ok: 1 }; },
    'common.getPlayerInfoByName': (d) => {
      const p = PLAYERS[String(d.userName || '').toLowerCase()];
      return p ? { ok: 1, playerInfo: p } : { ok: -4, errorMsg: 'The player does not exist' };
    },
    'report.receiveReportList': (d) => ({ ok: 1, pageNo: d.pageNo, totalPage: 53, reports: REPORTS }),
    // ---- quests (CompleteQuests)
    'quest.getQuestType': (d) => ({ ok: 1, types: (quests.types[d.type] || []).map((ty) => ({ ...ty, isFinish: quests.list[ty.typeId].some((q) => q.isFinish) })) }),
    'quest.getQuestList': (d) => ({ ok: 1, quests: JSON.parse(JSON.stringify(quests.list[d.typeId] || [])) }),
    'quest.award': (d) => {
      for (const list of Object.values(quests.list)) {
        const i = list.findIndex((q) => q.questId === d.questId);
        if (i >= 0) { if (!list[i].isFinish) return { ok: -1, errorMsg: 'not finished' }; list.splice(i, 1); return { ok: 1 }; }
      }
      return { ok: -1, errorMsg: 'no such quest' };
    },
    // ---- items
    'shop.useGoods': (d) => {
      const it = g.player.items.find((x) => x.id === d.itemId);
      if (!it || it.count < 1) return { ok: -1, errorMsg: 'no such item' };
      it.count -= Number(d.num || 1);
      if (it.count <= 0) g.player.items = g.player.items.filter((x) => x !== it);
      return { ok: 1 };
    },
    // ---- the market (bid/ask per resource; trade.newTrade places an offer in the city)
    'trade.searchTrades': (d) => {
      const name = ['food', 'wood', 'stone', 'iron'][d.resType];
      const [bid, ask] = market[name];
      return { ok: 1, resType: d.resType, buyers: [{ price: bid, amount: 5000000 }], sellers: [{ price: ask, amount: 5000000 }] };
    },
    'trade.getMyTradeList': (d) => ({ ok: 1, trades: cityOf(d).trades.map((x) => ({ ...x })) }),
    'trade.newTrade': (d) => {
      const c = cityOf(d);
      c.trades.push({ id: 7000 + c.trades.length, resType: d.resType, tradeType: d.tradeType, amount: d.amount, price: Number(d.price), dealedAmount: 0, dealedTotal: 0 });
      return { ok: 1 };
    },
    'trade.cancelTrade': (d) => { const c = cityOf(d); c.trades = c.trades.filter((x) => x.id !== d.tradeId); return { ok: 1 }; },
  };
  const handlers = { ...DEF, ...(o.handlers || {}) };
  g.c = fakeClient(handlers, sent);
  g.reportList = (type, pageNo, pageSize) => g.req('report.receiveReportList', { pageNo, pageSize, reportType: C.REPORT_TYPE[type] });
  const close = () => { for (const x of timers) clearTimeout(x); timers.clear(); };
  return { g, sent, home, fla, members, quests, market, close, of: (cmd) => sent.filter((s) => s.cmd === cmd).map((s) => s.data), cmds: () => sent.map((s) => s.cmd) };
}

// Routine types Rebuild, Promotion, Commodity Gathering; one daily type.
function questBook() {
  return {
    types: {
      1: [{ typeId: 10, mainId: 1, name: 'Rebuild' }, { typeId: 11, mainId: 1, name: 'Promotion' }, { typeId: 12, mainId: 1, name: 'Commodity Gathering' }],
      3: [{ typeId: 30, mainId: 3, name: 'Daily Quests' }],
    },
    list: {
      10: [{ questId: 101, name: 'Build a Cottage', isFinish: true, award: '500 food', targets: [{ name: 'Cottage level 1', finished: true }] },
        { questId: 102, name: 'Chatting', isFinish: false, targets: [{ name: 'Say something in alliance chat', finished: false }] }],
      11: [{ questId: 111, name: 'Baronet', isFinish: true }],
      12: [{ questId: 121, name: 'Farming', isFinish: true, award: '1000 food' },
        { questId: 122, name: 'Lumbering', isFinish: false, targets: [{ name: 'Scout city', finished: false }, { name: 'Sawmill level 2', finished: true }] }],
      30: [{ questId: 301, name: 'Login daily and you will get this great gift!', isFinish: true, award: '1 x Aries Amulet' }],
    },
  };
}

// The run options every example gets: waits at 1/10000 of their time, no
// pacing between chat lines, the fake map, say/play collected.
const QUICK = { castle: 'MyCity', timeScale: 0.0001, repeatGapMs: 0, chatGapMs: 0, worldGapMs: 0, mailGapMs: 0, notifyGapMs: 0, postGapMs: 0,
  tradeGapMs: 0, marketRetryMs: 5, chatWaitMs: 200, scanGapMs: 0, scanTimeoutMs: 300, mapSource,
  cityPollMs: 2, cityGraceMs: 30, cityRecheckMs: 3, cityPlotWaitMs: 60, cityPushWaitMs: 40 };

// Load a script (it must load with no error) and run it. keep(x) records a value.
async function runIn(w, src, opts = {}) {
  const out = [], kept = [], heard = [];
  const globals = { keep: (v) => { kept.push(v); return v; } };
  const view = script.parse(src, { globals });
  const bad = view.filter((a) => a.cmd === 'error');
  if (bad.length && !opts.allowErrors) throw new Error('the script does not load: ' + bad.map((b) => `line ${b.line}: ${b.error}`).join('; '));
  let done;
  // the time limit is real time (withClock moves Date.now)
  const t0 = performance.now();
  const limit = opts.limitMs ?? 8000;
  const stop = opts.shouldStop;
  try {
    done = await script.run(w.g, view, (m) => { out.push(m); if (opts.tap) opts.tap(m, out); }, {
      ...QUICK, notify: (m) => { heard.push(m); return 1; }, ...opts, globals: { ...globals, ...(opts.globals || {}) },
      shouldStop: () => performance.now() - t0 > limit || !!(stop && stop(out)),
    });
  } finally { w.close(); }
  return { done, out, kept, heard, text: out.join('\n'), warnings: view.warnings, timedOut: performance.now() - t0 > limit };
}
// the lines an echo printed ("  text" under its header)
function printed(r) {
  const got = [];
  let echo = false;
  for (const l of r.out) {
    if (/^line \d+: /.test(l)) { echo = /\b(echo|print)\b/.test(l.replace(/^line \d+: /, '').replace(/"[^"]*"/g, '""')); continue; }
    if (echo && /^ {2}/.test(l)) got.push(l.slice(2));
  }
  return got;
}
const failures = (r) => r.out.filter((l) => /FAILED|PARSE ERROR/.test(l));
const noFailures = (r, allow = []) => {
  const bad = failures(r).filter((l) => !allow.some((re) => re.test(l)));
  assert.deepStrictEqual(bad, [], r.text);
};

// ---------------------------------------------------------------------------
section('ScriptExamples: AbandonAllValleys');

const ABANDON_ONE = `label abandonAllValleys
if city.fields.length = 0 goto done
execute "abandon " + city.fields[0].coords
if !$error goto abandonAllValleys

label done`;
const ABANDON_ALL = `cs = cities.concat()
label nextcity
c = cs.shift()
if c fs = c.cityManager.fields.toArray()
label nextfield
if c f = fs.shift()
if c if f execute "abandon " + f.coords
if c if f if !$error goto nextfield
if c goto nextcity
echo "Finished"`;

t('AbandonAllValleys: the one-city script gives up every valley of MyCity and stops', async () => {
  const w = world();
  const r = await runIn(w, ABANDON_ONE);
  eq(w.of('field.giveUpField').map((d) => C.fieldIdToCoords(d.fieldId)), [{ x: 461, y: 356 }, { x: 459, y: 357 }]);
  eq(w.home.fields, []);
  eq(w.fla.fields.length, 1, 'the other city keeps its valley');
  noFailures(r);
});
t('AbandonAllValleys: the all-cities script gives up every valley of every city', async () => {
  const w = world();
  const r = await runIn(w, ABANDON_ALL);
  eq(w.of('field.giveUpField').length, 3);
  eq([w.home.fields.length, w.fla.fields.length], [0, 0]);
  eq(printed(r).slice(-1), ['Finished']);
  noFailures(r);
});

// The goals layer (goals/integration's goallayers.js) stands in: goal lines in
// scripts land here.
function goalLayer() {
  const L = { SCRIPT_MAX_LINES: 100, added: [], loaded: [], layer: null };
  L.addScriptLine = (acc, cid, line) => { L.added.push(line); L.layer = { base: 'saved', count: L.added.length, src: L.added.join('\n') }; return { errors: [], lines: [{ status: 'ok' }], layer: L.layer }; };
  L.loadScriptGoals = (acc, cid, which) => { L.loaded.push(which); const cleared = !!L.layer; L.layer = null; return { errors: [], lines: [], layer: null, cleared }; };
  L.resetScriptGoals = () => { L.layer = { base: 'reset', count: 0, src: '' }; return { errors: [], lines: [], layer: L.layer }; };
  L.getScriptLayer = () => L.layer;
  return L;
}

// ---------------------------------------------------------------------------
section('ScriptExamples: AutoTeleporter');

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

t('AutoTeleporter (-teleport tuscany): war-town goals, recall, wait for the armies, teleport, then loadgoals (Fla is still elsewhere)', async () => {
  const w = world();
  const home = w.home.fieldId;
  w.g.player.selfArmys = [{ armyId: 9, direction: 1, missionType: 5, startFieldId: home, targetFieldId: F(470, 340), reachTime: Date.now() + 60000, troop: { archer: 1 } }];
  const GL = goalLayer();
  const r = await runIn(w, AUTO_TELEPORTER, { config: { teleport: 'tuscany' }, goalLayers: GL, session: { account: { id: 'a1' }, notify() {} } });
  eq(GL.added, ['config wartown:2,comfort:1']);
  eq(w.of('army.callBackArmy').map((d) => d.armyId), [9]);
  eq(w.of('city.moveCastle').map((d) => C.ZONES[d.zoneId]), ['Tuscany']);
  eq(C.zoneOf(...Object.values(C.fieldIdToCoords(w.home.fieldId))), 'Tuscany');
  const said = r.heard.map((m) => m.text);
  eq(said.slice(-1), ['Trying to teleport MyCity to TUSCANY']);
  assert.ok(said.slice(0, -1).every((m) => m === 'Still have armies'), 'while the army is on its way home');
  eq(GL.loaded, [''], 'Fla is not in Tuscany: loadgoals');
  noFailures(r);
});
t('AutoTeleporter: already in the state, or no -teleport: it does nothing', async () => {
  let w = world();
  let r = await runIn(w, AUTO_TELEPORTER, { config: { teleport: 'thuringia' }, goalLayers: goalLayer() });
  eq(w.of('city.moveCastle'), []);
  eq(w.of('army.callBackArmy'), []);
  noFailures(r);
  w = world();
  r = await runIn(w, AUTO_TELEPORTER, { config: {}, goalLayers: goalLayer() });
  eq(w.sent.filter((s) => !/getTroopParam/.test(s.cmd)), []);
  noFailures(r);
});

// ---------------------------------------------------------------------------
section('ScriptExamples: MonitorCity');

const MONITOR_CITY = `// Only put this in one city to run. Does not need to be in all.
// It will check all your cities for incoming attacks and food shortage and broken gates.
// When incoming attacks are spotted or your gates are broken, it will talk outloud thru your speakers, and in ally chat.
// It will ignore incoming attacks from any of the specified alliances, so you can attack your alts or be treb hit by alts without spamming AC.
// You can disable config warrules and audio attack/tts attack warning if you use this, since it covers all 3 areas.
label autorun

label checkincoming
x = 0

label nextcity
cs = cities[x]
if cs == null sleep 10
if cs == null goto checkincoming
cm = cs.cityManager
enemy = cm.enemyArmies[0]

if enemy gosub gethelp
if cm.resource.food.amount / cm.resource.troopCostFood < 5 gosub getfood
if cm.buff("ForceopenclosegateBuff") gosub gatesbroken

x = x + 1
goto nextcity

label gethelp
// Below you can add the names of your alliance and alt alliances that may be attacking you with your permission.
// You can also (or instead) add the names of yourself or authorized people that can attack with permission.
// Add more lines if you need more exemptions, or delete any of these lines you don't need.
// Don't forget to keep the "quotes" around the names, for example:
// if enemy.king == "Inanna" return
// ----------------------------------
if enemy.alliance == "YOUR_ALLIANCE_HERE" return
if enemy.alliance == "YOUR_ALT_ALLIANCE_HERE" return
if enemy.king == "YOUR_NAME_HERE" return
if enemy.king == "YOUR_FRIEND'S_NAME_HERE" return
// ----------------------------------
// End of the section to add exemptions for attack warnings. Don't delete stuff below :P

message = "City " + cm.name + " @ " + cm.coords + " is under attack from " + enemy.king + " in alliance " + enemy.alliance + ". Save me!!!"
goto yellIt

label getfood
message = "City " + cm.name + " @ " + cm.coords + " is at " + floor(cm.resource.food.amount / cm.resource.troopCostFood) + " hours of food. Feed me Seymour!!!"
goto yellIt

label gatesbroken
message = "City " + cm.name + " @ " + cm.coords + " has broken gates!! Please let me know ASAP or log me on and save me!!!"
goto yellIt

label yellIt
echo message
execute "alliancechat " + message
say message
sleep 300
return`;

t('MonitorCity: Fla under attack, low on food and with broken gates — three alarms in alliance chat, spoken and echoed; MyCity is quiet', async () => {
  const w = world();
  const r = await runIn(w, MONITOR_CITY, { startLine: 'autorun', shouldStop: (out) => out.some((l) => /^line \d+: if cs == null sleep 10$/.test(l)) });
  const alarms = [
    'City Fla @ 470,360 is under attack from BadGuy in alliance SomeReds. Save me!!!',
    'City Fla @ 470,360 is at 2 hours of food. Feed me Seymour!!!',
    'City Fla @ 470,360 has broken gates!! Please let me know ASAP or log me on and save me!!!',
  ];
  eq(w.of('common.allianceChat').map((d) => d.msg), alarms);
  eq(r.heard.map((m) => [m.kind, m.text]), alarms.map((a) => ['say', a]));
  eq(printed(r).filter((l) => /^City /.test(l)), alarms);
  noFailures(r);
});

// ---------------------------------------------------------------------------
section('ScriptExamples: PeacetimeStatusChecker');

const PEACETIME = `target = "152,605"

// Nothing to edit below here.
label start
execute "scanmap " + target + " 5"
x = GetDetailInfo(GetFieldId(target), false, 60)
if !x repeat
if x.state != 1 goto statex
echo "*** ATTENTION *** " + x.userName + " is now in peacetime!"
execute "alliancechat *** ATTENTION *** " + x.userName + " is now in peacetime!"
end

label statex
echo x.userName + " is not in peacetime yet, so we'll keep checking."
sleep 300
goto start `;

// NEAT's waits pass real time: a `sleep N` line moves the clock N seconds on
// (cached details go stale as they would), while the wait itself is timeScale short.
async function withClock(f) {
  const real = Date.now;
  let skew = 0;
  Date.now = () => real() + skew;
  try { return await f((m) => { const s = /sleep (\d+)$/.exec(m); if (s) skew += Number(s[1]) * 1000; }); } finally { Date.now = real; }
}

t('PeacetimeStatusChecker: scans 152,605, asks again until the detail comes, sees no peace, sleeps, looks again, then tells the alliance', async () => {
  const w = world();
  const r = await withClock((tap) => runIn(w, PEACETIME, { tap }));
  assert.ok(w.of('common.mapInfoSimple').length >= 1, 'scanmap asked the server');
  eq(w.of('field.getOtherFieldInfo').filter((d) => d.fieldId === F(152, 605)).length, 3, r.text);
  eq(printed(r).filter((l) => /peacetime/.test(l)), ["Sleepy is not in peacetime yet, so we'll keep checking.", '*** ATTENTION *** Sleepy is now in peacetime!']);
  eq(w.of('common.allianceChat').map((d) => d.msg), ['*** ATTENTION *** Sleepy is now in peacetime!']);
  assert.ok(!r.timedOut, 'it ended by itself');
  noFailures(r);
});

// ---------------------------------------------------------------------------
section('ScriptExamples: PromoAddFriend, SortingMemberList');

const PROMO = `// compliments of Sericom, I think
command "members"
echo $result.replace(/"([^"]+).+/gm, "addfriend $1").split("\\n").splice(1).join("\\n")`;
const PROMO_CLEAR = `execute "removefriend " + player.friendBeansArray[0].userName
if player.friendBeansArray.length > 0 loop`;
const SORTING = `command "members"
execute "members = [ " + $result.replace(/^(".*?"),(".*?"),"(.*?)","(.*?)",(".*?"),"(.*?)","(.*?)".*?$/gm, "\\{ lord:$1, position:$2,prestige:$3,honor:$4,lastlogin:date($5),cities:$6,population:$7 \\}").split("\\n").splice(1).join(",\\n") + " ]"

top = members.sortOn("prestige", 18)[0]
echo "Highest prestige member is " + top.lord + ", prestige=" + FormatNumber(top.prestige)

last = members.sortOn("lastlogin", 18)[0]
echo "Most recent login is " + last.lord + ", login=" + last.lastlogin`;

t('PromoAddFriend: one addfriend line per alliance member, ready to paste', async () => {
  const w = world();
  const r = await runIn(w, PROMO);
  eq(printed(r).filter((l) => /^addfriend /.test(l)), MEMBERS.map((m) => 'addfriend ' + m.userName));
  noFailures(r);
});
t('PromoAddFriend (clear the list first): removefriend the first friend until none is left', async () => {
  const w = world();
  const r = await runIn(w, PROMO_CLEAR);
  eq(w.of('friend.deleteFriend').length, 3, r.text);
  eq(w.g.player.friendBeans, []);
  noFailures(r);
});
t('SortingMemberList: the CSV becomes objects; sortOn finds the top prestige and the latest login', async () => {
  const w = world();
  const r = await runIn(w, SORTING);
  const lines = printed(r);
  assert.ok(lines.includes('Highest prestige member is Member2, prestige=13,632,813'), r.text);
  assert.ok(lines.some((l) => /^Most recent login is Member2, login=/.test(l)), r.text);
  noFailures(r);
});

// ---------------------------------------------------------------------------
section('ScriptExamples: TravelInfo, Travelinfo, TroopAndResourceTotals');

const TRAVELINFO_VARS = `tr = "a:94k,t:2k,w:2k,s:2k"
x = city.x + 20
y = city.y + 30

targetId = GetFieldId(x, y)
trBean = GetTroops(tr)
attackTime = city.getTravelTime(city.fieldId, targetId, trBean, 5)
transTime = city.getTravelTime(city.fieldId, targetId, trBean, 2)
carryingLoad = city.getCarryingLoad(trBean)
echo "Distance to " + city.coords + ": " + FormatDistance(city.fieldId, targetId)
echo "Carrying load: " + carryingLoad
echo "Attack time: " + attackTime + " secs, load: " + floor(carryingLoad - trBean.foodConsumption(attackTime * 2))
echo "Reinforce time: " + transTime + " secs, load: " + floor(carryingLoad - trBean.foodConsumption(transTime * 2))`;

t('TravelInfo: travelinfo 111,222 cav:10,cata:10 prints the distance, the two march times and what they carry', async () => {
  const w = world();
  const r = await runIn(w, 'travelinfo 111,222 cav:10,cata:10');
  assert.match(r.text, /Distance to 111,222: [\d.]+ ?miles/i);
  assert.match(r.text, /attack time: /i);
  assert.match(r.text, /reinforce time: /i);
  assert.match(r.text, /carrying total\/attack\/reinforce: -?\d+\/-?\d+\/-?\d+/i);
  noFailures(r);
});
t('Travelinfo (in variables): times, load and food from the troop bean', async () => {
  const w = world();
  const r = await runIn(w, TRAVELINFO_VARS);
  const lines = printed(r);
  eq(lines[0], 'Distance to 460,355: ' + (Math.floor(Math.hypot(20, 30) * 100) / 100).toFixed(2) + ' miles');
  assert.match(lines[1], /^Carrying load: \d+$/);
  assert.match(lines[2], /^Attack time: \d+ secs, load: -?\d+$/);
  assert.match(lines[3], /^Reinforce time: \d+ secs, load: -?\d+$/);
  const [atk, rei] = [+/Attack time: (\d+)/.exec(lines[2])[1], +/Reinforce time: (\d+)/.exec(lines[3])[1]];
  assert.ok(atk > 0 && atk === rei, 'to a tile that is not ours both march alike (the Relief Station speeds only reinforcements between our own cities)');
  noFailures(r);
});

const TOTALS_NEW = `// --------------------------------
// Troop & Resource Totals
// --------------------------------
res = GetResources("f:0")
troops = GetTroops("a:0")
upkeep = 0
cities.forEach(CreateFunction("city,ind,arr","troops.add(city.cityManager.getAvailableTroop())||city.cityManager.estResource.addTo(res)||upkeep+=city.cityManager.resource.troopCostFood"))
echo "{CenterPad("\\nTOTAL TROOPS:\\n", 43, "=")}\\n{TroopBeanToString(troops,"\\n")}\\nUpkeep:{FormatNumber(upkeep)}\\n\\n{CenterPad("\\nTOTAL RESOURCES:\\n", 52, "=")}\\nGold:{FormatNumber(res.gold)}\\nFood:{FormatNumber(res.food)}\\nWood:{FormatNumber(res.wood)}\\nStone:{FormatNumber(res.stone)}\\nIron:{FormatNumber(res.iron)}"`;
const TOTALS_OLD = `// =======================================================
// Troop & Resource Totals For Each City & Entire Account
// Originally by romulus
// Requires NeatBot 3010 or later
// =======================================================

// set this to 1 if you want individual city troop/res counts displayed too, 0 if not
showcities = 0

mycities = cities.concat()
echo "ACCOUNT TOTALS: Found " + mycities.length + " castle(s)"
echo "Please wait. Calculating..."
t = GetTroops("a:0")
res = GetResources("f:0")
pop = 0
popmax = 0
up = 0

label mainLoop
c = mycities.shift()
if !c goto end
c = c.cityManager
tr = c.getAvailableTroop()
up = up + c.resource.troopCostFood
cres = c.resetEstResource()
popmax = popmax + c.resource.maxPopulation
pop = pop + c.resource.curPopulation
if showcities echo "City " + c.name + " - " + TroopBeanToString(tr, ",") + " (Upkeep: " + FormatNumber(c.resource.troopCostFood) + ")\\nGold: " + FormatNumber(cres.gold) + " Food: " + FormatNumber(cres.food) + " Wood: " + FormatNumber(cres.wood) + " Stone: " + FormatNumber(cres.stone) + " Iron: " + FormatNumber(cres.iron) + " Population: " + floor(pop) + " of " + floor(popmax)
dummy = tr.addTo(t)
dummy = cres.addTo(res)
goto mainLoop

label end
echo "===========================\\nTOTAL TROOPS\\n===========================\\n" + TroopBeanToString(t, "\\n") + "\\n(Upkeep: " + FormatNumber(up) + ")\\n===========================\\nTOTAL RESOURCES\\n===========================\\nGold: " + FormatNumber(res.gold) + "\\nFood: " + FormatNumber(res.food) + "\\nWood: " + FormatNumber(res.wood) + "\\nStone: " + FormatNumber(res.stone) + "\\nIron: " + FormatNumber(res.iron) + "\\n(Pop: " + FormatNumber(pop) + " of " + FormatNumber(popmax) + ")\\n==========================="`;

const fmtN = (v) => Math.round(v).toLocaleString('en-US');
t('TroopAndResourceTotals (3145T+): account troops, upkeep and resources, summed over both cities', async () => {
  const w = world();
  const r = await runIn(w, TOTALS_NEW);
  const text = printed(r).join('\n');
  assert.match(text, /TOTAL TROOPS:/);
  assert.match(text, new RegExp('^a:' + (TROOPS.archer + 1000) + '$', 'm'), text);
  assert.match(text, /^Upkeep:40,000$/m);
  assert.match(text, new RegExp('^Gold:' + fmtN(5000000 + 100000) + '$', 'm'));
  assert.match(text, new RegExp('^Food:' + fmtN(2000000 + 50000) + '$', 'm'));
  noFailures(r);
});
t('TroopAndResourceTotals (older bots): the same totals through the label loop, with population', async () => {
  const w = world();
  const r = await runIn(w, TOTALS_OLD);
  const text = printed(r).join('\n');
  assert.match(text, /ACCOUNT TOTALS: Found 2 castle\(s\)/);
  assert.match(text, new RegExp('^a:' + (TROOPS.archer + 1000) + '$', 'm'), text);
  assert.match(text, /^\(Upkeep: 40,000\)$/m);
  assert.match(text, new RegExp('^Gold: ' + fmtN(5100000) + '$', 'm'));
  assert.match(text, /^\(Pop: 23,000 of 28,000\)$/m);
  noFailures(r);
});

// ---------------------------------------------------------------------------
section('ScriptExamples: TradeScript (STS v0.10g)');

const STS = `// STS v0.10g - Smart Trading Script (c) 2012-2013 NeatPortal.com
// WARNING: This script requires NEATBOT 2735+ to run
//
// The script tries to gain more resources by using spread between bid and ask prices
// Algorithm is simplified, but should work reasonably well under broad range of conditions
//
// Comment out if you want to disable auto start
label autorun
// uncomment the next line if you are using 2720-2734 build
// MAX_TRADE = 9999999

// ===== OPTIONAL CONFIGURATION PARAMETERS =====
// Extra resources to reserve (in addition to city's reserved resources)
//       food, wood, stone, iron, gold:
extra = [  1m,   1m,    1m,   1m,  100 ]

// How aggressive we want to be (lower number would increase trading gains at the cost of potentially slower trade execution)
aggr = 2%

// Only trade if we expect this much gain
gain = 2%

// ===== NOTHING TO CONFIGURE BELOW THIS LINE =====
delay = 10
config trade:0
comm = 0.5%
maxRes = 990B

label nextres
res = floor(random() * 4) // choose resource to trade randomly, helps with multiple trading running
resName = ResourceIntNames[res]

label check
if city.tradesArray.length > 8 execute "sleep " + delay
if city.tradesArray.length > 8 execute "canceltrade " + city.tradesArray[0].id
if city.tradesArray.length > 8 goto check

label notready
if !m_context.marketReady() goto notready
prices = [ Price(res, aggr), Price(res, 1 - aggr), Price(res, aggr) * (1 + comm), Price(res, 1 - aggr) * comm ]
resGold = city.reservedResource.gold + extra[4] + max(0, city.resource.gold - city.reservedResource.gold - extra[4]) * 0.8
canSell = (city.resource[resName].amount - city.reservedResource[resName] - extra[res]) * 0.8
sellLimit = (city.resource.gold - resGold) / prices[3]
if canSell > 0 if sellLimit >=1 if prices[1] - prices[3] < prices[2] * (1 + gain) goto nextres
if sellLimit < 1 sellLimit = min(max(1, (resGold - city.resource.gold) / prices[1] / 2), (city.resource.gold - 1) / prices[3]) // we are low on gold
sellVolume = floor(min(canSell, sellLimit, MAX_TRADE - max(0, floor(min(maxRes - city.resource[resName].amount, (city.resource.gold - resGold) / prices[2]))) / 3))
if sellVolume > 0 execute "sell " + res + " " + sellVolume + " " + prices[1]
buyVolume = floor(min(maxRes - city.resource[resName].amount, (city.resource.gold - resGold) / prices[2], MAX_TRADE))
if buyVolume > 0 execute "buy " + res + " " + buyVolume + " " + prices[0]
goto nextres`;

async function withRandom(values, f) {
  const orig = Math.random;
  let i = 0;
  Math.random = () => values[Math.min(i++, values.length - 1)];
  try { return await f(); } finally { Math.random = orig; }
}

t('TradeScript: from autorun it turns the trade goal off, then sells 2% under the ask and buys 2% over the bid', async () => {
  const w = world();
  w.market.food = [10, 12];
  const GL = goalLayer();
  const r = await withRandom([0], () => runIn(w, STS, { startLine: 'autorun', goalLayers: GL, session: { account: { id: 'a1' } },
    shouldStop: () => w.of('trade.newTrade').length >= 2 }));
  eq(GL.added, ['config trade:0']);
  const [sell, buy] = w.of('trade.newTrade');
  eq([sell.resType, sell.tradeType, sell.price], [0, 1, '11.96'], r.text);
  eq([buy.resType, buy.tradeType, buy.price], [0, 0, '10.04'], r.text);
  assert.ok(sell.amount > 0 && buy.amount > 0, r.text);
  noFailures(r);
});

// ---------------------------------------------------------------------------
section('AutoRunScript, NewCityScript');

const AUTORUN_ONE = `if city.timeSlot != 0 goto allCities

//put your stuff to perform here only in one city

label allCities

// put your stuff to perform here for all cities`;
const AUTORUN_ITEMS = `label autorun

if city.timeSlot != 0 return

// the following line is for items you want it to use all of until it runs out
// for example promo items you gain from npc farming attacks, amulets, etc.

Settings.autoUseItems(["player.box.whatever", "player.item.whatever", "player.stuff.goes.here", "add.as.many.as.you.like"], [ ])


// the following 2 lines are for adding 5x per day use items, like 50% upkeep buffs

if ItemCount("player.item.chocolatecoin") item = "player.item.chocolatecoin" // 50% upkeep or similar item
if ItemCount("player.item.chocolatecoin") gosub use5items

return

label use5items
numberOfItems = ItemCount(item)
if numberOfItems execute "useitem {item}"
if numberOfItems execute "repeat {min(numberOfItems,5)}"
return`;

t('AutoRunScript: the one-city guard loads and runs in the first city and in another', async () => {
  const w = world();
  noFailures(await runIn(w, AUTORUN_ONE));
  noFailures(await runIn(world(), AUTORUN_ONE, { castle: 'Fla' }));
});
t('AutoRunScript: in the oldest city it uses each chocolate coin held (3 of the 5 a day); Settings.autoUseItems says there is no such list here', async () => {
  const w = world();
  const r = await runIn(w, AUTORUN_ITEMS, { startLine: 'autorun' });
  eq(w.of('shop.useGoods').map((d) => d.itemId), ['player.item.chocolatecoin', 'player.item.chocolatecoin', 'player.item.chocolatecoin']);
  eq(failures(r).length, 1, r.text);
  assert.match(failures(r)[0], /autoUseItems/);
  const other = world();
  const r2 = await runIn(other, AUTORUN_ITEMS, { castle: 'Fla', startLine: 'autorun' });
  eq(other.of('shop.useGoods'), [], 'city.timeSlot is 1 in Fla: the script returns at once');
  noFailures(r2);
});

const NEWCITY = `// DO NOT DELETE!
// This script is called for any new city that was built or captured

// If there is only town hall, try to build 1 cottage
// to make sure city is not abandoned on restart
if city.buildings.length < 2 create cottage

// Set some temporary goals
@get "NewCityGoals.txt"
if $error == null goal $result`;

t('NewCityScript: a city with only its town hall builds a cottage, then NewCityGoals.txt becomes its goals', async () => {
  const w = world({ moreCastles: [] });
  w.g.castles.push({ id: 3, name: 'Newbie', fieldId: F(480, 380), heros: [], troop: {}, resource: res(), buildings: [B(31, -1, 1)], fields: [], buffs: [], trades: [] });
  fs.writeFileSync(path.join(process.env.EVONY_SCRIPTS_DIR, 'NewCityGoals.txt'), 'config hero:1\nbuild c:4:1\n');
  const GL = goalLayer();
  const r = await runIn(w, NEWCITY, { castle: 'Newbie', goalLayers: GL, session: { account: { id: 'a1' } } });
  eq(w.of('castle.newBuilding').map((d) => [d.castleId, d.buildingType]), [[3, 1]]);
  eq(GL.added, ['config hero:1', 'build c:4:1']);
  noFailures(r);
  fs.unlinkSync(path.join(process.env.EVONY_SCRIPTS_DIR, 'NewCityGoals.txt'));
  // a grown city builds nothing
  const w2 = world();
  const GL2 = goalLayer();
  await runIn(w2, NEWCITY, { goalLayers: GL2, session: { account: { id: 'a1' } } });
  eq(w2.of('castle.newBuilding'), []);
});

// ---------------------------------------------------------------------------
section('Scr1ptingForDummies');

const DUMMIES_TUTORIAL = `// First let's wait till it's 10AM before we check or do anything
1: sleep @:10:00:00

// This line is checking to see if you have 1mil+ scouts and if so goes to label scoutem
2: ifgoto ( city.troop.scouter >= 1m ) scoutem
// If you didn't go to label scoutem, then this next line will run instead
3: goto warnbuddy

// Here is label scoutem, you'll go here if you have 1mil+ scouts
4: label scoutem
5: attack 111,222 any,!Goliath s:100k
6: repeat 8
7: stop

// Here is label warnbuddy, you'll go here if you don't have 1mil+ scouts
8: label warnbuddy
9: whisper Buddy I don't have enough scouts, I'm not sending the attacks!`;

const marchesTo = (w, x, y) => w.of('army.newArmy').filter((d) => d.newArmyBean.targetPoint === F(x, y));
const heroName = (w, id) => (w.home.heros.find((h) => h.id === id) || {}).name;

t('Scr1ptingForDummies: attack 111,222 any,!Goliath s:100k — one march of 100k scouts, never with Goliath', async () => {
  const w = world();
  const r = await runIn(w, 'attack 111,222 any,!Goliath s:100k');
  const m = marchesTo(w, 111, 222);
  eq(m.length, 1, r.text);
  eq(m[0].newArmyBean.troops.scouter, 100000);
  assert.notStrictEqual(heroName(w, m[0].newArmyBean.heroId), 'Goliath');
  noFailures(r);
});
t('Scr1ptingForDummies: + repeat 8 sends it 8 times, each with another hero, none of them Goliath', async () => {
  const w = world();
  const r = await runIn(w, 'attack 111,222 any,!Goliath s:100k\nrepeat 8');
  const m = marchesTo(w, 111, 222);
  eq(m.length, 8, r.text);
  const heroes = m.map((x) => heroName(w, x.newArmyBean.heroId));
  eq(new Set(heroes).size, 8);
  assert.ok(!heroes.includes('Goliath'));
  noFailures(r);
});
t('Scr1ptingForDummies: sleep @:10:00:00, then the attack and its repeat', async () => {
  const w = world();
  const r = await runIn(w, 'sleep @:10:00:00\nattack 111,222 any,!Goliath s:100k\nrepeat 8', { timeScale: 1e-6 });
  eq(marchesTo(w, 111, 222).length, 8, r.text);
  assert.match(r.text, /line 1: sleep @:10:00:00\n {2}until /);
});
t('Scr1ptingForDummies: the whole tutorial — with 1.2m scouts it sends 8 waves and stops; with fewer it whispers Buddy', async () => {
  let w = world();
  let r = await runIn(w, DUMMIES_TUTORIAL, { timeScale: 1e-6 });
  eq(marchesTo(w, 111, 222).length, 8, r.text);
  eq(w.of('common.privateChat'), []);
  assert.match(r.text, /stop — this run cannot be paused and resumed, so the script ends here/);
  w = world();
  w.home.troop.scouter = 999999;
  r = await runIn(w, DUMMIES_TUTORIAL, { timeScale: 1e-6 });
  eq(marchesTo(w, 111, 222).length, 0);
  eq(w.of('common.privateChat'), [{ targetName: 'Buddy', msg: "I don't have enough scouts, I'm not sending the attacks!" }]);
  noFailures(r);
});
t('Scr1ptingForDummies: set target 111,222 then attack %target% any,!Goliath s:100k', async () => {
  const w = world();
  const r = await runIn(w, 'set target 111,222\nattack %target% any,!Goliath s:100k');
  eq(marchesTo(w, 111, 222).length, 1, r.text);
  noFailures(r);
});

// ---------------------------------------------------------------------------
section('Config.sol');

t('Config.sol: Config.server and a parameter the console was given; the password is never shown', async () => {
  const w = world();
  const r = await runIn(w, 'echo Config.server\necho Config.owner\necho "My password that I keep forgetting is {Config.password}!"',
    { session: { account: { id: 'a1', server: 'ss71' } }, config: { owner: 'Bob', password: 'hunter2' } });
  const lines = printed(r);
  eq(lines[0], 'ss71');
  eq(lines[1], 'Bob');
  assert.ok(!/hunter2/.test(r.text), 'the password never reaches a script');
  noFailures(r);
});
t('Config.sol: let the owner attack us, yell for help at anyone else', async () => {
  const src = '...\nif (city.enemyArmies[0].king == Config.owner) return // go back to wherever we were and let our owner attack us\n'
    + 'execute "alliancechat Help! Help! I\'m under attack from someone other than {Config.owner}!!"  // we didn\'t return above, so yell for help\nreturn\n...';
  const body = src.split('\n').filter((l) => l !== '...').join('\n');
  let w = world();
  let r = await runIn(w, body, { castle: 'Fla', config: { owner: 'Bob' } });
  eq(w.of('common.allianceChat').map((d) => d.msg), ["Help! Help! I'm under attack from someone other than Bob!!"]);
  noFailures(r);
  w = world();
  r = await runIn(w, body, { castle: 'Fla', config: { owner: 'BadGuy' } });
  eq(w.of('common.allianceChat'), [], 'the owner may attack');
  noFailures(r);
});

// ---------------------------------------------------------------------------
section('CompleteQuests');

const QUESTS_ADVANCED = `   // define supporting functions
   canScout = CreateFunction("v,i,a","v.canScout")
   addFinishedTargets = CreateFunction("v,i,a","v.finished || targets.push(v.name)")
   checkTargets = CreateFunction("v,i,a","v.targetsArray.toArray().forEach(addFinishedTargets)")

   // check available quests
   completequests /query=available
   quests = $result
   targets = []
   quests.forEach(checkTargets)
   if targets.length > 0 echo "Available targets: " + targets.join("\\n")

   // complete targets
   // ...
   if targets.indexOf("Scout city") >= 0 callfunc scout_city()
   // ...

   end

   function scout_city()
     dist = 10
     castle = CastlesInRectangle(city.x - dist, city.y - dist, city.x + dist, city.y + dist).filter(canScout).sort(city.compareByDistanceToCastle)[0]
     if castle execute "scout {castle.coords}"
     return`;

t('CompleteQuests: every line on the page loads and claims what it names', async () => {
  const lines = ['completequests', 'completequests daily', 'completequests routine', 'completequests title', 'completequests rank',
    'completequests /type="Rebuild"', 'completequests /query="all"', 'completequests /mode=routine', 'completequests routine',
    'completequests /type=rebuild,promotion', 'completequests routine /type=Rebuild,Promotion', 'completequests /mode=routine Rebuild,Promotion',
    'completequests routine Rebuild,Promotion', 'completequests /type="Domain Expansion,Commodity Gathering"',
    'completequests /name="Population Increase"', 'completequests routine /name="Population Increase"', 'completequests /name=farming',
    'completequests /mode=routine /name=farming /type="Commodity Gathering"', 'completequests routine /type="Commodity Gathering" farming',
    'completequests routine "Commodity Gathering" farming', 'completequests office',
    'completequests /type=Promotion /name=Knight,Baronet,Baron,Viscount,Earl,Marquis,Duke,Furstin,Prinzessin',
    'completequests /type=Promotion /name=Lieutenant,Captain,Major,Colonel,General'];
  eq(script.parse(lines.join('\n')).filter((a) => a.cmd === 'error'), []);
  let w = world();
  let r = await runIn(w, 'completequests /name=farming');
  eq(w.of('quest.award').map((d) => d.questId), [121], r.text);
  w = world();
  r = await runIn(w, 'completequests daily');
  eq(w.of('quest.award').map((d) => d.questId), [301], r.text);
  w = world();
  r = await runIn(w, 'completequests title');
  eq(w.of('quest.award').map((d) => d.questId), [111], r.text);
  w = world();
  r = await runIn(w, 'completequests /type=rebuild,promotion');
  eq(w.of('quest.award').map((d) => d.questId).sort(), [101, 111], r.text);
});
t('CompleteQuests: /query=finished /type=Rebuild tells of unclaimed Rebuild quests and claims nothing', async () => {
  const w = world();
  const r = await runIn(w, '   // assuming quests auto-completion is disabled\n   completequests /query=finished /type=Rebuild\n   quests = $result\n'
    + '   if quests.length > 0 echo "We have completed, but unclaimed quests of Rebuild type"');
  eq(printed(r).slice(-1), ['We have completed, but unclaimed quests of Rebuild type'], r.text);
  eq(w.of('quest.award'), []);
  noFailures(r);
});
t('CompleteQuests: /query=available names the open quests, and "Chatting" says hi in alliance chat', async () => {
  const w = world();
  const r = await runIn(w, '   completequests /query=available\n   quests = $result\n   names = quests.map(CreateFunction("v,i,a","v.name"))\n'
    + '   if names.length > 0 echo "Available quests: " + names.join("\\n")\n\n   // complete quests\n   // ...\n'
    + '   if names.indexOf("Chatting") >= 0 alliancechat "hi!"\n   // ...');
  const text = printed(r).join('\n');
  assert.match(text, /^Available quests: /m, r.text);
  assert.match(text, /^Chatting$|Available quests: Chatting/m);
  eq(w.of('common.allianceChat').map((d) => d.msg), ['hi!']);
  noFailures(r);
});
t('CompleteQuests (advanced): the unfinished targets, then scout_city() scouts the nearest castle it may scout', async () => {
  const w = world();
  const r = await runIn(w, QUESTS_ADVANCED);
  const text = printed(r).join('\n');
  assert.match(text, /Available targets: (.|\n)*Scout city/, r.text);
  const scouts = w.of('army.newArmy').filter((d) => d.newArmyBean.missionType === 3);
  eq(scouts.length, 1, r.text);
  const to = C.fieldIdToCoords(scouts[0].newArmyBean.targetPoint);
  eq(`${to.x},${to.y}`, '459,357', 'George1 is the nearest castle not ours');
  noFailures(r);
});

// The echoed lines of a script run in a fresh world (it must not fail).
async function echoes(src, opts = {}) {
  const w = opts.world || world();
  const r = await runIn(w, src, opts);
  if (!opts.allowFailures) noFailures(r);
  return printed(r);
}

// ---------------------------------------------------------------------------
section('CreateFunction');

t('CreateFunction: MyFunction pushes each value into Arr2', async () => {
  eq(await echoes('Arr = [1,2,3,4] //Existing array.\nArr2 = []       //New empty array.\n'
    + 'MyFunction = CreateFunction("currentValue,Index,Array","Arr2.push(currentValue)") //Function to use in .forEach() function.\n'
    + 'Arr.forEach(MyFunction)  //using the MyFunction CreateFunction on the array \'Arr\'.\n'
    + 'echo "the old array is {Arr}, the new array after processing is: {Arr2}" //Echoing the output.'),
  ['the old array is 1,2,3,4, the new array after processing is: 1,2,3,4']);
});
t('CreateFunction: some, filter', async () => {
  const pre = 'lessthan10 = CreateFunction("x,ind,arr", "x < 10")\narr = [ 20, 5, 10, 11, 7, 3.4, 21, 1, 7, 9 ]\n';
  eq(await echoes(pre + 'if arr.some(lessthan10) echo "At least one value is less than 10"'), ['At least one value is less than 10']);
  eq(await echoes(pre + 'result = arr.filter(lessthan10)\necho result'), ['5,7,3.4,1,7,9'], 'the page spaces them out; an array prints as AS3 does');
});
t('CreateFunction: forEach over city.heroes.toArray(), map + forEach adding every city\'s archers, every', async () => {
  const names = world().home.heros.map((h) => h.name).join(',');
  eq(await echoes('a = [ ]\npushname = CreateFunction("obj,ind,arr", "a.push(obj.name)")\ncity.heroes.toArray().forEach(pushname)\necho "Heroes are: " + a'),
    ['Heroes are: ' + names]);
  eq(await echoes('addTotal = CreateFunction("x,ind,arr", "total+=x")\ngetArchers = CreateFunction("city,ind,arr", "city.cityManager.troop.archer")\n\n'
    + 'total = 0\ncities.map(getArchers).forEach(addTotal)\n\necho "Total (idle) archers in all cities is: {total}."'),
  [`Total (idle) archers in all cities is: ${TROOPS.archer + 1000}.`]);
  // the page's limit string has a typo (i:10m:10m): no resource bean, so nothing to lack
  const lines = await echoes('limit = GetResources("f:990b,w:100m,i:10m,s:10m,g:100m")\nhasResource = CreateFunction("city,index,arr", "city.cityManager.hasResource(limit)")\n'
    + 'if !cities.every(hasResource) echo "We are low on resource in at least one city!"');
  eq(lines, ['We are low on resource in at least one city!']);
});

// ---------------------------------------------------------------------------
section('MapFunctions');

t('AllCastles: the castles within 5 miles of MyCity after a rescan, one line each', async () => {
  const w = world();
  const r = await runIn(w, 'distance = 5\nexecute "rescanrec {city.x - distance},{city.y - distance} {city.x + distance},{city.y + distance}"\n'
    + 'castles = AllCastles(GetFieldId(city.x - distance,city.y - distance),GetFieldId(city.x + distance , city.y + distance))\n\n'
    + 'echo "There are {castles.length} cities within {distance} miles of {city.name}({city.coords})." \n\n'
    + 'label next\ninfo = castles.shift()\nif info == null end\n'
    + 'echo  "Coord: {FieldIdToCoords(info.id)}, Username: {info.userName}, Alliance: {info.allianceName}, Prestige: {info.prestige}"\ngoto next');
  const lines = printed(r);
  eq(lines[0], 'There are 6 cities within 5 miles of MyCity(460,355).');
  eq(lines.slice(1).sort(), ['Coord: 455,353, Username: Bob, Alliance: null, Prestige: 4991', 'Coord: 457,353, Username: Fred, Alliance: null, Prestige: 8060',
    'Coord: 457,358, Username: George, Alliance: null, Prestige: 10847', 'Coord: 459,357, Username: George, Alliance: null, Prestige: 10847',
    'Coord: 460,355, Username: YayMe, Alliance: TuffGuys, Prestige: 14517826', 'Coord: 464,360, Username: Harry, Alliance: null, Prestige: 0']);
  assert.ok(w.of('common.mapInfoSimple').length >= 1, 'the rescan read the map');
  noFailures(r);
  const all = await echoes('scanrec 0,0 199,199\ncastles = AllCastles(GetFieldId(0,0),GetFieldId(199,199))\necho castles.length');
  eq(all.slice(-1), ['0'], 'nothing of ours is in Friesland');
});
t('FieldIdToCoords, GetFieldId, FormatDistance, MapDistance: the page\'s numbers', async () => {
  eq(await echoes('fid = 284460\necho FieldIdToCoords(fid)'), ['460,355']);
  eq(await echoes('coords = "460,355"\necho GetFieldId(coords)'), ['284460']);
  eq(await echoes('echo FormatDistance(12345,23456)'), ['90.09 miles']);
  eq(await echoes('targ = "123,456"\ntargetId = GetFieldId(targ)\ndistance = FormatDistance(city.fieldId,targetId)\necho "Distance from {city.coords} to {targ} is {distance}.'),
    ['Distance from 460,355 to 123,456 is 351.80 miles.'], 'the page leaves the quote open; NEAT closed it at the line end');
  eq(await echoes('targX = 123\ntargY = 456\ndistance = round(MapDistance(city.x,city.y,targX,targY),2)\necho "Distance from {city.coords} to {targX},{targY} is {distance} miles."'),
    ['Distance from 460,355 to 123,456 is 351.81 miles.']);
});
t('FindField: the flats within 20 miles with their levels, and the level-10 NPCs nearest first', async () => {
  const lines = await echoes('radius = 20\nexecute "rescanmap {city.coords} {radius}"\nflats = FindField(city.x,city.y,radius,10)\n'
    + 'echo "There are {flats.length} flats around {city.name} ({city.coords})."\n\nlabel checkFlat\nthisFlat = flats.shift()\nif thisFlat == null end\n'
    + 'echo  "Coord: {FieldIdToCoords(thisFlat)} is a level {GetLevel(thisFlat)} flat."\nif flats.length goto checkFlat');
  eq(lines, ['There are 2 flats around MyCity (460,355).', 'Coord: 452,350 is a level 3 flat.', 'Coord: 468,362 is a level 9 flat.']);
  eq(await echoes('list = FindField(city.x,city.y,20,12,10).sort(city.compareByDistanceToCastle)\necho list'), [`${F(450, 365)},${F(470, 340)}`]);
});
t('GetDetailInfo: the cached detail, asked for again until it comes, and json_encode of the bean', async () => {
  const w = world();
  const r = await runIn(w, 'id = GetFieldId(123,234)\ndata = GetDetailInfo(id, false, 30) \nif data == null repeat // repeat above if the map detail info is not available yet\necho data.name\necho data.id');
  eq(printed(r), ['Grassland', String(F(123, 234))]);
  noFailures(r);
  const j = await echoes('id = GetFieldId(123,234)\ndata = GetDetailInfo(id, false, 30) \nif data == null repeat // repeat above if the map detail info is not available yet\necho json_encode(data)');
  const bean = JSON.parse(j[0]);
  eq([bean.id, bean.name, bean.state, bean.canScout], [F(123, 234), 'Grassland', 1, true]);
  noFailures(await runIn(world(), 'id = GetFieldId(123,234)\ndata = GetDetailInfo(id, false, 30) \ndata = GetDetailInfo(id, false, 0, date().getTime() - 30000) // same as the line above'));
});
t('GetFieldName, GetLevel, GetZoneName, StateCoords', async () => {
  eq(await echoes('// get the name of field type 3\necho GetFieldName(3)'), ['Hill']);
  eq(await echoes('echo city.fields[0].type\necho GetFieldName(city.fields[0].type)'), ['1', 'Forest']);
  eq(await echoes('echo "The object on the map at {FieldIdToCoords(1234)} is level {GetLevel(1234)}." //This is a level 1 desert at coords 434,1 on the map'),
    ['The object on the map at 434,1 is level 1.']);
  const zone = await echoes('echo "My city is located in {GetZoneName(city.fieldId)}."');
  assert.match(zone[0], /^My city is located in thuringia\.$/i);
  const w = world();
  const r = await runIn(w, 'echo StateCoords("upper lorraine")  // outputs "0,400 199,599"\necho StateCoords(8)                 // outputs "0,400 199,599"\n\n'
    + 'echo StateCoords("all")             // outputs "0,0 799,799"\n\nstate = "Lombardy"\ncoords = StateCoords(state)         // coords = "200,600 399,799"\n'
    + 'if !coords die "Unknown state name \'{state}\'"\nexecute "scanmap {coords}"          // scanmap 200,600 399,799', { limitMs: 20000 });
  eq(printed(r), ['0,400 199,599', '0,400 199,599', '0,0 799,799']);
  assert.match(r.text, /line 9: scanmap 200,600 399,799/);
  eq(w.of('common.mapInfoSimple').length, 100, 'a state is 10 x 10 blocks');
  noFailures(r);
});

// ---------------------------------------------------------------------------
section('Arrays, Strings, JSON');

t('Arrays: every example prints what the page shows', async () => {
  eq(await echoes('browser = ["Safari", "IE", "FireFox", "Chrome"]\necho browser[0]'), ['Safari']);
  const show = (op) => `myArray = ["a","b","c","d"]\necho "myArray = "+myArray\nreturnVal = myArray.${op}\necho "myArray = "+myArray\necho "returnVal = "+returnVal`;
  eq(await echoes(show('push("e")')), ['myArray = a,b,c,d', 'myArray = a,b,c,d,e', 'returnVal = 5']);
  eq(await echoes(show('pop()')), ['myArray = a,b,c,d', 'myArray = a,b,c', 'returnVal = d']);
  eq(await echoes(show('unshift("_")')), ['myArray = a,b,c,d', 'myArray = _,a,b,c,d', 'returnVal = 5']);
  eq(await echoes(show('shift()')), ['myArray = a,b,c,d', 'myArray = b,c,d', 'returnVal = a']);
  eq(await echoes('boy = ["Luke", "Bob","Jason"]\ngirl = ["Emma", "Katie", "Chiara"]\nuni = ["Jordan","alex","Jessie"]\nnames = uni.concat(girl,boy)\necho names'),
    ['Jordan,alex,Jessie,Emma,Katie,Chiara,Luke,Bob,Jason']);
  eq(await echoes('array = ["b", "a", "d", "c"]\necho array.sort()'), ['a,b,c,d']);
  eq(await echoes('array = ["a", "b", "c", "d"]\necho array.join()'), ['a,b,c,d']);
  eq(await echoes('array = ["google", "yahoo", "DuckDuckGo", "Bing"]\necho array.indexOf("DuckDuckGo")'), ['2']);
  eq(await echoes('array = ["google", "yahoo", "DuckDuckGo", "Bing","DuckDuckGo","google"]\necho array.lastIndexOf("DuckDuckGo")'), ['4']);
  eq(await echoes('count = ["1","2","3","4","5"]\necho count.reverse()'), ['5,4,3,2,1']);
  eq(await echoes('browser = ["Safari", "IE", "FireFox", "Chrome"]\necho browser.splice(2, 2)\necho browser'), ['FireFox,Chrome', 'Safari,IE']);
  eq(await echoes('browsers = ["IE", "Chrome", "FireFox", "Safari", "SeaMonkey"]\nGood = browsers.slice(1, 3)\necho "Good = " + Good'), ['Good = Chrome,FireFox']);
  eq(await echoes('theString = "NEAT Bot"\necho theString.substr(0, 4)'), ['NEAT']);
  eq(await echoes('array = [ {a:1},{b:2} ]\necho array[0].a\necho array[1].b'), ['1', '2']);
  // Multi Dimensional: the page's result lines 2-4 read array[2][n] although its code says array[1][n] twice
  eq(await echoes('array = ["bob",["count",1,2,3],["letters","a","b","c"],"bill"]\necho array[1][0]+" The amount of "+array[2][0]"in this array."\n'
    + 'echo array[1][1]+". "+array[1][1]\necho array[0]+" & "+array[3]+" have been added to the main array also."'),
  ['count The amount of letters in this array.', '1. 1', 'bob & bill have been added to the main array also.']);
});
t('Arrays: length — SearchEnemyCastles(10) and the first enemy (the page runs two lines together)', async () => {
  eq(await echoes('array = SearchEnemyCastles(10)\necho "length: " + array.length + ", id: " + array[0].id + ", CityName: " + array[0].name + ", userName: " + array[0].userName + ", alliance: " + array[0].allianceName + ", prestige: " + array[0].prestige + ", honor: " + array[0].honor'),
    [`length: 1, id: ${F(466, 350)}, CityName: RedKeep, userName: BadGuy, alliance: SomeReds, prestige: 5026954, honor: 3392049`]);
});
t('Strings: every example prints what the page shows', async () => {
  const cases = [
    ['echo CenterPad("This is a test", 25, ".")', '.....This is a test......'],
    ['var="hello"\necho "The 5th letter in the word hello is: " + var.charAt(4)', 'The 5th letter in the word hello is: o'],
    ['var="hello"\necho "The numeric code of the 5th letter in the word hello is: " + var.charCodeAt(4)', 'The numeric code of the 5th letter in the word hello is: 111'],
    ['var="oompa"\nvar2="loompa"\nvar3="dance"\necho var.concat(var2," ",var3)', 'oompaloompa dance'],
    ['echo String.fromCharCode(70)', 'F'],
    ['string = "this is a test string."\necho string.indexOf("test")', '10'],
    ['string = "this is another test string."\necho string.lastIndexOf("test")', '16'],
    ['echo LeftPad("This is a test", 25, ".")', '...........This is a test'],
    ['string = "abc"\necho "def".localeCompare(string)', '3'],
    ['string = "This is just a simple test string."\necho string.match(/is/g)', 'is,is'],
    ['echo RightPad("This is a test", 25, ".")', 'This is a test...........'],
    ['string = "yet another test string"\necho string.replace("test", "dull test")', 'yet another dull test string'],
    ['string = "yet another test string"\necho string.search("another")', '4'],
    ['string = "Hello World!"\necho string.slice(1,5)', 'ello'],
    ['mycoords=city.coords.split(",")\necho "x:" + mycoords[0] + " y:" + mycoords[1]', 'x:460 y:355'],
    ['echo StringRepeat(25, ".")', '.'.repeat(25)],
    ['echo StringRepeat(25, "Test")', 'Test'.repeat(25)],
    ['str = "test1:no1,test2:no2"\no = StringToObject(str,",",":")\necho o.test2', 'no2'],
    ['string = "Hello World!"\necho string.substr(1,4)', 'ello'],
    ['string = "Hello World!"\necho string.substring(1,4)', 'ell'],
    ['string = "tHIs Is a mEssAge."\necho string.toLocaleLowerCase()', 'this is a message.'],
    ['string = "tHIs Is a mEssAge."\necho string.toLocaleUpperCase()', 'THIS IS A MESSAGE.'],
    ['string = "tHIs Is a mEssAge."\necho string.toLowerCase()', 'this is a message.'],
    ['string = "tHIs Is a mEssAge."\necho string.toupperCase()', 'THIS IS A MESSAGE.'],
    ['echo Upper1("testing")', 'Testing'],
    ['string = "this is a message."\necho string.valueOf()', 'this is a message.'],
  ];
  for (const [src, want] of cases) eq(await echoes(src), [want], src);
  eq(await echoes('echo Merge("This is a test", "of the Emergency Broadcast System")\necho Merge("One plus One", "Two", " = ")'),
    ['This is a test of the Emergency Broadcast System', 'One plus One = Two']);
  eq(await echoes('echo StringRepeat(3, "Test ")'), ['Test Test Test ']);
  eq(await echoes('echo FormatMiles(123)\necho FormatMiles(123.4)'), ['123.00 miles', '123.40 miles']);
  eq(await echoes('echo FormatNumber("1234567")\necho FormatNumber("1234567","2")\necho FormatNumber2("1234567")'), ['1,234,567', '1,234,567.00', '1,234,567.00']);
  eq(await echoes('echo FormatPercent("1")\necho FormatPercent("0.25","0")\necho FormatPercent("0.25","2")'), ['100.0%', '25%', '25.00%']);
  const csv = await echoes('who = "Bob"\nwhat = "Cap his city"\nwhen = date()\necho ToCSV(who, what, when)');
  assert.match(csv[0], /^"Bob","Cap his city","\w{3} \w{3} \d{1,2} \d\d:\d\d:\d\d GMT[+-]\d{4} \d{4}"$/);
  eq(await echoes('myVar = "abcdefg"\necho myVar.subStr(3,2)'), ['de'], 'the page\'s own spelling, subStr');
});
t('JSON: objects, their elements in text, and json_encode', async () => {
  eq(await echoes('PlayerDetails = {Owner:"NEAT", Group:1}\necho "Player {PlayerDetails.Owner} is in group {PlayerDetails.Group}"'), ['Player NEAT is in group 1']);
  eq(await echoes('NameOfJSONObject = { ElementName:"Value" }\necho NameOfJSONObject.ElementName'), ['Value']);
  eq(await echoes('JsonObj = {element:"Value"}\necho json_encode(JsonObj)'), ['{"element":"Value"}']);
  eq(await echoes('thejson = {this:"that"}\necho thejson\necho json_encode(thejson)'), ['[object Object]', '{"this":"that"}']);
});

// ---------------------------------------------------------------------------
section('XML');

const XML_URL = 'http://battleXXXXX.evony.com/logfile/20150810/AA/BB/ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ.xml';
const REPORT_XML = '<reportData><scoutReport isAttack="true" isSuccess="true"><scoutInfo>'
  + '<fortifications><fortificationsType typeId="14" count="1000"/><fortificationsType typeId="16" count="250"/></fortifications>'
  + '<troops><troopStrType typeId="7" count="99500"/><troopStrType typeId="4" count="1000"/></troops></scoutInfo></scoutReport>'
  + '<battleReport><lootResource gold="81234" food="512000" wood="0"/></battleReport></reportData>';

t('XML: the four examples load the report, then read its forts, troops and loot', async () => {
  const INFO = require('./script-cmd-info');
  const asked = [];
  INFO.setUrlFetcher(async (url) => { asked.push(url); return REPORT_XML; });
  try {
    const head = `url = "${XML_URL}"\nget url\n`;
    eq(await echoes(head + 'if $error die "Failed to load the xml file {url}."\nreport = xml($result)\necho report.scoutReport.isSuccess'), ['true']);
    eq(await echoes(head + 'if $error die "Failed to load the XML file {url}."\nreport = xml($result)\nforts = GetFortsFromXML(report.scoutReport.scoutInfo.fortifications.fortificationsType)\necho forts'),
      ['tra:1000,at:250']);
    eq(await echoes(head + 'if $error end\nreport = xml($result)\ntroops = GetTroopsFromXML(report.scoutReport.scoutInfo.troops.troopStrType)\necho troops'),
      ['s:1000,a:99500']);
    eq(await echoes('// requires valid report url with "default.html?" removed\n     url = "' + XML_URL + '"\n     get url\n     if $error end\n     report = xml($result)\n'
      + '     res = GetResourcesFromXML(report.battleReport.lootResource)\n     if res echo "Resources: " + res'), ['Resources: f:512000,g:81234']);
    eq(asked, [XML_URL, XML_URL, XML_URL, XML_URL]);
  } finally { INFO.setUrlFetcher(null); }
});

// ---------------------------------------------------------------------------
section('Heroes, getAvailableTroop, GetItem, GetTechLevel');

t('Heroes: isPoliticsHero, expLevels and HeroExperience on the first hero', async () => {
  const lines = await echoes('// name and isPoliticsHero property\nif city.heroes[0].isPoliticsHero echo "Hero {city.heroes[0].name} is a politics hero."\n\n'
    + '// expLevels property\nhero = city.heroes[0]\necho "Hero {hero.name} has {FormatNumber(hero.experience)} experience which is enough to add {hero.expLevels} levels"\n\n'
    + '// HeroExperience function\nhero = city.heroes[0]\nlevel = max(hero.level + 100, 432)\n'
    + 'echo "To reach level {level} hero {hero.name} will need {HeroExperience(level, hero.level, hero.experience)} of additional experience"');
  eq(lines[0], 'Hero Queen is a politics hero.');
  assert.match(lines[1], /^Hero Queen has 4,737,560 experience which is enough to add \d+ levels$/);
  assert.match(lines[2], /^To reach level 432 hero Queen will need \d+ of additional experience$/);
});
t('getAvailableTroop: transports of the city, marching ones included, and those at home', async () => {
  const w = world();
  w.g.player.selfArmys = [{ armyId: 5, direction: 1, missionType: 1, startFieldId: w.home.fieldId, targetFieldId: F(470, 360), reachTime: Date.now() + 60000, troop: { carriage: 400 }, resource: { food: 1000 } }];
  const lines = await echoes('echo "I have a total of {city.getAvailableTroop().carriage} transports assigned to this city."\n'
    + 'echo "Of that {city.getAvailableTroop().carriage} transporters, {city.getAvailableTroop(true).carriage} are currently in the city."', { world: w });
  eq(lines, ['I have a total of 5400 transports assigned to this city.', 'Of that 5400 transporters, 5000 are currently in the city.']);
});
t('GetItem: the ItemBean as JSON, and its count', async () => {
  const j = await echoes('echo json_encode(GetItem("player.box.gambling.3"))');
  const bean = JSON.parse(j[0]);
  eq([bean.id, bean.count], ['player.box.gambling.3', 7]);
  eq(await echoes('item = "player.box.gambling.3"\nitemInfo = GetItem(item)\necho "Item count: {itemInfo.count}"'), ['Item count: 7']);
});
t('GetTechLevel: archery level', async () => {
  eq(await echoes('echo "I have archery level {city.getTechLevel(14)}"'), ['I have archery level 8']);
});

// ---------------------------------------------------------------------------
section('date');

const AS3_DATE = /^\w{3} \w{3} \d{1,2} \d\d:\d\d:\d\d GMT[+-]\d{4} \d{4}$/;
t('date: now and a timestamp print as AS3 dates; 30 s of sleep read as 30 s; the get* methods', async () => {
  const [now] = await echoes('echo date() // returns current time/date in human readable formatted string:');
  assert.match(now, AS3_DATE);
  const [then] = await echoes('echo date(1418253379677) // returns time/date in human readable formatted string for specified timestamp:');
  eq(then, new Date(1418253379677).toString().replace(/^(\w{3}) (\w{3}) (\d\d) (\d{4}) ([\d:]+) (GMT[+-]\d{4}).*$/, (m, d, mo, day, y, t, z) => `${d} ${mo} ${Number(day)} ${t} ${z} ${y}`));
  const r = await withClock((tap) => runIn(world(), 'current = date() // find the time elapsed between script start and script end\nsleep 30 // just adding some time in between...\n'
    + 'elapsed = floor((date() - current) / 1000) // dividing by 1000 because we want seconds not milliseconds\necho "Time passed is " + elapsed +  " seconds."', { tap }));
  eq(printed(r), ['Time passed is 30 seconds.']);
  const parts = await echoes('timestamp = 1418253379677\necho date().getTime() > 0\necho date(timestamp).getMonth() date(timestamp).getDate() date(timestamp).getDay() date(timestamp).getFullYear()\n'
    + 'echo date(timestamp).getHours() >= 0 date(timestamp).getMinutes() date(timestamp).getSeconds()');
  const d = new Date(1418253379677);
  eq(parts, ['true', `${d.getMonth()} ${d.getDate()} ${d.getDay()} ${d.getFullYear()}`, `true ${d.getMinutes()} ${d.getSeconds()}`]);
});

// ---------------------------------------------------------------------------
section('Unsorted (the changelog\'s examples)');

t('Unsorted 2676/2670/2669: CastlesInRectangle by castle id, ResetMap, GetX, GetY, city.x', async () => {
  eq(await echoes('list = CastlesInRectangle(123, 234, 156, 274, false, true) // include NPCs into results, and also use castle id as index\nid = GetFieldId(142, 255)\n'
    + 'castle = list[id] // this works because of 6th parameter in CastlesInRectangle() call set to true\nifgosub castle found // same as "ifgosub castle != null found"\nend\n'
    + 'label found\necho "found " + castle.name\nreturn'), ["found Barbarian's city"]);
  eq(await echoes('x = 460\ny = 355\nradius = 5\nwidth = 10\nheight = 10\na = ResetMap(x,y,radius)       // resets circular area with center at x,y\n'
    + 'a = ResetMap(x,y,width,height) // resets rectangular area with start at x,y\necho a'), ['null']);
  eq(await echoes('x = GetX(city.fieldId) // x-coordinate of the city\nx = city.x // simpler way to do the same\ny = GetY(city.fieldId)\necho x y'), ['460 355']);
});
t('Unsorted 2668/2651: a resource bean prints; arrays, objects, unary operators, date(y, m, d, h, mi)', async () => {
  const w = world();
  w.g.player.selfArmys = [{ armyId: 5, direction: 1, missionType: 1, startFieldId: w.home.fieldId, targetFieldId: F(470, 360), reachTime: Date.now() + 60000, troop: { carriage: 400 }, resource: { food: 1000, wood: 20 } }];
  eq(await echoes('echo city.myArmies[0].resource // outputs human-readable string representing resources carried by first army', { world: w }), ['f:1000,w:20']);
  eq(await echoes('colors = [ "green", "red", "yellow" ]\nfruits = [ "pear", "apple", "banana" ]\necho colors[1] // outputs "red"\necho fruits[0] // outputs "pear"\n'
    + 'str = colors[1] + " " + fruits[1]\necho "I like " + str + "s" // outputs "I like red apples"'), ['red', 'pear', 'I like red apples']);
  const w2 = world();
  await runIn(w2, 'message = { user:"bucks", text:"What\'s wrong with you?" }\nexecute "whisper " + message.user + " " + message.text');
  eq(w2.of('common.privateChat'), [{ targetName: 'bucks', msg: "What's wrong with you?" }]);
  eq(await echoes('a = -2 < 3 // true\nb = !a // false\ntext = "some text"\nxx = !text // false\necho a b xx'), ['true false false']);
  const [local, utc] = await echoes('d = date(2012, 9, 24, 10, 30) // note, months are counted from 0,output below is for EST time zone\necho d.toString() // outputs "Wed Oct 24 10:30:00 GMT-0400 2012"\necho d.toUTCString() // outputs "Wed Oct 24 14:30:00 2012 UTC"');
  assert.match(local, /^Wed Oct 24 10:30:00 GMT[+-]\d{4} 2012$/);
  assert.match(utc, /^Wed Oct 24 \d\d:30:00 2012 UTC$/);
});
t('Unsorted 2650/2644: a troop string\'s food per hour and per minute; a field\'s coordinates three ways', async () => {
  // the page leaves out `label continue` (the line ifgoto jumps to): it goes before the first food line
  eq(await echoes('mytroops = GetTroops("a:30k,b:40k,w:1,p:1,sw:1") // convert troop string to TroopBean object\nifgoto mytroops continue\necho "Error in troop string"\nend\n'
    + 'label continue\necho "Food consumption of " + TroopBeanToString(mytroops, ",") + " is " + mytroops.foodConsumeRate + " per hour"\necho "Food consumption per 1 minute is " + mytroops.foodConsumption(60)'),
  ['Food consumption of w:1,p:1,sw:1,a:30000,b:40000 is 2270016 per hour', `Food consumption per 1 minute is ${2270016 / 60}`]);
  eq(await echoes('field = city.fields[0]\necho "Field 1 is " + field.name + ", coordinates are: " + FieldIdToCoords(field.id) // outputs "Field 1 is Forest, coordinates are: 123,456"\n'
    + 'echo "Field 1 is " + field.name + ", coordinates are: " + GetX(field.id) + "," + GetY(field.id) // same output\necho "Field 1 is " + field.name + ", coordinates are: " + field.coords // same output'),
  ['Field 1 is Forest, coordinates are: 461,356', 'Field 1 is Forest, coordinates are: 461,356', 'Field 1 is Forest, coordinates are: 461,356']);
});
t('Unsorted 2634/2630/2629: NaN, Infinity, <>, math and strings, heroes by reference, a price function as a value', async () => {
  eq(await echoes('a = NaN\nb = a + 2\necho isNaN(b) // outputs "true"'), ['true']);
  eq(await echoes('a = 0\nb = 2 / a // division by zero!\necho isFinite(b) // outputs "false"'), ['false']);
  eq(await echoes('res = RESOURCETYPE_WOOD\necho "Resource type " + res + " is for " + ResourceNames[res]'), ['Resource type 1 is for Wood']);
  eq(await echoes('a = 2\nb = 3\nc = a + b // c is 5 now\nc = c + 1 // c is 6 now\nd = (a + b) (c - 1)\necho a b c d // outputs 2 3 6 25'), ['2 3 6 25']);
  eq(await echoes('text1 = "Hello"\ntext2 = "world"\nresult = text1 + ", " + text2 + "!"\nlen = result.length\necho result // outputs "Hello, world!"\necho len // 13\necho result.indexOf("o") // 4'),
    ['Hello, world!', '13', '4']);
  eq(await echoes('echo 1 <> 2'), ['true']);
  // Example 3 never leaves its loop (the ifgoto sits before the label): stopped at its first failure
  const w = world();
  const r = await runIn(w, 'echo "List of heroes in " + m_city.cityManager.name + ":"\nheroes = m_city.cityManager.heroes\ni = 0\ncount = heroes.length\n'
    + 'ifgoto i>=count done // note, round brackets are optional and spaces between operands are not required\nlabel loop1\ni = i + 1\necho i + ". " + heroes[i].name\ngoto loop1\nlabel done',
  { shouldStop: (out) => out.some((l) => /FAILED/.test(l)) });
  const names = w.home.heros.map((h) => h.name);
  eq(printed(r).slice(0, 3), ['List of heroes in MyCity:', `1. ${names[1]}`, `2. ${names[2]}`]);
  const w4 = world();
  w4.market.food = [4.2, 4.4];
  eq(await echoes('ask = m_context.buyPrice // note, buyPrice is a function!\nres = 0\nlabel resloop\necho "Current " + ResourceNames[res] + " price is " + ask(res)\nres = res + 1', { world: w4 }),
    ['Current Food price is 4.2']);
  const w5 = world();
  await runIn(w5, 'amount = 5m\nprice = 22.5\nexecute "buy food " + amount + " " + price // buy 5m food @ 22.5');
  eq(w5.of('trade.newTrade').map((d) => [d.resType, d.tradeType, d.amount, d.price]), [[0, 0, 5000000, '22.5']]);
});
t('Unsorted 2631: SearchEnemyCastles with the old fieldIdToCompareString, and GetDetailInfo until it comes', async () => {
  eq(await echoes('enemies = SearchEnemyCastles(10)\ni = 0\nlabel loop1\nifgoto i >= enemies.length exit\ncastle = enemies[i]\ni = i + 1\n'
    + 'echo "Enemy " + i + ":" fieldIdToCompareString(castle.id) castle.name castle.userName castle.allianceName castle.prestige castle.honor\ngoto loop1\nlabel exit'),
  ['Enemy 1: 466,350 RedKeep BadGuy SomeReds 5026954 3392049']);
  eq(await echoes('x = 123\ny = 456\nid = GetFieldId(x,y)\nlabel notyet\ncastle = GetDetailInfo(id, true)\nifgoto castle == null notyet\n'
    + 'echo "lord=" + castle.userName "alliance=" + castle.allianceName "R=" + castle.relation'), ['lord=null alliance=null R=6']);
});
t('Unsorted 2607/2603/2600/2595: buffs (by bare name too), truce, marketReady, the main city, comforting needs, PRFactor, IsHeroInCastle with a bare hero string', async () => {
  const w = world();
  w.g.player.buffs = [{ typeId: 'StopTroopsUpkeepBuff', endTime: Date.now() + 3600000, descName: 'No food for your troops will be consumed under this status.' }];
  w.home.buffs = [{ typeId: 'ForceopenclosegateBuff', endTime: Date.now() + 3600000, descName: 'Gates forced open' }];
  const r = await runIn(w, 'XXX = "StopTroopsUpkeepBuff"\nm_city.cityManager.hasBuff(XXX) // true if city has buff XXX applied\nm_context.hasBuff(XXX) // true if we have buff XXX applied\n'
    + 'm_context.buff(XXX) // returns BuffBean object or null if buff XXX is not applied\nm_city.cityManager.buff(XXX) // returns BuffBean object or null if buff XXX is not applied\n'
    + 'ifgoto ( m_city.cityManager.hasBuff(ForceopenclosegateBuff ) == true ) gatesforced\necho "no"\nend\nlabel gatesforced\necho "gates forced"\n'
    + 'echo m_context.buff(StopTroopsUpkeepBuff).descName\necho m_context.truced m_context.inTruceCooldown\necho m_context.marketReady() m_context.findFirstCity().name\n'
    + 'echo m_city.cityManager.comfortingNeeds(1).needAmount >= 0 m_city.cityManager.comfortingNeeds(2).needAmount >= 0\necho m_city.cityManager.PRFactor >= 0\n'
    + 'ifgoto ( m_city.IsHeroInCastle(any:att>200) == true ) found\necho "none"\nend\nlabel found\necho "a hero with attack over 200 is home"');
  eq(printed(r), ['gates forced', 'No food for your troops will be consumed under this status.', 'false false', 'true MyCity', 'true true', 'true',
    'a hero with attack over 200 is home']);
  noFailures(r);
});

// ---------------------------------------------------------------------------
section('the command pages\' example scripts (Repeat, Loop, Gosub, Call, Command, callScript, SetFocus)');

t('Repeat / Loop: bare upgrade + repeat takes every building and field to level 9, the lowest first, then ends', async () => {
  const w = world({ buildings: [B(31, -1, 10), B(1, 12, 7), B(1, 13, 8), B(7, 1001, 6), B(2, 11, 9)] });
  const r = await runIn(w, '//================================\n// Upgrade all of your buildings\n// and resource fields to level 9:\n//================================\nupgrade\nrepeat');
  eq(w.home.buildings.map((b) => [b.typeId, b.level]), [[31, 10], [1, 9], [1, 9], [7, 9], [2, 9]]);
  eq(w.of('castle.upgradeBuilding').map((d) => d.positionId), [1001, 12, 1001, 12, 13, 1001], 'the lowest level first, the lower plot on a tie');
  assert.match(r.text, /repeat ends — line 5 did not go through/);
  assert.match(r.text, /every building in MyCity is at level 9 or higher/);
});
t('Loop: upgrade farm / upgrade saw / upgrade iron / loop 5 runs the three lines five times in all', async () => {
  const w = world({ buildings: [B(31, -1, 10), B(7, 1001, 1), B(4, 1002, 1), B(6, 1003, 1)] });
  const r = await runIn(w, '      upgrade farm\n      upgrade saw\n      upgrade iron\n      loop 5');
  eq(w.home.buildings.slice(1).map((b) => b.level), [6, 6, 6], r.text);
  noFailures(r);
});
t('Gosub: medal farm, train, two cottage upgrades, a sleep, then loop 0 again (stopped on the second round)', async () => {
  const w = world({ rich: true });
  const r = await runIn(w, 'gosub medalfarm\ngosub trainarch\ngosub upgradecot\nsleep 30\nloop 0\nlabel medalfarm\nattack 123,300 !Bubba,!Xavier,any t:400,b:400\n'
    + 'return\nlabel upgradecot\nupgrade house\nrepeat 2\nreturn\nlabel trainarch\ntrain arch:2500 Hero\nreturn',
  { shouldStop: (out) => out.filter((l) => /^line 7: attack/.test(l)).length >= 2 });
  const [first] = w.of('army.newArmy');
  eq(first.newArmyBean.targetPoint, F(123, 300));
  assert.ok(!['Bubba', 'Xavier'].includes(heroName(w, first.newArmyBean.heroId)));
  eq(w.of('troop.produceTroop').map((d) => [d.troopType, d.num]).slice(0, 1), [[C.BY_KEY.archer.typeId, 2500]], r.text);
  eq(w.of('castle.upgradeBuilding').length, 2, 'upgrade house, repeat 2: twice');
  noFailures(r);
});
t('Call: label autorun / call "UseItems.txt" runs the file, which opens every gambling box it finds', async () => {
  const USE_ITEMS = `// Use Items Script!
// By KINGTECH, I think
item = "player.box.gambling.3"
gosub useitems
item = "player.item.giftofthewisemystics"
gosub useitems
item = "player.item.sinterklaasscookies"
gosub use5items
goto EOS
label useitems
numberOfItems = m_context.ItemCount(item)
echo "I have "+numberOfItems+" "+item
if numberOfItems execute "useitem " + item
if numberOfItems execute "repeat " + numberOfItems
return
label use5items
numberOfItems = m_context.ItemCount(item)
echo "I have "+numberOfItems+" "+item
if numberOfItems execute "useitem " + item
if numberOfItems execute "repeat " + min(numberOfItems,5)
return
/// End Of Script
label EOS
echo "All done!"`;
  const w = world();
  const r = await runIn(w, 'label autorun\ncall "UseItems.txt"', { loadScript: (name) => (name === 'UseItems.txt' ? USE_ITEMS : null) });
  eq(w.of('shop.useGoods').map((d) => d.itemId), Array(7).fill('player.box.gambling.3'));
  eq(printed(r), ['I have 7 player.box.gambling.3', 'I have 0 player.item.giftofthewisemystics', 'I have 0 player.item.sinterklaasscookies', 'All done!']);
  noFailures(r);
});
t('Command: who SomeDude, quickarmyreport into $result, and jay777\'s finder attacks the one-city, no-population lords around', async () => {
  let w = world();
  let r = await runIn(w, 'var = "SomeDude"\ncommand "who " + var\necho $result');
  assert.match(printed(r).join('\n'), /SomeDude/);
  w = world();
  r = await runIn(w, 'command "quickarmyreport"\necho $result');
  assert.match(printed(r).join('\n'), /\[42666\]/);
  w = world();
  r = await runIn(w, `distance = 20
troops = 'c:1k,s:1k'
heroes = 'any:level<200'
//------------------------------
// NO USER ENTRY BELOW
//------------------------------
execute "scanrec "+(city.x-distance)+","+(city.y-distance)+" "+(city.x+distance)+","+(city.y+distance)
castles = AllCastles(GetFieldId(city.x - distance, city.y - distance), GetFieldId(city.x + distance, city.y + distance))
i=0
label next
@command "who " + castles[i].userName
if $error goto next
if $result.split(',')[2].split(" ")[2] = 1 if $result.split(',')[8].split(" ")[2] = 0 echo "Found " + castles[i].userName + " at " + FieldIdToCoords(castles[i].id)
if $result.split(',')[2].split(" ")[2] = 1 if $result.split(',')[8].split(" ")[2] = 0 execute "attack " + FieldIdToCoords(castles[i].id) + " " + heroes + " " + troops
i = i + 1
if i < castles.length goto next
echo "All done"`);
  eq(printed(r).filter((l) => /^Found/.test(l)).sort(), ['Found Bob at 455,353', 'Found Harry at 464,360']);
  eq(w.of('army.newArmy').map((d) => C.fieldIdToCoords(d.newArmyBean.targetPoint)).map((p) => `${p.x},${p.y}`).sort(), ['455,353', '464,360']);
  eq(printed(r).slice(-1), ['All done']);
  noFailures(r);
});
t('callScript: from Fla, cities[0] (MyCity) is asked to run echo \'bob\'; not in its own city; without the console it says why', async () => {
  const asked = [];
  let r = await runIn(world(), 'x = 0\nDummy = cities[x].cityManager.script.callScript("echo \'bob\'")\necho Dummy',
    { castle: 'Fla', runInCity: (id, text) => { asked.push([id, text]); return { ok: true }; } });
  eq(asked, [[1, "echo 'bob'"]]);
  eq(printed(r), ['null']);
  noFailures(r);
  r = await runIn(world(), 'x = 0\nDummy = cities[x].cityManager.script.callScript("echo \'bob\'")', { runInCity: () => ({ ok: true }) });
  assert.match(failures(r)[0], /MyCity is the city this script runs in/);
  r = await runIn(world(), 'Dummy = cities[1].cityManager.script.callScript("levy 1 \\n echo city.resource.support")');
  assert.match(failures(r)[0], /only the console can start a script in another city/);
});
t('SetFocus: setfocus and setfocus 5 load and do nothing (every city gets every tick)', async () => {
  const w = world();
  const r = await runIn(w, 'setfocus\nsetfocus 5\nkeep($error)');
  eq(r.kept, [null]);
  assert.match(r.text, /nothing to do — the goals visit every city every tick/);
  eq(w.sent.filter((s) => !/getTroopParam/.test(s.cmd)), []);
});

// ---------------------------------------------------------------------------
section('what the VM does for these examples');

t('a repeat under an if reads the if again each round: bare, counted, and nested ifs', async () => {
  const w = world();
  // bare: stops as soon as the condition fails (it used to run the line forever)
  let r = await runIn(w, 'n = 0\nn = n + 1\nif n < 5 repeat\necho n');
  eq(printed(r), ['5']);
  // counted: at most N in all, fewer when the if stops holding
  r = await runIn(world(), 'n = 0\nn = n + 1\nif n < 3 repeat 10\necho n');
  eq(printed(r), ['3']);
  r = await runIn(world(), 'n = 0\nok = 1\nn = n + 1\nif ok if n < 4 repeat\necho n');
  eq(printed(r), ['4']);
  // no if: repeat N keeps its meaning (N runs in all)
  r = await runIn(world(), 'n = 0\nn = n + 1\nrepeat 7\necho n');
  eq(printed(r), ['7']);
});
t('run()\'s trace(line, top) hook sees each statement as it starts, and a called script\'s as not top', async () => {
  const seen = [];
  const w = world();
  await runIn(w, 'a = 1\nif a goto x\necho "no"\nlabel x\ncall "other"\necho a', {
    loadScript: () => 'b = 2\necho b', trace: (line, top) => seen.push(`${line}${top ? '' : '*'}`) });
  eq(seen, ['1', '2', '4', '5', '1*', '2*', '6']);
});
t('timeScale: a wait scaled under a millisecond still lets the server\'s pushes land (upgrade waits for its building)', async () => {
  const w = world({ jobMs: 20 });
  const r = await runIn(w, 'upgrade cottage\nkeep($error)', { timeScale: 1e-9, limitMs: 3000 });
  eq(r.kept, [null], r.text);
  assert.ok(!r.timedOut, 'it did not spin until the time limit');
  eq(w.home.buildings.find((b) => b.positionId === 14).level, 4);
});

// ---------------------------------------------------------------------------
section('the copies are the wiki\'s own text');

// With NEAT_WIKI_DIR set to a folder of the wiki's pages (<Page>.txt, MoinMoin
// source), every script above must appear on its page word for word (spaces
// at line ends and between lines aside). Without it the check is skipped.
t('every embedded example is on its wiki page, word for word (NEAT_WIKI_DIR)', () => {
  const dir = process.env.NEAT_WIKI_DIR;
  if (!dir) { console.log('        (skipped: set NEAT_WIKI_DIR to check the copies against the wiki)'); return; }
  const norm = (s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');
  const pages = [['AbandonAllValleys', ABANDON_ONE], ['AbandonAllValleys', ABANDON_ALL], ['AutoTeleporter', AUTO_TELEPORTER], ['MonitorCity', MONITOR_CITY],
    ['PeacetimeStatusChecker', PEACETIME], ['PromoAddFriend', PROMO], ['PromoAddFriend', PROMO_CLEAR], ['SortingMemberList', SORTING],
    ['Travelinfo_lower', TRAVELINFO_VARS], ['TroopAndResourceTotals', TOTALS_NEW], ['TroopAndResourceTotals', TOTALS_OLD], ['TradeScript', STS],
    ['AutoRunScript', AUTORUN_ONE], ['AutoRunScript', AUTORUN_ITEMS], ['NewCityScript', NEWCITY], ['Scr1ptingForDummies', DUMMIES_TUTORIAL],
    ['CompleteQuests', QUESTS_ADVANCED]];
  for (const [page, text] of pages) {
    const src = norm(fs.readFileSync(path.join(dir, page + '.txt'), 'utf8'));
    assert.ok(src.includes(norm(text)), `${page}: the copy differs from the page`);
  }
});

// ---------------------------------------------------------------------------
// The fake world, for the phase-3 matrix runner (require()d, the tests do not run).
module.exports = { world, runIn, goalLayer, printed, failures, withClock, QUICK, MAP, mapSource, REPORT_XML, XML_URL };

if (require.main === module) (async () => {
  let pass = 0, fail = 0;
  const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
  for (const [name, f] of tests) {
    if (!f) { if (!only) console.log(`\n${name}\n`); continue; }
    if (only && !only.test(name)) continue;
    try { await f(); pass++; console.log(`  ok    ${name}`); } catch (e) {
      fail++;
      console.log(`  FAIL  ${name}\n        ${String(e && e.stack || e).split('\n').slice(0, 14).join('\n        ')}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
